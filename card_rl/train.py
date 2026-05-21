from __future__ import annotations

import argparse
import os
import random
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from copy import deepcopy
from multiprocessing import get_context
from pathlib import Path
from typing import Dict, List

from .evaluate import _evaluate_policy
from .evaluate import ROLE_BALANCE_ACTIVITY_FLOORS, _choose_role_balance_schedule, _evaluate_role_balance_policy, maker_markout_floor
from .export_policy import export_js_module
from .features import base_feature_vector
from .heuristic import (
    BASELINE_BALANCED,
    BASELINE_MAKER_PUBLIC_MID,
    BASELINE_MAKER_PUBLIC_SKEW,
    BASELINE_TAKER_BEST_EDGE,
    BASELINE_WAIT,
    decision_for_baseline,
    heuristic_decision,
    quote_toxicity,
)
from .model import _intent_index_for_decision, bootstrap_hybrid_as_policy, bootstrap_neural_policy, bootstrap_policy, policy_from_dict
from .simulator import CardMarketSimulator, IncentiveSchedule

TEACHER_PROFILE_POOL = [
    BASELINE_BALANCED,
    BASELINE_BALANCED,
    BASELINE_BALANCED,
    BASELINE_BALANCED,
    BASELINE_MAKER_PUBLIC_SKEW,
    BASELINE_TAKER_BEST_EDGE,
    BASELINE_TAKER_BEST_EDGE,
    BASELINE_MAKER_PUBLIC_MID,
]

TRAINING_SEAT_COUNTS = [2, 4, 4, 6, 6, 8, 8, 10, 10, 10]
GATE_SEAT_COUNTS = [4, 6, 8, 10]
GATE_SEAT_WEIGHTS = {4: 1.0, 6: 1.2, 8: 1.5, 10: 1.8}
TRAINING_INCENTIVE_SCHEDULE = IncentiveSchedule().to_dict()
ADVERSARIAL_CURRICULUM = False
CONSERVATIVE_PENALTY = 0.0


def _format_duration(seconds: float) -> str:
    total_seconds = max(0, int(round(seconds)))
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    if hours:
        return f"{hours}h {minutes}m {secs}s"
    if minutes:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


class ProgressBar:
    def __init__(self, label: str, total: int, width: int = 28) -> None:
        self.label = label
        self.total = max(1, int(total))
        self.width = width
        self.started_at = time.perf_counter()
        self.last_render_at = 0.0
        self.last_line_length = 0

    def update(self, completed: int, detail: str = "", force: bool = False) -> None:
        now = time.perf_counter()
        if not force and completed < self.total and now - self.last_render_at < 0.08:
            return
        self.last_render_at = now
        completed = max(0, min(int(completed), self.total))
        ratio = completed / self.total
        filled = min(self.width, int(self.width * ratio))
        bar = "#" * filled + "-" * (self.width - filled)
        elapsed = now - self.started_at
        rate = completed / elapsed if elapsed > 0 else 0.0
        remaining = (self.total - completed) / rate if rate > 0 else 0.0
        line = (
            f"{self.label:<12} [{bar}] {ratio * 100:5.1f}% "
            f"{completed}/{self.total} | {rate:6.1f}/s | elapsed {_format_duration(elapsed)}"
        )
        if completed < self.total:
            line += f" | eta {_format_duration(remaining)}"
        if detail:
            line += f" | {detail}"
        padded = line.ljust(self.last_line_length)
        self.last_line_length = max(self.last_line_length, len(line))
        print(f"\r{padded}", end="", flush=True)

    def finish(self, detail: str = "") -> None:
        self.update(self.total, detail=detail, force=True)
        print("", flush=True)


class NullProgressBar:
    def update(self, completed: int, detail: str = "", force: bool = False) -> None:
        return

    def finish(self, detail: str = "") -> None:
        return


def default_worker_count() -> int:
    return max(1, int(os.cpu_count() or 1))


def _episode_seed(base_seed: int, episode_index: int) -> int:
    return int(base_seed) * 1_000_003 + int(episode_index) * 97


def _chunk_counts(total: int, parts: int) -> List[int]:
    if total <= 0:
        return []
    parts = max(1, min(parts, total))
    base = total // parts
    remainder = total % parts
    return [base + (1 if index < remainder else 0) for index in range(parts)]


def _episode_batch_size(total_episodes: int, workers: int, cap: int = 64) -> int:
    return max(1, min(cap, max(1, total_episodes // max(1, workers * 8))))


def _max_inflight_jobs(workers: int) -> int:
    return max(1, workers * 2)


def _split_worker_budget(total_workers: int, task_count: int) -> List[int]:
    return [max(1, int(value)) for value in _chunk_counts(max(1, total_workers), max(1, task_count))]


def _normalized_step_size(base_lr: float, count: int) -> float:
    return float(base_lr) / max(1, int(count))


def _open_parallel_executor(workers: int):
    if workers <= 1:
        return None, "sequential"
    try:
        mp_context = get_context("spawn")
        return ProcessPoolExecutor(max_workers=workers, mp_context=mp_context), "process"
    except (OSError, PermissionError):
        return ThreadPoolExecutor(max_workers=workers), "thread"


def _reveal_possible(state: Dict, player_id: str) -> bool:
    return player_id not in state["reveal_votes"] and state["revealed_board_count"] < len(state["board_cards"])


def _sample_teacher_profile(rng: random.Random) -> str:
    return rng.choice(TEACHER_PROFILE_POOL)


def _best_teacher_take(base_state: Dict) -> Dict | None:
    best = None
    for entry in base_state["quotes"]:
        buy_edge = (base_state["stats"]["mean"] - float(entry["quote"]["ask"])) / base_state["stats"]["width"]
        sell_edge = (float(entry["quote"]["bid"]) - base_state["stats"]["mean"]) / base_state["stats"]["width"]
        edge = max(buy_edge, sell_edge)
        action = "buy" if buy_edge >= sell_edge else "sell"
        if best is None or edge > best["edge"]:
            best = {
                "targetPlayerId": entry["target_player_id"],
                "action": action,
                "edge": edge,
            }
    return best


def _training_context(base_state: Dict, state: Dict, player_id: str) -> Dict[str, float | bool]:
    best_take_edge = max(float(base_state["values"][6]), float(base_state["values"][7]))
    return {
        "best_take_edge": best_take_edge,
        "stdev": float(base_state["values"][1]),
        "inventory": float(base_state["values"][2]),
        "reveal_progress": float(base_state["values"][3]),
        "seat_ratio": float(base_state["values"][4]),
        "live_quote_count": float(base_state["values"][5]),
        "best_quote_age": float(base_state["values"][22]),
        "has_own_quote": bool(base_state["own_quote"]),
        "reveal_possible": _reveal_possible(state, player_id),
        "mid_round": bool(int(state["step"]) >= 1 or int(state["revealed_board_count"]) >= 2),
        "step_ratio": min(1.0, max(0.0, float(state["step"]) / 18.0)),
    }


def _selected_take_edge(take: Dict) -> float:
    action_index = int(take.get("action_index", 0))
    if action_index <= 0:
        return 0.0
    entry = take["entries"][action_index - 1]
    base = take["base"]
    buy_edge = (base["stats"]["mean"] - float(entry["quote"]["ask"])) / base["stats"]["width"]
    sell_edge = (float(entry["quote"]["bid"]) - base["stats"]["mean"]) / base["stats"]["width"]
    return max(float(buy_edge), float(sell_edge))


def _merge_training_stats(target: Dict[str, int], source: Dict[str, int]) -> None:
    for key, value in source.items():
        target[key] = target.get(key, 0) + int(value)


def _policy_profile(policy) -> Dict[str, float]:
    if getattr(policy, "model_type", "") == "neural_mlp":
        return {
            "intent_bc_take": 2.7,
            "intent_bc_quote": 1.1,
            "intent_bc_reveal": 0.45,
            "intent_bc_wait": 0.12,
            "quote_bc": 0.9,
            "take_bc": 0.82,
            "reveal_bc": 0.35,
            "intent_advantage_scale": 0.16,
            "quote_advantage_scale": 0.08,
            "take_advantage_scale": 0.12,
            "reveal_advantage_scale": 0.02,
            "risk_penalty_scale": 0.26,
            "missed_take_penalty_scale": 0.34,
            "aligned_take_penalty_scale": 0.2,
            "maker_markout_penalty_scale": 0.42,
            "taker_markout_bonus_scale": 0.18,
            "taker_markout_penalty_scale": 0.22,
        }
    return {
        "intent_bc_take": 4.2,
        "intent_bc_quote": 2.3,
        "intent_bc_reveal": 0.35,
        "intent_bc_wait": 0.06,
        "quote_bc": 1.45,
        "take_bc": 1.22,
        "reveal_bc": 0.2,
        "intent_advantage_scale": 0.32,
        "quote_advantage_scale": 0.2,
        "take_advantage_scale": 0.19,
        "reveal_advantage_scale": 0.015,
        "risk_penalty_scale": 0.08,
        "missed_take_penalty_scale": 0.5,
        "aligned_take_penalty_scale": 0.12,
        "maker_markout_penalty_scale": 0.28,
        "taker_markout_bonus_scale": 0.14,
        "taker_markout_penalty_scale": 0.16,
    }


def _family_learning_rates(family: str) -> Dict[str, float]:
    if family == "neural":
        return {
            "bc_lr": 0.010,
            "ppo_lr": 0.004,
        }
    return {
        "bc_lr": 0.014,
        "ppo_lr": 0.008,
    }


def _intent_bc_weight(decision: Dict, context: Dict[str, float | bool], profile: Dict[str, float]) -> float:
    edge = float(context["best_take_edge"])
    seat_ratio = float(context["seat_ratio"])
    if decision["type"] == "taker_action":
        return profile["intent_bc_take"] + max(0.0, edge) * 3.1 + seat_ratio * 1.0
    if decision["type"] == "submit_quote":
        return profile["intent_bc_quote"] + float(context["stdev"]) * 0.45 + (0.55 if not bool(context["has_own_quote"]) else 0.0)
    if decision["type"] == "request_next_reveal":
        return profile["intent_bc_reveal"]
    return profile["intent_bc_wait"]


def _quote_bc_weight(decision: Dict, context: Dict[str, float | bool], profile: Dict[str, float]) -> float:
    if decision["type"] == "submit_quote" and decision.get("payload"):
        base_weight = profile["quote_bc"] + float(context["stdev"]) * 0.45
        if not bool(context["has_own_quote"]) and float(context["live_quote_count"]) <= 0.125:
            base_weight += 0.65
        return base_weight
    if float(context["best_take_edge"]) > 0.04:
        return 0.02
    if not bool(context["has_own_quote"]) and float(context["live_quote_count"]) <= 0.125:
        return 0.04
    return 0.08


def _take_bc_weight(decision: Dict, context: Dict[str, float | bool], entries: List[Dict], profile: Dict[str, float]) -> float:
    if not entries and decision["type"] != "taker_action":
        return 0.0
    edge = float(context["best_take_edge"])
    seat_ratio = float(context["seat_ratio"])
    if decision["type"] == "taker_action":
        quote_age = float(context["best_quote_age"])
        stale_bonus = 0.25 if quote_age >= 0.8 else 0.0
        return profile["take_bc"] * (
            2.2 + max(0.0, edge - 0.015) * 2.0 + stale_bonus + seat_ratio * 0.5 + (0.35 if bool(context["mid_round"]) else 0.0)
        )
    if edge > 0.03:
        return 0.0
    return 0.06


def _reveal_bc_weight(decision: Dict, context: Dict[str, float | bool], profile: Dict[str, float]) -> float:
    reveal_possible = bool(context["reveal_possible"])
    if not reveal_possible and decision["type"] != "request_next_reveal":
        return 0.0
    if decision["type"] == "request_next_reveal":
        return profile["reveal_bc"]
    return 0.04


def _quote_bonus(action_index: int, noop_index: int, context: Dict[str, float | bool]) -> float:
    stdev = float(context["stdev"])
    live_quote_count = float(context["live_quote_count"])
    has_own_quote = bool(context["has_own_quote"])
    inventory = abs(float(context["inventory"]))
    take_edge = float(context["best_take_edge"])
    if action_index == noop_index:
        if not has_own_quote and live_quote_count <= 0.125:
            return -0.16 - stdev * 0.25
        return -0.03 if live_quote_count <= 0.25 else 0.0
    urgency = max(0.0, 0.35 - live_quote_count)
    return 0.08 + stdev * 0.18 + urgency * 0.2 - inventory * 0.03 - max(0.0, take_edge - 0.03) * 0.45


def _take_bonus(action_index: int, context: Dict[str, float | bool], selected_edge: float) -> float:
    edge = float(context["best_take_edge"])
    mid_round = bool(context["mid_round"])
    seat_ratio = float(context["seat_ratio"])
    quote_age = float(context["best_quote_age"])
    required_edge = max(0.01, 0.02 + seat_ratio * 0.01 - quote_age * 0.01)
    edge_surplus = max(0.0, edge - required_edge)
    selected_surplus = max(0.0, selected_edge - required_edge)
    if action_index == 0:
        if edge > required_edge:
            return -0.22 - edge_surplus * 2.0 - seat_ratio * 0.1 - quote_age * 0.04 - (0.08 if mid_round else 0.0)
        return -0.04 if mid_round and float(context["live_quote_count"]) > 0.125 else 0.02
    return (
        0.08
        + selected_surplus * 1.85
        - max(0.0, -selected_edge) * 1.8
        + quote_age * 0.06
        + (0.05 if mid_round else 0.0)
    )


def _reveal_bonus(vote: bool, context: Dict[str, float | bool]) -> float:
    reveal_possible = bool(context["reveal_possible"])
    if not reveal_possible:
        return 0.0
    reveal_progress = float(context["reveal_progress"])
    stdev = float(context["stdev"])
    live_quote_count = float(context["live_quote_count"])
    should_reveal = stdev <= 0.1 or live_quote_count <= 0.05 or reveal_progress >= 0.7
    if vote:
        return 0.08 if should_reveal else -0.04
    return -0.06 if should_reveal else 0.01


def _teacher_decision(state: Dict, player_id: str, now_step: int, rng: random.Random, profile: str) -> Dict:
    return decision_for_baseline(profile, state, player_id, now_step)


def _accumulate_bc_example(
    policy,
    gradients: Dict,
    stats: Dict[str, int],
    *,
    state: Dict,
    player_id: str,
    decision: Dict,
    now_step: int,
) -> None:
    base = base_feature_vector(state, player_id, now_step)
    context = _training_context(base, state, player_id)
    profile = _policy_profile(policy)
    noop_index = next(index for index, template in enumerate(policy.quote_templates) if template["id"] == "noop")
    sampled = policy.choose_action(state, player_id, now_step)
    intent_weight = _intent_bc_weight(decision, context, profile)
    intent_action_index = _intent_index_for_decision(decision["type"])
    if intent_weight > 0.0:
        policy.accumulate_intent_gradient(
            gradients,
            sampled["intent"]["features"],
            sampled["intent"]["probabilities"],
            intent_action_index,
            intent_weight,
        )

    quote_sampled = sampled["quote"]
    quote_action_index = noop_index
    if decision["type"] == "submit_quote" and decision.get("payload"):
        template_id = decision.get("templateId") or "mid_00_100_1"
        quote_action_index = next(
            (index for index, template in enumerate(policy.quote_templates) if template["id"] == template_id),
            noop_index,
        )
    quote_weight = _quote_bc_weight(decision, context, profile)
    if quote_weight > 0.0:
        policy.accumulate_quote_gradient(
            gradients,
            quote_sampled["features"],
            quote_sampled["probabilities"],
            quote_action_index,
            quote_weight,
        )
    if quote_weight > 0.0 and quote_action_index != noop_index:
        stats["quote"] += 1

    take_sampled = sampled["take"]
    take_action_index = 0
    if decision["type"] == "taker_action":
        target_player_id = decision["payload"].get("targetPlayerId")
        take_action_index = next(
            (
                index + 1
                for index, entry in enumerate(take_sampled["entries"])
                if entry["target_player_id"] == target_player_id
            ),
            0,
        )
    take_weight = _take_bc_weight(decision, context, take_sampled["entries"], profile)
    if take_weight > 0.0:
        policy.accumulate_take_gradient(
            gradients,
            take_sampled["features"],
            take_sampled["probabilities"],
            take_action_index,
            take_weight,
        )
    if take_weight > 0.0 and take_action_index != 0:
        stats["take"] += 1

    reveal_sampled = sampled["reveal"]
    reveal_vote = decision["type"] == "request_next_reveal"
    reveal_weight = _reveal_bc_weight(decision, context, profile)
    if reveal_weight > 0.0:
        policy.accumulate_reveal_gradient(
            gradients,
            reveal_sampled["features"] if "features" in reveal_sampled else reveal_sampled["base"]["values"],
            reveal_sampled["probability"],
            reveal_vote,
            reveal_weight,
        )
    if reveal_weight > 0.0 and reveal_vote:
        stats["reveal"] += 1
    stats["examples"] += 1


def _collect_bc_gradients_chunk(args: Dict) -> Dict:
    policy = policy_from_dict(args["policy"])
    gradients = policy.zero_gradients()
    stats = {"quote": 0, "take": 0, "reveal": 0, "examples": 0}
    seat_counts = list(args["seat_counts"])
    start_episode = int(args["start_episode"])
    count = int(args["count"])
    base_seed = int(args["seed"])
    for offset in range(count):
        episode_index = start_episode + offset
        random.seed(_episode_seed(base_seed, episode_index))
        simulator = CardMarketSimulator(seed=_episode_seed(base_seed, episode_index))
        seat_count = random.choice(seat_counts)
        seat_ratio = max(0.0, min(1.0, float(seat_count) / 10.0))
        episode_rng = random.Random(_episode_seed(base_seed + 17, episode_index))
        teacher_profiles: Dict[str, str] = {}
        record_after_step = 0 if episode_rng.random() < 0.3 else episode_rng.randint(1, 4)

        def actor(state: Dict, player_id: str, now_step: int) -> Dict:
            snapshot = deepcopy(state)
            if player_id not in teacher_profiles:
                teacher_profiles[player_id] = _sample_teacher_profile(episode_rng)
            decision = _teacher_decision(snapshot, player_id, now_step, episode_rng, teacher_profiles[player_id])
            base = base_feature_vector(snapshot, player_id, now_step)
            best_take = _best_teacher_take(base)
            positive_take_edge = float(best_take["edge"]) if best_take else -1.0
            mid_round = now_step >= 1 or snapshot["revealed_board_count"] >= 2
            record = now_step >= record_after_step or positive_take_edge > 0.025 or decision["type"] == "taker_action"
            if record:
                _accumulate_bc_example(
                    policy,
                    gradients,
                    stats,
                    state=snapshot,
                    player_id=player_id,
                    decision=decision,
                    now_step=now_step,
                )
            if mid_round and (positive_take_edge > 0.025 or decision["type"] == "taker_action"):
                _accumulate_bc_example(
                    policy,
                    gradients,
                    stats,
                    state=snapshot,
                    player_id=player_id,
                    decision=decision,
                    now_step=now_step,
                )
                if positive_take_edge > 0.06 or decision["type"] == "taker_action":
                    _accumulate_bc_example(
                        policy,
                        gradients,
                        stats,
                        state=snapshot,
                        player_id=player_id,
                        decision=decision,
                        now_step=now_step,
                    )
            if positive_take_edge > 0.04 and seat_ratio >= 0.4:
                _accumulate_bc_example(
                    policy,
                    gradients,
                    stats,
                    state=snapshot,
                    player_id=player_id,
                    decision=decision,
                    now_step=now_step,
                )
                if decision["type"] == "taker_action" and positive_take_edge > 0.065:
                    _accumulate_bc_example(
                        policy,
                        gradients,
                        stats,
                        state=snapshot,
                        player_id=player_id,
                        decision=decision,
                        now_step=now_step,
                    )
            return {"type": decision["type"], "payload": decision.get("payload", {})}

        simulator.run_episode(seat_count, actor, incentive_schedule=TRAINING_INCENTIVE_SCHEDULE)
    return {
        "episodes": count,
        "gradients": gradients,
        "stats": stats,
    }


def warm_start_behavior_cloning(
    policy,
    episodes: int,
    seat_counts: List[int],
    seed: int,
    workers: int,
    lr: float = 0.015,
    progress_label: str = "BC Warmstart",
) -> None:
    progress = ProgressBar(progress_label, episodes)
    stats = {"quote": 0, "take": 0, "reveal": 0, "examples": 0}

    if episodes <= 0:
        progress.finish(detail="episodes 0")
        return

    batch_size = _episode_batch_size(episodes, workers)

    if workers <= 1:
        completed = 0
        while completed < episodes:
            count = min(batch_size, episodes - completed)
            payload = _collect_bc_gradients_chunk(
                {
                    "policy": policy.to_dict(),
                    "start_episode": completed,
                    "count": count,
                    "seat_counts": seat_counts,
                    "seed": seed,
                }
            )
            policy.apply_gradients(payload["gradients"], _normalized_step_size(lr, payload["stats"]["examples"]))
            completed += int(payload["episodes"])
            _merge_training_stats(stats, payload["stats"])
            progress.update(
                completed,
                detail=f"examples {stats['examples']} | q {stats['quote']} t {stats['take']} r {stats['reveal']}",
            )
        progress.finish(detail=f"examples {stats['examples']} | q {stats['quote']} t {stats['take']} r {stats['reveal']}")
        return

    executor_info = _open_parallel_executor(workers)
    if executor_info[0] is None:
        progress.finish(detail="episodes 0")
        return
    executor, executor_mode = executor_info
    completed = 0
    submitted = 0
    with executor:
        while completed < episodes:
            futures = []
            policy_snapshot = policy.to_dict()
            while submitted < episodes and len(futures) < _max_inflight_jobs(workers):
                count = min(batch_size, episodes - submitted)
                futures.append(
                    executor.submit(
                        _collect_bc_gradients_chunk,
                        {
                            "policy": policy_snapshot,
                            "start_episode": submitted,
                            "count": count,
                            "seat_counts": seat_counts,
                            "seed": seed,
                        },
                    )
                )
                submitted += count
            batch_gradients = policy.zero_gradients()
            batch_examples = 0
            for future in as_completed(futures):
                payload = future.result()
                completed += int(payload["episodes"])
                policy.merge_gradients(batch_gradients, payload["gradients"])
                _merge_training_stats(stats, payload["stats"])
                batch_examples += int(payload["stats"]["examples"])
                progress.update(
                    completed,
                    detail=(
                        f"{executor_mode} workers | examples {stats['examples']} | "
                        f"q {stats['quote']} t {stats['take']} r {stats['reveal']}"
                    ),
                )
            policy.apply_gradients(batch_gradients, _normalized_step_size(lr, batch_examples))
    progress.finish(
        detail=(
            f"{executor_mode} workers | examples {stats['examples']} | "
            f"q {stats['quote']} t {stats['take']} r {stats['reveal']}"
        )
    )


def _opponent_mix_descriptor(seat_roles: Dict[str, Dict]) -> str:
    counts = {"current": 0, "historical": 0, "bootstrap": 0, "teacher": 0, "baseline": 0, "heuristic": 0}
    for role in seat_roles.values():
        counts[role["kind"]] = counts.get(role["kind"], 0) + 1
    return (
        f"cur {counts['current']} hist {counts['historical']} "
        f"boot {counts['bootstrap']} teach {counts['teacher']} base {counts['baseline']} heur {counts['heuristic']}"
    )


def _sample_opponent_role(
    rng: random.Random,
    historical_pool: List,
    current_policy,
    teacher_rng_seed: int,
) -> Dict:
    roll = rng.random()
    if ADVERSARIAL_CURRICULUM and roll < 0.28:
        return {"kind": "baseline", "baseline_id": BASELINE_TAKER_BEST_EDGE}
    if historical_pool and roll < 0.22:
        return {"kind": "historical", "policy": rng.choice(historical_pool)}
    if roll < 0.4:
        bootstrap = bootstrap_neural_policy() if getattr(current_policy, "model_type", "") != "linear" else bootstrap_policy()
        return {"kind": "bootstrap", "policy": bootstrap}
    if roll < 0.8:
        return {
            "kind": "teacher",
            "profile": _sample_teacher_profile(rng),
            "rng": random.Random(teacher_rng_seed),
        }
    if roll < 0.94:
        baseline_pool = [
            BASELINE_BALANCED,
            BASELINE_BALANCED,
            BASELINE_MAKER_PUBLIC_SKEW,
            BASELINE_TAKER_BEST_EDGE,
            BASELINE_MAKER_PUBLIC_MID,
        ]
        return {"kind": "baseline", "baseline_id": rng.choice(baseline_pool)}
    return {"kind": "heuristic"}


def _build_seat_roles(
    *,
    current_policy,
    historical_pool: List,
    seat_ids: List[str],
    seed: int,
) -> Dict[str, Dict]:
    rng = random.Random(seed)
    seat_roles: Dict[str, Dict] = {seat_ids[0]: {"kind": "current", "policy": current_policy}}
    extra_current_slots = 1 if len(seat_ids) >= 8 and rng.random() < 0.35 else 0
    remaining_ids = list(seat_ids[1:])
    rng.shuffle(remaining_ids)
    for player_id in remaining_ids[:extra_current_slots]:
        seat_roles[player_id] = {"kind": "current", "policy": current_policy}
    for index, player_id in enumerate(seat_ids):
        if player_id in seat_roles:
            continue
        seat_roles[player_id] = _sample_opponent_role(
            rng,
            historical_pool,
            current_policy,
            teacher_rng_seed=seed * 101 + index * 37 + 11,
        )
    return seat_roles


def _actor_decision_for_role(role: Dict, state: Dict, player_id: str, now_step: int) -> Dict:
    kind = role["kind"]
    if kind in {"current", "historical", "bootstrap"}:
        seat_policy = role["policy"]
        return seat_policy.choose_action(state, player_id, now_step)
    if kind == "teacher":
        return _teacher_decision(state, player_id, now_step, role["rng"], role["profile"])
    if kind == "baseline":
        return decision_for_baseline(role["baseline_id"], state, player_id, now_step)
    return heuristic_decision(state, player_id, now_step)


def _build_actor(policy, trajectories: List[Dict], seat_roles: Dict[str, Dict]):
    def actor(state: Dict, player_id: str, now_step: int) -> Dict:
        role = seat_roles[player_id]
        if role["kind"] == "current":
            seat_policy = role["policy"]
            choice = seat_policy.choose_action(state, player_id, now_step)
            take = choice["take"]
            quote = choice["quote"]
            reveal = choice["reveal"]
            intent = choice["intent"]
            base = choice["base"]
            toxicity = quote_toxicity(base, quote.get("payload")) if quote.get("payload") else 0.0
            trajectories.append(
                {
                    "player_id": player_id,
                    "base_values": list(base["values"]),
                    "context": _training_context(base, state, player_id),
                    "intent_action_index": int(intent["action_index"]),
                    "intent_features": intent["features"],
                    "intent_probabilities": intent["probabilities"],
                    "selected_take_edge": _selected_take_edge(take),
                    "selected_take_action": take["payload"].get("action", "pass"),
                    "quote_action_index": int(quote["template_index"]),
                    "quote_features": quote["features"],
                    "quote_probabilities": quote["probabilities"],
                    "quote_toxicity": toxicity,
                    "take_action_index": int(take["action_index"]),
                    "take_features": take["features"],
                    "take_probabilities": take["probabilities"],
                    "reveal_vote": bool(reveal["vote"]),
                    "reveal_probability": float(reveal["probability"]),
                    "reveal_features": reveal.get("features", reveal["base"]["values"]),
                }
            )
        else:
            choice = _actor_decision_for_role(role, state, player_id, now_step)
        return {"type": choice["type"], "payload": choice.get("payload", {})}

    return actor


def _accumulate_ppo_item(policy, gradients: Dict, item: Dict, reward: float, noop_index: int) -> None:
    base_values = item["base_values"]
    context = item["context"]
    profile = _policy_profile(policy)
    seat_ratio = float(context["seat_ratio"])
    quote_age = float(context["best_quote_age"])
    inventory_risk = abs(float(context["inventory"])) * profile["risk_penalty_scale"] * (1.0 + seat_ratio * 0.6)
    selected_take_action = str(item.get("selected_take_action", "pass"))
    aligned_inventory_penalty = 0.0
    if int(item["take_action_index"]) != 0:
        if selected_take_action == "buy":
            aligned_inventory_penalty = max(0.0, float(context["inventory"])) * profile["aligned_take_penalty_scale"]
        elif selected_take_action == "sell":
            aligned_inventory_penalty = max(0.0, -float(context["inventory"])) * profile["aligned_take_penalty_scale"]
    missed_take_penalty = (
        max(0.0, float(context["best_take_edge"]) - float(item["selected_take_edge"]))
        * profile["missed_take_penalty_scale"]
        * (1.0 + seat_ratio * 0.45 + max(0.0, quote_age - 0.7) * 0.2)
        if int(item["take_action_index"]) == 0
        else 0.0
    )
    maker_markout = float(item.get("episode_maker_markout", 0.0))
    taker_markout = float(item.get("episode_taker_markout", 0.0))
    maker_volume = float(item.get("episode_maker_volume", 0.0))
    taker_volume = float(item.get("episode_taker_volume", 0.0))
    maker_penalty = max(0.0, -maker_markout) * profile["maker_markout_penalty_scale"] * (1.0 + seat_ratio * 0.35)
    taker_bonus = max(0.0, taker_markout) * profile["taker_markout_bonus_scale"] * (1.0 + seat_ratio * 0.15)
    taker_penalty = max(0.0, -taker_markout) * profile["taker_markout_penalty_scale"] * (1.0 + seat_ratio * 0.25)
    shaped_reward = reward - inventory_risk - missed_take_penalty - aligned_inventory_penalty - maker_penalty - taker_penalty + taker_bonus
    advantage = shaped_reward - policy.value(base_values)
    intent_advantage = advantage * profile["intent_advantage_scale"]
    if int(item["intent_action_index"]) == 0:
        intent_advantage += max(0.0, float(item["selected_take_edge"])) * (
            (1.5 if getattr(policy, "model_type", "") == "neural_mlp" else 2.3) + seat_ratio * 0.45
        )
        intent_advantage -= aligned_inventory_penalty * 0.75
    elif int(item["intent_action_index"]) == 1 and float(context["best_take_edge"]) > (0.03 - min(0.015, quote_age * 0.01)):
        intent_advantage -= 0.16 + float(context["best_take_edge"]) * profile["missed_take_penalty_scale"] * (0.65 + seat_ratio * 0.35)
    elif int(item["intent_action_index"]) == 1 and not bool(context["has_own_quote"]) and float(context["live_quote_count"]) <= 0.125:
        intent_advantage += 0.35 if getattr(policy, "model_type", "") == "linear" else 0.15
    if int(item["intent_action_index"]) == 1 and maker_volume > 0.0:
        intent_advantage -= max(0.0, -maker_markout) * profile["maker_markout_penalty_scale"] * 0.6
    if int(item["intent_action_index"]) == 0 and taker_volume > 0.0:
        intent_advantage += max(0.0, taker_markout) * profile["taker_markout_bonus_scale"] * 0.75
    elif int(item["intent_action_index"]) == 2:
        intent_advantage += _reveal_bonus(bool(item["reveal_vote"]), context)
    elif int(item["intent_action_index"]) == 3 and not bool(context["has_own_quote"]) and float(context["live_quote_count"]) <= 0.125:
        intent_advantage -= 0.55 if getattr(policy, "model_type", "") == "linear" else 0.25
    quote_advantage = advantage * profile["quote_advantage_scale"] + _quote_bonus(int(item["quote_action_index"]), noop_index, context)
    take_advantage = advantage * profile["take_advantage_scale"] + _take_bonus(
        int(item["take_action_index"]),
        context,
        float(item["selected_take_edge"]),
    )
    if int(item["take_action_index"]) != 0:
        take_advantage -= aligned_inventory_penalty
        take_advantage += max(0.0, taker_markout) * profile["taker_markout_bonus_scale"] * 0.7
        take_advantage -= max(0.0, -taker_markout) * profile["taker_markout_penalty_scale"] * 0.8
    if int(item["quote_action_index"]) != noop_index:
        quote_advantage -= max(0.0, -maker_markout) * profile["maker_markout_penalty_scale"] * 0.8
        quote_advantage -= float(item.get("quote_toxicity", 0.0)) * (0.35 + CONSERVATIVE_PENALTY)
    reveal_advantage = advantage * profile["reveal_advantage_scale"] + _reveal_bonus(bool(item["reveal_vote"]), context)
    policy.accumulate_intent_gradient(
        gradients,
        item["intent_features"],
        item["intent_probabilities"],
        int(item["intent_action_index"]),
        intent_advantage,
    )
    policy.accumulate_quote_gradient(
        gradients,
        item["quote_features"],
        item["quote_probabilities"],
        int(item["quote_action_index"]),
        quote_advantage,
    )
    policy.accumulate_take_gradient(
        gradients,
        item["take_features"],
        item["take_probabilities"],
        int(item["take_action_index"]),
        take_advantage,
    )
    policy.accumulate_reveal_gradient(
        gradients,
        item["reveal_features"],
        float(item["reveal_probability"]),
        bool(item["reveal_vote"]),
        reveal_advantage * 0.5,
    )
    policy.accumulate_value_gradient(gradients, base_values, reward, scale=0.5)


def _player_trade_markouts(state: Dict, settlement: float) -> Dict[str, Dict[str, float]]:
    stats: Dict[str, Dict[str, float]] = {}
    for player_id in state.get("active_seat_ids", []):
        stats[player_id] = {
            "maker_volume": 0.0,
            "maker_markout_sum": 0.0,
            "taker_volume": 0.0,
            "taker_markout_sum": 0.0,
        }
    for entry in state.get("log", []):
        if entry.get("type") != "trade":
            continue
        qty = float(entry.get("qty", 0))
        price = float(entry.get("price", 0.0))
        maker_id = entry.get("maker_player_id")
        taker_id = entry.get("taker_player_id")
        side = str(entry.get("action", "buy"))
        if maker_id in stats:
            stats[maker_id]["maker_volume"] += qty
            stats[maker_id]["maker_markout_sum"] += qty * (price - settlement if side == "buy" else settlement - price)
        if taker_id in stats:
            stats[taker_id]["taker_volume"] += qty
            stats[taker_id]["taker_markout_sum"] += qty * (settlement - price if side == "buy" else price - settlement)
    for player_id, values in stats.items():
        values["maker_markout"] = values["maker_markout_sum"] / max(1.0, values["maker_volume"])
        values["taker_markout"] = values["taker_markout_sum"] / max(1.0, values["taker_volume"])
    return stats


def _simulate_parallel_episode(args: Dict) -> Dict:
    episode_index = int(args["episode_index"])
    total_episodes = int(args["total_episodes"])
    seed = _episode_seed(int(args["seed"]), episode_index)
    random.seed(seed)
    current_policy = policy_from_dict(args["current_policy"])
    historical_pool = [policy_from_dict(entry) for entry in args["historical_pool"]]
    simulator = CardMarketSimulator(seed=seed)
    episode_rng = random.Random(seed + 719)
    seat_count = episode_rng.choice(TRAINING_SEAT_COUNTS)
    seat_ids = [f"seat-{index + 1}" for index in range(seat_count)]
    trajectories: List[Dict] = []
    noop_index = next(index for index, template in enumerate(current_policy.quote_templates) if template["id"] == "noop")
    seat_roles = _build_seat_roles(
        current_policy=current_policy,
        historical_pool=historical_pool,
        seat_ids=seat_ids,
        seed=seed + 313,
    )

    def actor(state: Dict, player_id: str, now_step: int) -> Dict:
        role = seat_roles[player_id]
        if role["kind"] == "current":
            seat_policy = role["policy"]
            choice = seat_policy.choose_action(state, player_id, now_step)
            take = choice["take"]
            quote = choice["quote"]
            reveal = choice["reveal"]
            intent = choice["intent"]
            base = choice["base"]
            trajectories.append(
                {
                    "player_id": player_id,
                    "base_values": list(base["values"]),
                    "context": _training_context(base, state, player_id),
                    "intent_action_index": int(intent["action_index"]),
                    "intent_features": intent["features"],
                    "intent_probabilities": intent["probabilities"],
                    "selected_take_edge": _selected_take_edge(take),
                    "selected_take_action": take["payload"].get("action", "pass"),
                    "quote_action_index": int(quote["template_index"]),
                    "quote_features": quote["features"],
                    "quote_probabilities": quote["probabilities"],
                    "take_action_index": int(take["action_index"]),
                    "take_features": take["features"],
                    "take_probabilities": take["probabilities"],
                    "reveal_vote": bool(reveal["vote"]),
                    "reveal_probability": float(reveal["probability"]),
                    "reveal_features": reveal.get("features", reveal["base"]["values"]),
                }
            )
        else:
            choice = _actor_decision_for_role(role, state, player_id, now_step)
        return {"type": choice["type"], "payload": choice.get("payload", {})}

    state, summary = simulator.run_episode(seat_count, actor, incentive_schedule=TRAINING_INCENTIVE_SCHEDULE)
    trade_stats = _player_trade_markouts(state, float(summary.settlement))
    for item in trajectories:
        player_trade_stats = trade_stats.get(
            item["player_id"],
            {"maker_volume": 0.0, "maker_markout": 0.0, "taker_volume": 0.0, "taker_markout": 0.0},
        )
        item["episode_maker_volume"] = float(player_trade_stats["maker_volume"])
        item["episode_maker_markout"] = float(player_trade_stats["maker_markout"])
        item["episode_taker_volume"] = float(player_trade_stats["taker_volume"])
        item["episode_taker_markout"] = float(player_trade_stats["taker_markout"])
    gradients = current_policy.zero_gradients()
    for item in trajectories:
        reward = float(summary.risk_adjusted_pnl[item["player_id"]])
        _accumulate_ppo_item(current_policy, gradients, item, reward, noop_index)

    return {
        "episode_index": episode_index,
        "seat_count": seat_count,
        "avg_reward": sum(summary.risk_adjusted_pnl[player_id] for player_id in seat_ids) / max(1, len(seat_ids)),
        "tracked": len(trajectories),
        "mix": _opponent_mix_descriptor(seat_roles),
        "gradients": gradients,
    }


def ppo_self_play(
    policy,
    episodes: int,
    seed: int,
    workers: int,
    lr: float = 0.01,
    progress_label: str = "PPO SelfPlay",
) -> None:
    historical_pool = [policy.copy()]
    progress = ProgressBar(progress_label, episodes)
    running_reward = 0.0
    noop_index = next(index for index, template in enumerate(policy.quote_templates) if template["id"] == "noop")
    if episodes <= 0:
        progress.finish(detail="avg reward 0.000")
        return

    if workers <= 1:
        simulator = CardMarketSimulator(seed=seed)
        for episode in range(episodes):
            episode_rng = random.Random(_episode_seed(seed + 59, episode))
            seat_count = episode_rng.choice(TRAINING_SEAT_COUNTS)
            seat_ids = [f"seat-{index + 1}" for index in range(seat_count)]
            trajectories: List[Dict] = []
            seat_roles = _build_seat_roles(
                current_policy=policy,
                historical_pool=historical_pool,
                seat_ids=seat_ids,
                seed=_episode_seed(seed + 41, episode),
            )
            actor = _build_actor(policy, trajectories, seat_roles)
            state, summary = simulator.run_episode(seat_count, actor, incentive_schedule=TRAINING_INCENTIVE_SCHEDULE)
            trade_stats = _player_trade_markouts(state, float(summary.settlement))
            for item in trajectories:
                player_trade_stats = trade_stats.get(
                    item["player_id"],
                    {"maker_volume": 0.0, "maker_markout": 0.0, "taker_volume": 0.0, "taker_markout": 0.0},
                )
                item["episode_maker_volume"] = float(player_trade_stats["maker_volume"])
                item["episode_maker_markout"] = float(player_trade_stats["maker_markout"])
                item["episode_taker_volume"] = float(player_trade_stats["taker_volume"])
                item["episode_taker_markout"] = float(player_trade_stats["taker_markout"])
            episode_rewards = [summary.risk_adjusted_pnl[player_id] for player_id in seat_ids]
            running_reward += sum(episode_rewards) / max(1, len(episode_rewards))
            gradients = policy.zero_gradients()
            for item in trajectories:
                reward = float(summary.risk_adjusted_pnl[item["player_id"]])
                _accumulate_ppo_item(policy, gradients, item, reward, noop_index)
            policy.apply_gradients(gradients, _normalized_step_size(lr, max(1, len(trajectories))))
            if episode and episode % 10 == 0:
                historical_pool.append(policy.copy())
                historical_pool = historical_pool[-6:]
            progress.update(
                episode + 1,
                detail=(
                    f"seats {seat_count} | tracked {len(trajectories)} | {_opponent_mix_descriptor(seat_roles)} | "
                    f"avg reward {running_reward / (episode + 1):.3f}"
                ),
            )
        progress.finish(detail=f"avg reward {running_reward / max(1, episodes):.3f}")
        return

    completed = 0
    executor_info = _open_parallel_executor(workers)
    if executor_info[0] is None:
        progress.finish(detail="avg reward 0.000")
        return
    executor, executor_mode = executor_info
    with executor:
        while completed < episodes:
            batch_count = min(_max_inflight_jobs(workers), episodes - completed)
            current_policy_data = policy.to_dict()
            historical_pool_data = [entry.to_dict() for entry in historical_pool]
            futures = [
                executor.submit(
                    _simulate_parallel_episode,
                    {
                        "episode_index": completed + offset,
                        "total_episodes": episodes,
                        "seed": seed,
                        "current_policy": current_policy_data,
                        "historical_pool": historical_pool_data,
                    },
                )
                for offset in range(batch_count)
            ]
            batch_results = sorted((future.result() for future in futures), key=lambda item: item["episode_index"])
            batch_gradients = policy.zero_gradients()
            batch_tracked = 0
            for payload in batch_results:
                episode_index = int(payload["episode_index"])
                running_reward += float(payload["avg_reward"])
                policy.merge_gradients(batch_gradients, payload["gradients"])
                batch_tracked += int(payload["tracked"])
                if episode_index and episode_index % 10 == 0:
                    historical_pool.append(policy.copy())
                    historical_pool = historical_pool[-6:]
                progress.update(
                    episode_index + 1,
                    detail=(
                        f"{executor_mode} workers | seats {payload['seat_count']} | tracked {payload['tracked']} | "
                        f"{payload['mix']} | "
                        f"avg reward {running_reward / (episode_index + 1):.3f}"
                    ),
                )
            policy.apply_gradients(batch_gradients, _normalized_step_size(lr, batch_tracked))
            completed += batch_count
    progress.finish(detail=f"avg reward {running_reward / max(1, episodes):.3f}")


def _mean_main_seat_counts(summary: Dict[int, Dict], seat_counts: List[int], weights: Dict[int, float] | None = None) -> float:
    weighted_total = 0.0
    weight_sum = 0.0
    for seat_count in seat_counts:
        if seat_count not in summary:
            continue
        weight = float((weights or {}).get(seat_count, 1.0))
        weighted_total += float(summary[seat_count]["mean"]) * weight
        weight_sum += weight
    return weighted_total / max(1.0, weight_sum)


ROLE_BALANCE_PRACTICAL_PNL_BAND = 0.25


def _role_balance_live_candidate(summary: Dict) -> bool:
    take_rate = float(summary["taker_take_rate"])
    return (
        abs(float(summary["maker_mean_pnl"])) <= ROLE_BALANCE_PRACTICAL_PNL_BAND
        and abs(float(summary["taker_mean_pnl"])) <= ROLE_BALANCE_PRACTICAL_PNL_BAND
        and float(summary["maker_quote_rate"]) >= ROLE_BALANCE_ACTIVITY_FLOORS["maker_quote_rate"]
        and ROLE_BALANCE_ACTIVITY_FLOORS["taker_take_rate_min"] - 0.005 <= take_rate <= ROLE_BALANCE_ACTIVITY_FLOORS["taker_take_rate_max"]
        and not bool(summary["quote_collapse"])
        and not bool(summary["taker_overtrade"])
    )


def _role_balance_gate_failures(summary: Dict) -> List[str]:
    failures = []
    take_rate = float(summary["taker_take_rate"])
    if (
        abs(float(summary["maker_mean_pnl"])) > ROLE_BALANCE_PRACTICAL_PNL_BAND
        or abs(float(summary["taker_mean_pnl"])) > ROLE_BALANCE_PRACTICAL_PNL_BAND
    ):
        failures.append("role_pnl_outside_band")
    if abs(float(summary.get("parity_gap", 0.0))) > 0.5:
        failures.append("role_parity_gap")
    if float(summary["maker_quote_rate"]) < ROLE_BALANCE_ACTIVITY_FLOORS["maker_quote_rate"]:
        failures.append("quote_collapse")
    if take_rate < ROLE_BALANCE_ACTIVITY_FLOORS["taker_take_rate_min"] - 0.005:
        failures.append("taker_undertrade")
    if take_rate > ROLE_BALANCE_ACTIVITY_FLOORS["taker_take_rate_max"]:
        failures.append("taker_overtrade")
    if bool(summary["quote_collapse"]):
        failures.append("quote_collapse_flag")
    return failures


def _open_seat_take_floor(seat_count: int, balanced_rate: float, heuristic_rate: float) -> float:
    baseline_rate = max(float(balanced_rate), float(heuristic_rate))
    seat_floor = {4: 0.07, 6: 0.06, 8: 0.03, 10: 0.03}.get(int(seat_count), 0.07)
    if int(seat_count) >= 8:
        return max(seat_floor, min(0.07, baseline_rate * 0.50))
    return max(seat_floor, min(0.10, baseline_rate * 0.70))


def _family_gate_failures(
    family: str,
    candidate: Dict,
    *,
    wait_mean: float,
    balanced_mean: float,
    heuristic_mean: float,
    balanced_summary: Dict[int, Dict],
    heuristic_summary: Dict[int, Dict],
    gate_counts: List[int],
    role_balance_summary: Dict,
) -> List[str]:
    summary = candidate["summary"]
    failures: List[str] = []
    if candidate["mainSeatMean"] < heuristic_mean - 0.05:
        failures.append("weighted_pnl_below_heuristic")
    if candidate["mainSeatMean"] < balanced_mean - 0.05:
        failures.append("weighted_pnl_below_balanced")
    if candidate["mainSeatMean"] < wait_mean + 0.02:
        failures.append("weighted_pnl_below_wait")
    for seat_count in gate_counts:
        row = summary[seat_count]
        take_floor = _open_seat_take_floor(
            seat_count,
            balanced_summary[seat_count].get("take_rate", 0.10),
            heuristic_summary[seat_count].get("take_rate", 0.10),
        )
        if row["take_rate"] < take_floor:
            failures.append(f"seat_{seat_count}_take_under")
        if row["take_rate"] > 0.35:
            failures.append(f"seat_{seat_count}_take_over")
        if row["missed_take_rate"] > 0.78:
            failures.append(f"seat_{seat_count}_missed_take")
        if row["quote_rate"] < 0.40:
            failures.append(f"seat_{seat_count}_quote_under")
        if row["maker_markout"] < maker_markout_floor(seat_count) or row.get("toxic_quote_rate", 0.0) > 0.18:
            failures.append(f"seat_{seat_count}_maker_toxicity")
        if row["mean"] < heuristic_summary[seat_count]["mean"] - 0.15:
            failures.append(f"seat_{seat_count}_below_heuristic")
        if row["mean"] < balanced_summary[seat_count]["mean"] - 0.15:
            failures.append(f"seat_{seat_count}_below_balanced")
    failures.extend(_role_balance_gate_failures(role_balance_summary))
    if family != "linear":
        return failures
    return list(dict.fromkeys(failures))


def _family_live_candidate(
    family: str,
    candidate: Dict,
    *,
    wait_mean: float,
    balanced_mean: float,
    public_maker_mean: float,
    heuristic_mean: float,
    balanced_summary: Dict[int, Dict],
    heuristic_summary: Dict[int, Dict],
    gate_counts: List[int],
    role_balance_summary: Dict,
) -> bool:
    summary = candidate["summary"]
    if family == "linear":
        return not _family_gate_failures(
            family,
            candidate,
            wait_mean=wait_mean,
            balanced_mean=balanced_mean,
            heuristic_mean=heuristic_mean,
            balanced_summary=balanced_summary,
            heuristic_summary=heuristic_summary,
            gate_counts=gate_counts,
            role_balance_summary=role_balance_summary,
        )
    return (
        candidate["mainSeatMean"] >= heuristic_mean
        and candidate["mainSeatMean"] >= balanced_mean
        and candidate["mainSeatMean"] >= public_maker_mean
        and candidate["mainSeatMean"] >= wait_mean + 0.05
        and all(summary[seat_count]["quote_rate"] >= 0.08 for seat_count in gate_counts)
        and all(summary[seat_count]["take_rate"] <= 0.35 for seat_count in gate_counts)
        and all(summary[seat_count]["taker_markout"] >= 0.0 for seat_count in gate_counts)
        and all(summary[seat_count]["maker_markout"] >= -0.35 for seat_count in gate_counts)
        and all(summary[seat_count]["mean"] >= heuristic_summary[seat_count]["mean"] for seat_count in gate_counts)
        and _role_balance_live_candidate(role_balance_summary)
    )


def _build_export_evaluation(linear_policy, neural_policy, workers: int, seed: int, linear_version: str = "linear-v2", neural_version: str = "neural-v1") -> tuple[Dict, Dict]:
    seat_counts = [2, 4, 6, 8, 10]
    gate_counts = list(GATE_SEAT_COUNTS)
    episodes = 300
    eval_workers = max(1, workers)
    gate_jobs = [
        ("linear", "linear", linear_policy.to_dict(), seed + 3001),
        ("neural", "linear", neural_policy.to_dict(), seed + 3101),
        ("wait", f"baseline:{BASELINE_WAIT}", None, seed + 3151),
        ("balanced", f"baseline:{BASELINE_BALANCED}", None, seed + 3176),
        ("public-maker", f"baseline:{BASELINE_MAKER_PUBLIC_MID}", None, seed + 3191),
        ("heuristic", "heuristic", None, seed + 3201),
    ]
    gate_workers = _split_worker_budget(eval_workers, len(gate_jobs))
    gate_results: Dict[str, tuple[Dict[int, Dict], str]] = {}
    with ThreadPoolExecutor(max_workers=len(gate_jobs)) as executor:
        future_map = {
            executor.submit(
                _evaluate_policy,
                name=name,
                policy_kind=policy_kind,
                policy_data=policy_data,
                episodes=episodes,
                seat_counts=seat_counts,
                workers=assigned_workers,
                seed=job_seed,
                progress_label=f"Gate {name[:4]}",
                show_progress=False,
            ): name
            for (name, policy_kind, policy_data, job_seed), assigned_workers in zip(gate_jobs, gate_workers)
        }
        for future in as_completed(future_map):
            gate_results[future_map[future]] = future.result()

    linear_summary, _ = gate_results["linear"]
    neural_summary, _ = gate_results["neural"]
    wait_summary, _ = gate_results["wait"]
    balanced_summary, _ = gate_results["balanced"]
    public_maker_summary, _ = gate_results["public-maker"]
    heuristic_summary, _ = gate_results["heuristic"]

    heuristic_mean = _mean_main_seat_counts(heuristic_summary, gate_counts, GATE_SEAT_WEIGHTS)
    wait_mean = _mean_main_seat_counts(wait_summary, gate_counts, GATE_SEAT_WEIGHTS)
    balanced_mean = _mean_main_seat_counts(balanced_summary, gate_counts, GATE_SEAT_WEIGHTS)
    public_maker_mean = _mean_main_seat_counts(public_maker_summary, gate_counts, GATE_SEAT_WEIGHTS)
    role_balance_schedule, _, _ = _choose_role_balance_schedule(
        name="linear-role-balance",
        policy_kind="linear",
        policy_data=linear_policy.to_dict(),
        episodes=max(60, episodes // 3),
        workers=eval_workers,
        seed=seed + 3301,
    )
    role_balance_jobs = [
        ("linear", "linear", linear_policy.to_dict(), seed + 3401),
        ("neural", "linear", neural_policy.to_dict(), seed + 3501),
        ("wait", f"baseline:{BASELINE_WAIT}", None, seed + 3601),
        ("balanced", f"baseline:{BASELINE_BALANCED}", None, seed + 3701),
        ("publicMaker", f"baseline:{BASELINE_MAKER_PUBLIC_MID}", None, seed + 3801),
        ("heuristic", "heuristic", None, seed + 3901),
    ]
    role_balance_workers = _split_worker_budget(eval_workers, len(role_balance_jobs))
    role_balance_results: Dict[str, tuple[Dict, str]] = {}
    with ThreadPoolExecutor(max_workers=len(role_balance_jobs)) as executor:
        future_map = {
            executor.submit(
                _evaluate_role_balance_policy,
                name=name,
                maker_policy_kind=policy_kind,
                maker_policy_data=policy_data,
                taker_policy_kind=policy_kind,
                taker_policy_data=policy_data,
                episodes=max(60, episodes // 3),
                workers=assigned_workers,
                seed=job_seed,
                incentive_schedule=role_balance_schedule,
                progress_label=f"Role {name[:4]}",
                show_progress=False,
            ): name
            for (name, policy_kind, policy_data, job_seed), assigned_workers in zip(role_balance_jobs, role_balance_workers)
        }
        for future in as_completed(future_map):
            role_balance_results[future_map[future]] = future.result()
    results = {
        "linear": {
            "summary": linear_summary,
            "mainSeatMean": _mean_main_seat_counts(linear_summary, gate_counts, GATE_SEAT_WEIGHTS),
            "roleBalance": role_balance_results["linear"][0],
        },
        "neural": {
            "summary": neural_summary,
            "mainSeatMean": _mean_main_seat_counts(neural_summary, gate_counts, GATE_SEAT_WEIGHTS),
            "roleBalance": role_balance_results["neural"][0],
        },
        "wait": {
            "summary": wait_summary,
            "mainSeatMean": wait_mean,
            "roleBalance": role_balance_results["wait"][0],
        },
        "balanced": {
            "summary": balanced_summary,
            "mainSeatMean": balanced_mean,
            "roleBalance": role_balance_results["balanced"][0],
        },
        "publicMaker": {
            "summary": public_maker_summary,
            "mainSeatMean": public_maker_mean,
            "roleBalance": role_balance_results["publicMaker"][0],
        },
        "heuristic": {
            "summary": heuristic_summary,
            "mainSeatMean": heuristic_mean,
            "roleBalance": role_balance_results["heuristic"][0],
        },
    }

    default_policy_ids = {}
    for family in ("linear", "neural"):
        candidate = results[family]
        candidate["gateFailures"] = _family_gate_failures(
            family,
            candidate,
            wait_mean=wait_mean,
            balanced_mean=balanced_mean,
            heuristic_mean=heuristic_mean,
            balanced_summary=balanced_summary,
            heuristic_summary=heuristic_summary,
            gate_counts=gate_counts,
            role_balance_summary=candidate["roleBalance"],
        )
        candidate["liveCandidate"] = _family_live_candidate(
            family,
            candidate,
            wait_mean=wait_mean,
            balanced_mean=balanced_mean,
            public_maker_mean=public_maker_mean,
            heuristic_mean=heuristic_mean,
            balanced_summary=balanced_summary,
            heuristic_summary=heuristic_summary,
            gate_counts=gate_counts,
            role_balance_summary=candidate["roleBalance"],
        )
    if results["linear"]["liveCandidate"]:
        default_policy_ids["linear"] = linear_version
    if results["neural"]["liveCandidate"]:
        default_policy_ids["neural"] = neural_version

    evaluation = {
        "linear": {
            "mainSeatMean": results["linear"]["mainSeatMean"],
            "vsHeuristic": results["linear"]["mainSeatMean"] - heuristic_mean,
            "liveCandidate": results["linear"]["liveCandidate"],
            "gateFailures": results["linear"]["gateFailures"],
            "promotionDecision": "live-default" if results["linear"]["liveCandidate"] else "research-only",
            "toxicity": {
                str(seat_count): {
                    "quoteToxicity": results["linear"]["summary"][seat_count].get("quote_toxicity", 0.0),
                    "toxicQuoteRate": results["linear"]["summary"][seat_count].get("toxic_quote_rate", 0.0),
                    "makerMarkout": results["linear"]["summary"][seat_count].get("maker_markout", 0.0),
                }
                for seat_count in gate_counts
            },
            "roleBalance": results["linear"]["roleBalance"],
            "roleBalanceIncentiveSchedule": role_balance_schedule,
        },
        "neural": {
            "mainSeatMean": results["neural"]["mainSeatMean"],
            "vsHeuristic": results["neural"]["mainSeatMean"] - heuristic_mean,
            "liveCandidate": results["neural"]["liveCandidate"],
            "gateFailures": results["neural"]["gateFailures"],
            "promotionDecision": "live-default" if results["neural"]["liveCandidate"] else "research-only",
            "roleBalance": results["neural"]["roleBalance"],
            "roleBalanceIncentiveSchedule": role_balance_schedule,
        },
        "heuristic": {
            "mainSeatMean": heuristic_mean,
            "roleBalance": results["heuristic"]["roleBalance"],
        },
        "wait": {
            "mainSeatMean": wait_mean,
            "roleBalance": results["wait"]["roleBalance"],
        },
        "balanced": {
            "mainSeatMean": balanced_mean,
            "roleBalance": results["balanced"]["roleBalance"],
        },
        "publicMaker": {
            "mainSeatMean": public_maker_mean,
            "roleBalance": results["publicMaker"]["roleBalance"],
        },
    }
    return evaluation, default_policy_ids


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a card-market RL policy.")
    parser.add_argument("--bc-episodes", type=int, default=50_000)
    parser.add_argument("--ppo-episodes", type=int, default=50_000)
    parser.add_argument("--neural-bc-episodes", type=int, default=None)
    parser.add_argument("--neural-ppo-episodes", type=int, default=None)
    parser.add_argument("--train-neural", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--workers", type=int, default=default_worker_count())
    parser.add_argument("--parallel-families", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--out", type=Path, default=Path("workers/src/card-rl-policy-registry-data.js"))
    parser.add_argument("--linear-version", type=str, default="linear-v2")
    parser.add_argument("--neural-version", type=str, default="neural-v1")
    parser.add_argument("--objective", choices=["direct", "hybrid-as"], default="direct")
    parser.add_argument("--adversarial-curriculum", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--conservative-penalty", type=float, default=0.0)
    parser.add_argument("--candidate-selector", choices=["default", "pareto-live-gate"], default="default")
    args = parser.parse_args()

    global ADVERSARIAL_CURRICULUM, CONSERVATIVE_PENALTY
    ADVERSARIAL_CURRICULUM = bool(args.adversarial_curriculum)
    CONSERVATIVE_PENALTY = max(0.0, float(args.conservative_penalty))
    if args.objective == "hybrid-as" and args.linear_version == "linear-v2":
        args.linear_version = "linear-v3"

    random.seed(args.seed)
    workers = max(1, int(args.workers))
    neural_bc_episodes = args.bc_episodes if args.neural_bc_episodes is None else int(args.neural_bc_episodes)
    neural_ppo_episodes = args.ppo_episodes if args.neural_ppo_episodes is None else int(args.neural_ppo_episodes)
    print(
        (
            f"Seed {args.seed} | objective {args.objective} | selector {args.candidate_selector} | "
            f"linear bc {args.bc_episodes} | linear ppo {args.ppo_episodes} | "
            f"neural {'on' if args.train_neural else 'off'} | "
            f"neural bc {neural_bc_episodes} | neural ppo {neural_ppo_episodes} | workers {workers}"
        ),
        flush=True,
    )
    def train_family(family: str, bc_episodes: int, ppo_episodes: int, seed: int, assigned_workers: int) -> Dict:
        policy = bootstrap_hybrid_as_policy() if family == "linear" and args.objective == "hybrid-as" else bootstrap_policy() if family == "linear" else bootstrap_neural_policy()
        learning_rates = _family_learning_rates(family)
        warm_start_behavior_cloning(
            policy,
            bc_episodes,
            TRAINING_SEAT_COUNTS,
            seed,
            assigned_workers,
            lr=learning_rates["bc_lr"],
            progress_label=f"BC {family[:6]}",
        )
        ppo_self_play(
            policy,
            ppo_episodes,
            seed,
            assigned_workers,
            lr=learning_rates["ppo_lr"],
            progress_label=f"PPO {family[:5]}",
        )
        return policy.to_dict()

    if args.train_neural and args.parallel_families and workers > 1:
        family_workers = _split_worker_budget(workers, 2)
        with ThreadPoolExecutor(max_workers=2) as executor:
            linear_future = executor.submit(train_family, "linear", args.bc_episodes, args.ppo_episodes, args.seed, family_workers[0])
            neural_future = executor.submit(
                train_family,
                "neural",
                neural_bc_episodes,
                neural_ppo_episodes,
                args.seed + 101,
                family_workers[1],
            )
            linear_policy = policy_from_dict(linear_future.result())
            neural_policy = policy_from_dict(neural_future.result())
    else:
        linear_policy = policy_from_dict(train_family("linear", args.bc_episodes, args.ppo_episodes, args.seed, workers))
        if args.train_neural:
            neural_policy = policy_from_dict(train_family("neural", neural_bc_episodes, neural_ppo_episodes, args.seed + 101, workers))
        else:
            neural_policy = bootstrap_neural_policy()
            print("Skipping neural training; exporting bootstrap neural policy for comparison only.", flush=True)
    evaluation, default_policy_ids = _build_export_evaluation(linear_policy, neural_policy, workers, args.seed, args.linear_version, args.neural_version)
    print(
        (
            f"Export gate | linear live {evaluation['linear']['liveCandidate']} "
            f"(vs heur {evaluation['linear']['vsHeuristic']:+.3f}) | "
            f"neural live {evaluation['neural']['liveCandidate']} "
            f"(vs heur {evaluation['neural']['vsHeuristic']:+.3f})"
        ),
        flush=True,
    )
    export_js_module(
        linear_policy,
        neural_policy,
        args.out,
        linear_version=args.linear_version,
        neural_version=args.neural_version,
        source="python-card-rl",
        evaluation=evaluation,
        default_policy_ids={
            key: value
            for key, value in {
                "linear": args.linear_version if default_policy_ids.get("linear") else None,
                "neural": args.neural_version if default_policy_ids.get("neural") else None,
            }.items()
            if value
        },
    )
    print(f"Wrote card policy registry to {args.out}")


if __name__ == "__main__":
    main()
