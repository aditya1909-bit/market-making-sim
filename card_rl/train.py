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

from .export_policy import export_js_module
from .features import base_feature_vector
from .heuristic import heuristic_decision
from .model import LinearCardPolicy, bootstrap_policy
from .simulator import CardMarketSimulator

TEACHER_PROFILE_POOL = [
    "balanced",
    "balanced",
    "aggressive",
    "aggressive",
    "patient",
    "reveal",
    "opportunistic",
    "maker",
]


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
        "live_quote_count": float(base_state["values"][5]),
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


def _resolve_sampled_action(take: Dict, quote: Dict, reveal: Dict) -> Dict:
    take_score = max(take["probabilities"]) if take["probabilities"] else 0.0
    quote_score = max(quote["probabilities"]) if quote["probabilities"] else 0.0
    reveal_score = reveal["probability"] if reveal["vote"] else 0.0
    if take["payload"]["action"] != "pass" and take_score >= quote_score and take_score >= reveal_score:
        return take
    if quote["payload"] is not None:
        return quote
    return reveal


def _quote_bc_weight(decision: Dict, context: Dict[str, float | bool]) -> float:
    if decision["type"] == "submit_quote" and decision.get("payload"):
        return 1.3 + float(context["stdev"]) * 0.4
    if float(context["best_take_edge"]) > 0.04:
        return 0.02
    if not bool(context["has_own_quote"]) and float(context["live_quote_count"]) <= 0.125:
        return 0.05
    return 0.18


def _take_bc_weight(decision: Dict, context: Dict[str, float | bool], entries: List[Dict]) -> float:
    if not entries and decision["type"] != "taker_action":
        return 0.0
    edge = float(context["best_take_edge"])
    if decision["type"] == "taker_action":
        return 3.4 + max(0.0, edge) * 2.4 + (0.6 if bool(context["mid_round"]) else 0.0)
    if edge > 0.04:
        return 0.01
    return 0.18


def _reveal_bc_weight(decision: Dict, context: Dict[str, float | bool]) -> float:
    reveal_possible = bool(context["reveal_possible"])
    if not reveal_possible and decision["type"] != "request_next_reveal":
        return 0.0
    if decision["type"] == "request_next_reveal":
        return 1.5
    return 0.2


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
    if action_index == 0:
        if edge > 0.03:
            return -0.32 - edge * 1.65 - (0.08 if mid_round else 0.0)
        return -0.04 if mid_round and float(context["live_quote_count"]) > 0.125 else 0.02
    return 0.14 + max(0.0, selected_edge) * 2.1 - max(0.0, -selected_edge) * 1.8 + (0.06 if mid_round else 0.0)


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
    base = base_feature_vector(state, player_id, now_step)
    best_take = _best_teacher_take(base)
    reveal_possible = _reveal_possible(state, player_id)

    if profile == "aggressive":
        if best_take and (best_take["edge"] > -0.01 or rng.random() < 0.35):
            return {"type": "taker_action", "payload": {"targetPlayerId": best_take["targetPlayerId"], "action": best_take["action"]}}
        if reveal_possible and base["values"][3] >= 0.35 and rng.random() < 0.28:
            return {"type": "request_next_reveal", "payload": {}}

    if profile == "reveal":
        if reveal_possible and (base["values"][3] >= 0.2 or not base["quotes"] or rng.random() < 0.2):
            return {"type": "request_next_reveal", "payload": {}}
        if best_take and best_take["edge"] > 0.0 and rng.random() < 0.45:
            return {"type": "taker_action", "payload": {"targetPlayerId": best_take["targetPlayerId"], "action": best_take["action"]}}

    if profile == "patient":
        if best_take and best_take["edge"] > 0.08:
            return {"type": "taker_action", "payload": {"targetPlayerId": best_take["targetPlayerId"], "action": best_take["action"]}}
        if reveal_possible and base["values"][3] >= 0.55 and rng.random() < 0.18:
            return {"type": "request_next_reveal", "payload": {}}
        if base["own_quote"] and rng.random() < 0.35:
            return {"type": "wait", "payload": {}}

    if profile == "opportunistic":
        if best_take and (best_take["edge"] > 0.025 or (now_step >= 1 and rng.random() < 0.35)):
            return {"type": "taker_action", "payload": {"targetPlayerId": best_take["targetPlayerId"], "action": best_take["action"]}}
        if reveal_possible and base["values"][3] >= 0.45 and rng.random() < 0.22:
            return {"type": "request_next_reveal", "payload": {}}

    if profile == "maker":
        if best_take and best_take["edge"] > 0.09:
            return {"type": "taker_action", "payload": {"targetPlayerId": best_take["targetPlayerId"], "action": best_take["action"]}}
        if base["own_quote"] and base["own_quote_age_ratio"] < 0.55 and rng.random() < 0.45:
            return {"type": "wait", "payload": {}}

    decision = heuristic_decision(state, player_id, now_step)
    if best_take and decision["type"] in {"wait", "submit_quote"} and best_take["edge"] > 0.025 and rng.random() < 0.3:
        return {"type": "taker_action", "payload": {"targetPlayerId": best_take["targetPlayerId"], "action": best_take["action"]}}
    if reveal_possible and decision["type"] == "wait" and base["values"][3] >= 0.4 and rng.random() < 0.15:
        return {"type": "request_next_reveal", "payload": {}}
    return decision


def _accumulate_bc_example(
    policy: LinearCardPolicy,
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
    noop_index = next(index for index, template in enumerate(policy.quote_templates) if template["id"] == "noop")

    quote_sampled = policy.choose_quote(state, player_id, now_step)
    quote_action_index = noop_index
    if decision["type"] == "submit_quote" and decision.get("payload"):
        template_id = decision.get("templateId") or "mid_1"
        quote_action_index = next(
            (index for index, template in enumerate(policy.quote_templates) if template["id"] == template_id),
            noop_index,
        )
    quote_weight = _quote_bc_weight(decision, context)
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

    take_sampled = policy.choose_take(state, player_id, now_step)
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
    take_weight = _take_bc_weight(decision, context, take_sampled["entries"])
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

    reveal_sampled = policy.choose_reveal(state, player_id, now_step)
    reveal_vote = decision["type"] == "request_next_reveal"
    reveal_weight = _reveal_bc_weight(decision, context)
    if reveal_weight > 0.0:
        policy.accumulate_reveal_gradient(
            gradients,
            reveal_sampled["base"]["values"],
            reveal_sampled["probability"],
            reveal_vote,
            reveal_weight,
        )
    if reveal_weight > 0.0 and reveal_vote:
        stats["reveal"] += 1
    stats["examples"] += 1


def _collect_bc_gradients_chunk(args: Dict) -> Dict:
    policy = LinearCardPolicy.from_dict(args["policy"])
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
            return {"type": decision["type"], "payload": decision.get("payload", {})}

        simulator.run_episode(seat_count, actor)
    return {
        "episodes": count,
        "gradients": gradients,
        "stats": stats,
    }


def warm_start_behavior_cloning(policy: LinearCardPolicy, episodes: int, seat_counts: List[int], seed: int, workers: int, lr: float = 0.015) -> None:
    progress = ProgressBar("BC Warmstart", episodes)
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
    counts = {"current": 0, "historical": 0, "bootstrap": 0, "teacher": 0, "heuristic": 0}
    for role in seat_roles.values():
        counts[role["kind"]] = counts.get(role["kind"], 0) + 1
    return (
        f"cur {counts['current']} hist {counts['historical']} "
        f"boot {counts['bootstrap']} teach {counts['teacher']} heur {counts['heuristic']}"
    )


def _sample_opponent_role(
    rng: random.Random,
    historical_pool: List[LinearCardPolicy],
    teacher_rng_seed: int,
) -> Dict:
    roll = rng.random()
    if historical_pool and roll < 0.22:
        return {"kind": "historical", "policy": rng.choice(historical_pool)}
    if roll < 0.4:
        return {"kind": "bootstrap", "policy": bootstrap_policy()}
    if roll < 0.88:
        return {
            "kind": "teacher",
            "profile": _sample_teacher_profile(rng),
            "rng": random.Random(teacher_rng_seed),
        }
    return {"kind": "heuristic"}


def _build_seat_roles(
    *,
    current_policy: LinearCardPolicy,
    historical_pool: List[LinearCardPolicy],
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
            teacher_rng_seed=seed * 101 + index * 37 + 11,
        )
    return seat_roles


def _actor_decision_for_role(role: Dict, state: Dict, player_id: str, now_step: int) -> Dict:
    kind = role["kind"]
    if kind in {"current", "historical", "bootstrap"}:
        seat_policy = role["policy"]
        take = seat_policy.choose_take(state, player_id, now_step)
        quote = seat_policy.choose_quote(state, player_id, now_step)
        reveal = seat_policy.choose_reveal(state, player_id, now_step)
        return _resolve_sampled_action(take, quote, reveal)
    if kind == "teacher":
        return _teacher_decision(state, player_id, now_step, role["rng"], role["profile"])
    return heuristic_decision(state, player_id, now_step)


def _build_actor(policy: LinearCardPolicy, trajectories: List[Dict], seat_roles: Dict[str, Dict]):
    def actor(state: Dict, player_id: str, now_step: int) -> Dict:
        role = seat_roles[player_id]
        if role["kind"] == "current":
            seat_policy = role["policy"]
            take = seat_policy.choose_take(state, player_id, now_step)
            quote = seat_policy.choose_quote(state, player_id, now_step)
            reveal = seat_policy.choose_reveal(state, player_id, now_step)
            choice = _resolve_sampled_action(take, quote, reveal)
            base = take["base"]
            trajectories.append(
                {
                    "player_id": player_id,
                    "base_values": list(base["values"]),
                    "context": _training_context(base, state, player_id),
                    "selected_take_edge": _selected_take_edge(take),
                    "quote_action_index": int(quote["template_index"]),
                    "quote_features": quote["features"],
                    "quote_probabilities": quote["probabilities"],
                    "take_action_index": int(take["action_index"]),
                    "take_features": take["features"],
                    "take_probabilities": take["probabilities"],
                    "reveal_vote": bool(reveal["vote"]),
                    "reveal_probability": float(reveal["probability"]),
                }
            )
        else:
            choice = _actor_decision_for_role(role, state, player_id, now_step)
        return {"type": choice["type"], "payload": choice.get("payload", {})}

    return actor


def _accumulate_ppo_item(policy: LinearCardPolicy, gradients: Dict, item: Dict, reward: float, noop_index: int) -> None:
    base_values = item["base_values"]
    context = item["context"]
    advantage = reward - policy.value(base_values)
    quote_advantage = advantage * 0.12 + _quote_bonus(int(item["quote_action_index"]), noop_index, context)
    take_advantage = advantage * 0.22 + _take_bonus(
        int(item["take_action_index"]),
        context,
        float(item["selected_take_edge"]),
    )
    reveal_advantage = advantage * 0.08 + _reveal_bonus(bool(item["reveal_vote"]), context)
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
        base_values,
        float(item["reveal_probability"]),
        bool(item["reveal_vote"]),
        reveal_advantage * 0.5,
    )
    policy.accumulate_value_gradient(gradients, base_values, reward, scale=0.5)


def _simulate_parallel_episode(args: Dict) -> Dict:
    episode_index = int(args["episode_index"])
    total_episodes = int(args["total_episodes"])
    seed = _episode_seed(int(args["seed"]), episode_index)
    random.seed(seed)
    current_policy = LinearCardPolicy.from_dict(args["current_policy"])
    historical_pool = [LinearCardPolicy.from_dict(entry) for entry in args["historical_pool"]]
    simulator = CardMarketSimulator(seed=seed)
    curriculum = [2, 4, 6, 8, 10]
    seat_count = curriculum[min(len(curriculum) - 1, episode_index * len(curriculum) // max(1, total_episodes))]
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
            take = seat_policy.choose_take(state, player_id, now_step)
            quote = seat_policy.choose_quote(state, player_id, now_step)
            reveal = seat_policy.choose_reveal(state, player_id, now_step)
            choice = _resolve_sampled_action(take, quote, reveal)
            base = take["base"]
            trajectories.append(
                {
                    "player_id": player_id,
                    "base_values": list(base["values"]),
                    "context": _training_context(base, state, player_id),
                    "selected_take_edge": _selected_take_edge(take),
                    "quote_action_index": int(quote["template_index"]),
                    "quote_features": quote["features"],
                    "quote_probabilities": quote["probabilities"],
                    "take_action_index": int(take["action_index"]),
                    "take_features": take["features"],
                    "take_probabilities": take["probabilities"],
                    "reveal_vote": bool(reveal["vote"]),
                    "reveal_probability": float(reveal["probability"]),
                }
            )
        else:
            choice = _actor_decision_for_role(role, state, player_id, now_step)
        return {"type": choice["type"], "payload": choice.get("payload", {})}

    _, summary = simulator.run_episode(seat_count, actor)
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


def ppo_self_play(policy: LinearCardPolicy, episodes: int, seed: int, workers: int, lr: float = 0.01) -> None:
    historical_pool = [policy.copy()]
    curriculum = [2, 4, 6, 8, 10]
    progress = ProgressBar("PPO SelfPlay", episodes)
    running_reward = 0.0
    noop_index = next(index for index, template in enumerate(policy.quote_templates) if template["id"] == "noop")
    if episodes <= 0:
        progress.finish(detail="avg reward 0.000")
        return

    if workers <= 1:
        simulator = CardMarketSimulator(seed=seed)
        for episode in range(episodes):
            seat_count = curriculum[min(len(curriculum) - 1, episode * len(curriculum) // max(1, episodes))]
            seat_ids = [f"seat-{index + 1}" for index in range(seat_count)]
            trajectories: List[Dict] = []
            seat_roles = _build_seat_roles(
                current_policy=policy,
                historical_pool=historical_pool,
                seat_ids=seat_ids,
                seed=_episode_seed(seed + 41, episode),
            )
            actor = _build_actor(policy, trajectories, seat_roles)
            _, summary = simulator.run_episode(seat_count, actor)
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a card-market RL policy.")
    parser.add_argument("--bc-episodes", type=int, default=50_000)
    parser.add_argument("--ppo-episodes", type=int, default=50_000)
    parser.add_argument("--workers", type=int, default=default_worker_count())
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--out", type=Path, default=Path("workers/src/card-rl-policy-data.js"))
    parser.add_argument("--version", type=str, default="local-card-policy")
    args = parser.parse_args()

    random.seed(args.seed)
    workers = max(1, int(args.workers))
    print(
        f"Seed {args.seed} | bc episodes {args.bc_episodes} | ppo episodes {args.ppo_episodes} | workers {workers}",
        flush=True,
    )
    policy = bootstrap_policy()
    warm_start_behavior_cloning(policy, args.bc_episodes, [2, 4, 6, 8, 10], args.seed, workers)
    ppo_self_play(policy, args.ppo_episodes, args.seed, workers)
    export_js_module(policy, args.out, version=args.version)
    print(f"Wrote card policy to {args.out}")


if __name__ == "__main__":
    main()
