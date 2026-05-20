from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from multiprocessing import get_context
from pathlib import Path
from typing import Callable

from .features import base_feature_vector
from .heuristic import (
    BASELINE_BALANCED,
    BASELINE_MAKER_PUBLIC_MID,
    BASELINE_WAIT,
    decision_for_baseline,
    heuristic_decision,
    quote_toxicity,
)
from .model import bootstrap_neural_policy, bootstrap_policy, policy_from_dict
from .simulator import CardMarketSimulator, IncentiveSchedule, ROLE_BALANCE_SEAT_ROLES

ROLE_BALANCE_ACTIVITY_FLOORS = {
    "maker_quote_rate": 0.40,
    "taker_take_rate_min": 0.10,
    "taker_take_rate_max": 0.35,
}


def maker_markout_floor(seat_count: int) -> float:
    return -0.75 - max(0, int(seat_count) - 6) * 0.10


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


def _batch_size(total_episodes: int, workers: int, cap: int = 256) -> int:
    return max(1, min(cap, max(1, total_episodes // max(1, workers * 8))))


def _split_worker_budget(total_workers: int, task_count: int) -> list[int]:
    total_workers = max(1, int(total_workers))
    task_count = max(1, int(task_count))
    base = total_workers // task_count
    remainder = total_workers % task_count
    return [max(1, base + (1 if index < remainder else 0)) for index in range(task_count)]


def _open_parallel_executor(workers: int):
    if workers <= 1:
        return None, "sequential"
    try:
        mp_context = get_context("spawn")
        return ProcessPoolExecutor(max_workers=workers, mp_context=mp_context), "process"
    except (OSError, PermissionError):
        return ThreadPoolExecutor(max_workers=workers), "thread"


def role_balance_incentive_grid() -> list[dict[str, float]]:
    schedules = [
        IncentiveSchedule().to_dict(),
    ]
    fill_rates = [0.0005, 0.001, 0.002, 0.003]
    pass_rates = [0.0, 0.00075]
    for fill_rate in fill_rates:
        for pass_rate in pass_rates:
            schedules.append(
                IncentiveSchedule(
                    maker_fill_rebate=fill_rate,
                    taker_fill_fee=fill_rate,
                    wide_quote_pass_penalty=pass_rate,
                    tight_quote_refusal_penalty=pass_rate,
                ).to_dict()
            )
            schedules.append(
                IncentiveSchedule(
                    maker_fill_rebate=-fill_rate,
                    taker_fill_fee=-fill_rate,
                    wide_quote_pass_penalty=pass_rate,
                    tight_quote_refusal_penalty=pass_rate,
                ).to_dict()
            )
    deduped = []
    seen = set()
    for schedule in schedules:
        key = tuple(sorted((name, round(float(value), 8)) for name, value in schedule.items()))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(schedule)
    return deduped


def _empty_metric_bucket() -> dict:
    return {
        "episodes": 0,
        "sum": 0.0,
        "sum_sq": 0.0,
        "inventory_sum": 0.0,
        "abs_inventory_sum": 0.0,
        "action_quote": 0,
        "action_take": 0,
        "action_reveal": 0,
        "action_wait": 0,
        "take_buy": 0,
        "take_sell": 0,
        "take_pass": 0,
        "decision_count": 0,
        "take_opportunity": 0,
        "missed_take": 0,
        "maker_volume": 0,
        "taker_volume": 0,
        "maker_markout_sum": 0.0,
        "taker_markout_sum": 0.0,
        "quote_mid_sum": 0.0,
        "quote_mid_sum_sq": 0.0,
        "quote_mid_count": 0,
        "quote_toxicity_sum": 0.0,
        "quote_toxicity_count": 0,
        "toxic_quote_count": 0,
    }


def _merge_metric_bucket(target: dict, payload: dict) -> None:
    for key, value in payload.items():
        target[key] = target.get(key, 0) + value


def _empty_role_balance_bucket() -> dict:
    return {
        "episodes": 0,
        "maker_pnl_sum": 0.0,
        "maker_pnl_sum_sq": 0.0,
        "taker_pnl_sum": 0.0,
        "taker_pnl_sum_sq": 0.0,
        "maker_decisions": 0,
        "maker_quotes": 0,
        "maker_reveals": 0,
        "maker_waits": 0,
        "taker_decisions": 0,
        "taker_takes": 0,
        "taker_reveals": 0,
        "taker_waits": 0,
        "fill_count": 0,
        "maker_volume": 0,
        "taker_volume": 0,
        "maker_markout_sum": 0.0,
        "taker_markout_sum": 0.0,
        "maker_incentive_sum": 0.0,
        "taker_fee_sum": 0.0,
        "maker_pass_penalty_sum": 0.0,
        "taker_pass_penalty_sum": 0.0,
    }


def _role_balance_summary(metrics: dict) -> dict:
    episodes = max(1, int(metrics["episodes"]))
    maker_mean = float(metrics["maker_pnl_sum"]) / episodes
    taker_mean = float(metrics["taker_pnl_sum"]) / episodes
    maker_var = max(0.0, (float(metrics["maker_pnl_sum_sq"]) / episodes) - maker_mean * maker_mean)
    taker_var = max(0.0, (float(metrics["taker_pnl_sum_sq"]) / episodes) - taker_mean * taker_mean)
    maker_stdev = math.sqrt(maker_var)
    taker_stdev = math.sqrt(taker_var)
    maker_ci95 = 1.96 * maker_stdev / math.sqrt(episodes)
    taker_ci95 = 1.96 * taker_stdev / math.sqrt(episodes)
    maker_decisions = max(1, int(metrics["maker_decisions"]))
    taker_decisions = max(1, int(metrics["taker_decisions"]))
    maker_quote_rate = float(metrics["maker_quotes"]) / maker_decisions
    taker_take_rate = float(metrics["taker_takes"]) / taker_decisions
    parity_gap = max(abs(maker_mean), abs(taker_mean))
    quote_shortfall = max(0.0, ROLE_BALANCE_ACTIVITY_FLOORS["maker_quote_rate"] - maker_quote_rate)
    take_shortfall = max(0.0, ROLE_BALANCE_ACTIVITY_FLOORS["taker_take_rate_min"] - taker_take_rate)
    take_excess = max(0.0, taker_take_rate - ROLE_BALANCE_ACTIVITY_FLOORS["taker_take_rate_max"])
    activity_penalty = (quote_shortfall + take_shortfall + take_excess) * 8.0
    return {
        "episodes": episodes,
        "maker_mean_pnl": maker_mean,
        "maker_ci95": maker_ci95,
        "maker_stdev": maker_stdev,
        "taker_mean_pnl": taker_mean,
        "taker_ci95": taker_ci95,
        "taker_stdev": taker_stdev,
        "fills_per_episode": float(metrics["fill_count"]) / episodes,
        "maker_quote_rate": maker_quote_rate,
        "maker_reveal_rate": float(metrics["maker_reveals"]) / maker_decisions,
        "maker_wait_rate": float(metrics["maker_waits"]) / maker_decisions,
        "taker_take_rate": taker_take_rate,
        "taker_reveal_rate": float(metrics["taker_reveals"]) / taker_decisions,
        "taker_wait_rate": float(metrics["taker_waits"]) / taker_decisions,
        "maker_markout": float(metrics["maker_markout_sum"]) / max(1, int(metrics["maker_volume"])),
        "taker_markout": float(metrics["taker_markout_sum"]) / max(1, int(metrics["taker_volume"])),
        "maker_fill_incentive_per_episode": float(metrics["maker_incentive_sum"]) / episodes,
        "taker_fill_fee_per_episode": float(metrics["taker_fee_sum"]) / episodes,
        "maker_pass_penalty_per_episode": float(metrics["maker_pass_penalty_sum"]) / episodes,
        "taker_pass_penalty_per_episode": float(metrics["taker_pass_penalty_sum"]) / episodes,
        "parity_gap": parity_gap,
        "activity_ok": quote_shortfall <= 0.0 and take_shortfall <= 0.0 and take_excess <= 0.0,
        "quote_collapse": maker_quote_rate < ROLE_BALANCE_ACTIVITY_FLOORS["maker_quote_rate"],
        "taker_overtrade": taker_take_rate > ROLE_BALANCE_ACTIVITY_FLOORS["taker_take_rate_max"],
        "taker_undertrade": taker_take_rate < ROLE_BALANCE_ACTIVITY_FLOORS["taker_take_rate_min"],
        "objective": parity_gap + activity_penalty,
    }


def _policy_actor(kind: str, policy_data: dict | None) -> Callable[[dict, str, int], dict]:
    if kind == "heuristic":
        return heuristic_decision
    if kind.startswith("baseline:"):
        baseline_id = kind.split(":", 1)[1]
        return lambda state, player_id, now_step: decision_for_baseline(baseline_id, state, player_id, now_step)
    if policy_data is None:
        raise ValueError("Linear policy evaluation requires policy data.")
    policy = policy_from_dict(policy_data)
    return lambda state, player_id, now_step: policy.choose_action(state, player_id, now_step)


def _evaluate_role_balance_chunk(args: dict) -> dict:
    episodes = int(args["episodes"])
    seed = int(args["seed"])
    maker_policy_kind = str(args["maker_policy_kind"])
    taker_policy_kind = str(args["taker_policy_kind"])
    maker_policy = args.get("maker_policy")
    taker_policy = args.get("taker_policy")
    schedule = IncentiveSchedule.from_dict(args.get("incentive_schedule"))
    simulator = CardMarketSimulator(seed=seed, incentive_schedule=schedule)
    metrics = _empty_role_balance_bucket()
    maker_actor = _policy_actor(maker_policy_kind, maker_policy)
    taker_actor = _policy_actor(taker_policy_kind, taker_policy)

    for _ in range(episodes):
        def maker_wrapper(state: dict, player_id: str, now_step: int) -> dict:
            decision = maker_actor(state, player_id, now_step)
            decision_type = decision.get("type", "wait")
            metrics["maker_decisions"] += 1
            if decision_type == "submit_quote":
                metrics["maker_quotes"] += 1
            elif decision_type == "request_next_reveal":
                metrics["maker_reveals"] += 1
            else:
                metrics["maker_waits"] += 1
            return {"type": decision_type, "payload": decision.get("payload", {})}

        def taker_wrapper(state: dict, player_id: str, now_step: int) -> dict:
            decision = taker_actor(state, player_id, now_step)
            decision_type = decision.get("type", "wait")
            metrics["taker_decisions"] += 1
            if decision_type == "taker_action":
                metrics["taker_takes"] += 1
            elif decision_type == "request_next_reveal":
                metrics["taker_reveals"] += 1
            else:
                metrics["taker_waits"] += 1
            return {"type": decision_type, "payload": decision.get("payload", {})}

        state, summary = simulator.run_episode(
            2,
            {"seat-1": maker_wrapper, "seat-2": taker_wrapper},
            role_constraints=ROLE_BALANCE_SEAT_ROLES,
            incentive_schedule=schedule,
        )
        maker_pnl = float(summary.risk_adjusted_pnl["seat-1"])
        taker_pnl = float(summary.risk_adjusted_pnl["seat-2"])
        settlement = float(summary.settlement)
        metrics["episodes"] += 1
        metrics["maker_pnl_sum"] += maker_pnl
        metrics["maker_pnl_sum_sq"] += maker_pnl * maker_pnl
        metrics["taker_pnl_sum"] += taker_pnl
        metrics["taker_pnl_sum_sq"] += taker_pnl * taker_pnl
        for entry in state.get("log", []):
            if entry.get("type") == "trade":
                qty = int(entry.get("qty", 0))
                price = float(entry.get("price", 0.0))
                side = str(entry.get("action", "buy"))
                metrics["fill_count"] += qty
                metrics["maker_volume"] += qty
                metrics["taker_volume"] += qty
                metrics["maker_incentive_sum"] += float(entry.get("maker_incentive", 0.0))
                metrics["taker_fee_sum"] += float(entry.get("taker_fee", 0.0))
                metrics["maker_markout_sum"] += qty * (price - settlement if side == "buy" else settlement - price)
                metrics["taker_markout_sum"] += qty * (settlement - price if side == "buy" else price - settlement)
            elif entry.get("type") == "pass":
                metrics["maker_pass_penalty_sum"] += float(entry.get("maker_pass_penalty", 0.0))
                metrics["taker_pass_penalty_sum"] += float(entry.get("taker_pass_penalty", 0.0))

    return {"metrics": metrics}


def _evaluate_chunk(args: dict) -> dict:
    seat_count = int(args["seat_count"])
    episodes = int(args["episodes"])
    seed = int(args["seed"])
    policy_kind = str(args["policy_kind"])
    policy_data = args.get("policy")
    simulator = CardMarketSimulator(seed=seed)
    metrics = _empty_metric_bucket()

    for _ in range(episodes):
        seat_ids = [f"seat-{index + 1}" for index in range(seat_count)]
        tracked_player_id = seat_ids[0]
        tracked_actor = _policy_actor(policy_kind, policy_data)

        def tracked_wrapper(state: dict, player_id: str, now_step: int) -> dict:
            base = base_feature_vector(state, player_id, now_step)
            best_take_edge = max(float(base["values"][6]), float(base["values"][7]))
            decision = tracked_actor(state, player_id, now_step)
            decision_type = decision.get("type", "wait")
            metrics["decision_count"] += 1
            if best_take_edge > 0.03:
                metrics["take_opportunity"] += 1
                if decision_type != "taker_action":
                    metrics["missed_take"] += 1
            if decision_type == "submit_quote":
                metrics["action_quote"] += 1
                payload = decision.get("payload", {})
                if payload and payload.get("bid") is not None and payload.get("ask") is not None:
                    midpoint = (float(payload["bid"]) + float(payload["ask"])) / 2.0
                    metrics["quote_mid_sum"] += midpoint
                    metrics["quote_mid_sum_sq"] += midpoint * midpoint
                    metrics["quote_mid_count"] += 1
                    toxicity = quote_toxicity(base, payload)
                    metrics["quote_toxicity_sum"] += toxicity
                    metrics["quote_toxicity_count"] += 1
                    if toxicity > 0.2:
                        metrics["toxic_quote_count"] += 1
            elif decision_type == "taker_action":
                metrics["action_take"] += 1
                action = decision.get("payload", {}).get("action", "pass")
                if action == "buy":
                    metrics["take_buy"] += 1
                elif action == "sell":
                    metrics["take_sell"] += 1
                else:
                    metrics["take_pass"] += 1
            elif decision_type == "request_next_reveal":
                metrics["action_reveal"] += 1
            else:
                metrics["action_wait"] += 1
            return {"type": decision_type, "payload": decision.get("payload", {})}

        seat_policies = {tracked_player_id: tracked_wrapper}
        for player_id in seat_ids[1:]:
            seat_policies[player_id] = heuristic_decision

        state, summary = simulator.run_episode(seat_count, seat_policies)
        score = float(summary.risk_adjusted_pnl[tracked_player_id])
        inventory = float(state["positions"][tracked_player_id]["inventory"])
        settlement = float(summary.settlement)
        for entry in state.get("log", []):
            if entry.get("type") != "trade":
                continue
            qty = int(entry.get("qty", 0))
            price = float(entry.get("price", 0.0))
            if entry.get("maker_player_id") == tracked_player_id:
                metrics["maker_volume"] += qty
                metrics["maker_markout_sum"] += qty * (price - settlement if entry.get("action") == "buy" else settlement - price)
            if entry.get("taker_player_id") == tracked_player_id:
                metrics["taker_volume"] += qty
                metrics["taker_markout_sum"] += qty * (settlement - price if entry.get("action") == "buy" else price - settlement)
        metrics["episodes"] += 1
        metrics["sum"] += score
        metrics["sum_sq"] += score * score
        metrics["inventory_sum"] += inventory
        metrics["abs_inventory_sum"] += abs(inventory)

    return {
        "seat_count": seat_count,
        "metrics": metrics,
    }


def load_exported_registry(path: Path) -> dict:
    text = path.read_text(encoding="utf-8").strip()
    registry_prefix = "export const CARD_RL_POLICY_REGISTRY = "
    if text.startswith(registry_prefix):
        return json.loads(text[len(registry_prefix) :].rstrip(";\n"))
    legacy_prefix = "export const CARD_RL_POLICY = "
    if text.startswith(legacy_prefix):
        payload = json.loads(text[len(legacy_prefix) :].rstrip(";\n"))
        policy_id = str(payload.get("metadata", {}).get("version", "linear-v1"))
        return {
            "metadata": {
                "source": payload.get("metadata", {}).get("source", "legacy"),
                "compatibilityVersion": payload.get("metadata", {}).get("compatibilityVersion", 1),
                "defaultPolicyIds": {"linear": policy_id},
            },
            "policies": {
                policy_id: {
                    "id": policy_id,
                    "family": "linear",
                    "version": policy_id,
                    "compatibilityVersion": payload.get("metadata", {}).get("compatibilityVersion", 1),
                    "source": payload.get("metadata", {}).get("source", "legacy"),
                    "evaluation": {},
                    "model": payload["model"],
                }
            },
        }
    try:
        resolved_path = path.resolve().as_uri()
        output = subprocess.check_output(
            [
                "node",
                "--input-type=module",
                "-e",
                (
                    f"import {{ CARD_RL_POLICY_REGISTRY }} from {json.dumps(resolved_path)};"
                    "console.log(JSON.stringify(CARD_RL_POLICY_REGISTRY));"
                ),
            ],
            text=True,
        ).strip()
        if output:
            return json.loads(output)
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError):
        pass
    raise ValueError(f"{path} is not a card RL export module.")


def _evaluate_policy(
    *,
    name: str,
    policy_kind: str,
    policy_data: dict | None,
    episodes: int,
    seat_counts: list[int],
    workers: int,
    seed: int,
    progress_label: str,
    show_progress: bool = True,
) -> tuple[dict[int, dict], str]:
    totals = {seat_count: _empty_metric_bucket() for seat_count in seat_counts}
    batch_size = _batch_size(episodes, workers)
    jobs = []
    offset = 0
    for seat_count in seat_counts:
        remaining = episodes
        while remaining > 0:
            chunk = min(batch_size, remaining)
            jobs.append(
                {
                    "policy_kind": policy_kind,
                    "policy": policy_data,
                    "seat_count": seat_count,
                    "episodes": chunk,
                    "seed": seed * 10_000 + seat_count * 257 + offset * 17,
                }
            )
            remaining -= chunk
            offset += 1

    progress = ProgressBar(progress_label, len(jobs)) if show_progress else NullProgressBar()
    if not jobs:
        progress.finish(detail="no jobs")
        return {}, "sequential"

    if workers <= 1:
        mode = "sequential"
        for index, job in enumerate(jobs, start=1):
            payload = _evaluate_chunk(job)
            _merge_metric_bucket(totals[payload["seat_count"]], payload["metrics"])
            progress.update(index, detail=f"seat {payload['seat_count']} | eps {payload['metrics']['episodes']}")
        progress.finish(detail=mode)
    else:
        executor_info = _open_parallel_executor(workers)
        if executor_info[0] is None:
            progress.finish(detail="no executor")
            return {}, "sequential"
        executor, mode = executor_info
        completed = 0
        with executor:
            futures = [executor.submit(_evaluate_chunk, job) for job in jobs]
            for future in as_completed(futures):
                payload = future.result()
                _merge_metric_bucket(totals[payload["seat_count"]], payload["metrics"])
                completed += 1
                progress.update(
                    completed,
                    detail=f"{mode} workers | seat {payload['seat_count']} | eps {payload['metrics']['episodes']}",
                )
        progress.finish(detail=mode)

    summary = {}
    for seat_count, bucket in totals.items():
        episodes_count = max(1, int(bucket["episodes"]))
        mean = float(bucket["sum"]) / episodes_count
        variance = max(0.0, (float(bucket["sum_sq"]) / episodes_count) - mean * mean)
        stdev = math.sqrt(variance)
        ci95 = 1.96 * stdev / math.sqrt(episodes_count)
        decisions = max(1, int(bucket["decision_count"]))
        summary[seat_count] = {
            "name": name,
            "episodes": episodes_count,
            "mean": mean,
            "stdev": stdev,
            "ci95": ci95,
            "mean_inventory": float(bucket["inventory_sum"]) / episodes_count,
            "mean_abs_inventory": float(bucket["abs_inventory_sum"]) / episodes_count,
            "quote_rate": bucket["action_quote"] / decisions,
            "take_rate": bucket["action_take"] / decisions,
            "reveal_rate": bucket["action_reveal"] / decisions,
            "wait_rate": bucket["action_wait"] / decisions,
            "buy_rate": bucket["take_buy"] / decisions,
            "sell_rate": bucket["take_sell"] / decisions,
            "pass_rate": bucket["take_pass"] / decisions,
            "take_opportunity_rate": bucket["take_opportunity"] / decisions,
            "missed_take_rate": bucket["missed_take"] / max(1, bucket["take_opportunity"]),
            "maker_volume_per_episode": bucket["maker_volume"] / episodes_count,
            "taker_volume_per_episode": bucket["taker_volume"] / episodes_count,
            "maker_markout": bucket["maker_markout_sum"] / max(1, bucket["maker_volume"]),
            "taker_markout": bucket["taker_markout_sum"] / max(1, bucket["taker_volume"]),
            "quote_mid_dispersion": math.sqrt(
                max(
                    0.0,
                    (float(bucket["quote_mid_sum_sq"]) / max(1, bucket["quote_mid_count"]))
                    - (float(bucket["quote_mid_sum"]) / max(1, bucket["quote_mid_count"])) ** 2,
                )
            ),
            "quote_toxicity": bucket["quote_toxicity_sum"] / max(1, bucket["quote_toxicity_count"]),
            "toxic_quote_rate": bucket["toxic_quote_count"] / max(1, bucket["quote_toxicity_count"]),
        }
    return summary, mode


def _evaluate_role_balance_policy(
    *,
    name: str,
    maker_policy_kind: str,
    maker_policy_data: dict | None,
    taker_policy_kind: str,
    taker_policy_data: dict | None,
    episodes: int,
    workers: int,
    seed: int,
    incentive_schedule: dict | None = None,
    progress_label: str,
    show_progress: bool = True,
) -> tuple[dict, str]:
    batch_size = _batch_size(episodes, workers, cap=128)
    jobs = []
    remaining = episodes
    offset = 0
    while remaining > 0:
        chunk = min(batch_size, remaining)
        jobs.append(
            {
                "episodes": chunk,
                "seed": seed * 10_000 + offset * 97 + 23,
                "maker_policy_kind": maker_policy_kind,
                "maker_policy": maker_policy_data,
                "taker_policy_kind": taker_policy_kind,
                "taker_policy": taker_policy_data,
                "incentive_schedule": incentive_schedule or {},
            }
        )
        remaining -= chunk
        offset += 1

    progress = ProgressBar(progress_label, len(jobs)) if show_progress else NullProgressBar()
    totals = _empty_role_balance_bucket()
    if not jobs:
        progress.finish(detail="no jobs")
        return _role_balance_summary(totals), "sequential"

    if workers <= 1:
        mode = "sequential"
        for index, job in enumerate(jobs, start=1):
            payload = _evaluate_role_balance_chunk(job)
            _merge_metric_bucket(totals, payload["metrics"])
            progress.update(index, detail=f"eps {payload['metrics']['episodes']}")
        progress.finish(detail=mode)
        return _role_balance_summary(totals), mode

    executor_info = _open_parallel_executor(workers)
    if executor_info[0] is None:
        progress.finish(detail="no executor")
        return _role_balance_summary(totals), "sequential"
    executor, mode = executor_info
    completed = 0
    with executor:
        futures = [executor.submit(_evaluate_role_balance_chunk, job) for job in jobs]
        for future in as_completed(futures):
            payload = future.result()
            _merge_metric_bucket(totals, payload["metrics"])
            completed += 1
            progress.update(completed, detail=f"{mode} | eps {payload['metrics']['episodes']}")
    progress.finish(detail=mode)
    return _role_balance_summary(totals), mode


def _choose_role_balance_schedule(
    *,
    name: str,
    policy_kind: str,
    policy_data: dict | None,
    episodes: int,
    workers: int,
    seed: int,
) -> tuple[dict, dict, list[dict]]:
    evaluations = []
    best_row = None
    for index, schedule in enumerate(role_balance_incentive_grid()):
        summary, mode = _evaluate_role_balance_policy(
            name=name,
            maker_policy_kind=policy_kind,
            maker_policy_data=policy_data,
            taker_policy_kind=policy_kind,
            taker_policy_data=policy_data,
            episodes=episodes,
            workers=workers,
            seed=seed + index * 37,
            incentive_schedule=schedule,
            progress_label=f"Bal {index + 1}",
            show_progress=False,
        )
        row = {
            "schedule": schedule,
            "summary": summary,
            "mode": mode,
            "objective": float(summary["objective"]),
            "activity_ok": bool(summary["activity_ok"]),
        }
        evaluations.append(row)
        if best_row is None:
            best_row = row
            continue
        if row["activity_ok"] and not best_row["activity_ok"]:
            best_row = row
            continue
        if row["activity_ok"] == best_row["activity_ok"] and row["objective"] < best_row["objective"] - 1e-12:
            best_row = row
    return best_row["schedule"], best_row["summary"], evaluations


def _print_summary_table(title: str, summary: dict[int, dict]) -> None:
    print("")
    print(title)
    for seat_count in sorted(summary):
        row = summary[seat_count]
        print(
            f"{seat_count} seats: {row['mean']:.3f} pnl"
            f" | ci95 +/-{row['ci95']:.3f}"
            f" | stdev {row['stdev']:.3f}"
            f" | avg |inv| {row['mean_abs_inventory']:.3f}"
        )


def _print_behavior_table(title: str, summary: dict[int, dict]) -> None:
    print("")
    print(title)
    for seat_count in sorted(summary):
        row = summary[seat_count]
        print(
            f"{seat_count} seats: quote {row['quote_rate'] * 100:5.1f}%"
            f" | take {row['take_rate'] * 100:5.1f}%"
            f" | reveal {row['reveal_rate'] * 100:5.1f}%"
            f" | wait {row['wait_rate'] * 100:5.1f}%"
            f" | buy {row['buy_rate'] * 100:5.1f}%"
            f" | sell {row['sell_rate'] * 100:5.1f}%"
            f" | pass {row['pass_rate'] * 100:5.1f}%"
            f" | opp {row['take_opportunity_rate'] * 100:5.1f}%"
            f" | missed {row['missed_take_rate'] * 100:5.1f}%"
            f" | maker vol {row['maker_volume_per_episode']:.2f}"
            f" | taker vol {row['taker_volume_per_episode']:.2f}"
            f" | maker mko {row['maker_markout']:.2f}"
            f" | taker mko {row['taker_markout']:.2f}"
            f" | tox {row.get('quote_toxicity', 0.0):.3f}"
            f" | q-disp {row['quote_mid_dispersion']:.2f}"
        )


def _print_behavior_alerts(title: str, summary: dict[int, dict]) -> None:
    low_take = [
        seat_count
        for seat_count, row in sorted(summary.items())
        if row["missed_take_rate"] > 0.7 and row["take_opportunity_rate"] > 0.03
    ]
    printed_header = False
    if low_take:
        seats = ", ".join(str(seat_count) for seat_count in low_take)
        print("")
        print(f"{title} Alerts")
        printed_header = True
        print(f"Low take-rate warning on seats: {seats}")

    maker_toxicity = [
        seat_count
        for seat_count, row in sorted(summary.items())
        if (row["maker_markout"] < maker_markout_floor(seat_count) and row["maker_volume_per_episode"] >= 0.5) or row.get("toxic_quote_rate", 0.0) > 0.18
    ]
    if maker_toxicity:
        if not printed_header:
            print("")
            print(f"{title} Alerts")
            printed_header = True
        toxic_seats = ", ".join(str(seat_count) for seat_count in maker_toxicity)
        print(f"Maker-toxicity warning on seats: {toxic_seats}")

    taker_overtrade = [
        seat_count
        for seat_count, row in sorted(summary.items())
        if row["take_rate"] > 0.45 and row["taker_markout"] < -0.1
    ]
    if taker_overtrade:
        if not printed_header:
            print("")
            print(f"{title} Alerts")
            printed_header = True
        overtrade_seats = ", ".join(str(seat_count) for seat_count in taker_overtrade)
        print(f"Taker-overtrade warning on seats: {overtrade_seats}")

    quote_absence = [
        seat_count
        for seat_count, row in sorted(summary.items())
        if row["quote_rate"] < 0.05 and row["take_rate"] > 0.25
    ]
    if quote_absence:
        if not printed_header:
            print("")
            print(f"{title} Alerts")
        quote_absence_seats = ", ".join(str(seat_count) for seat_count in quote_absence)
        print(f"Quote-absence warning on seats: {quote_absence_seats}")


def _print_role_balance_summary(title: str, summary: dict, schedule: dict | None = None) -> None:
    print("")
    print(title)
    if schedule is not None:
        print(
            "incentives:"
            f" maker_fill {float(schedule.get('maker_fill_rebate', 0.0)):.5f}"
            f" | taker_fill {float(schedule.get('taker_fill_fee', 0.0)):.5f}"
            f" | wide_pass {float(schedule.get('wide_quote_pass_penalty', 0.0)):.5f}"
            f" | tight_refusal {float(schedule.get('tight_quote_refusal_penalty', 0.0)):.5f}"
        )
    print(
        f"maker pnl {summary['maker_mean_pnl']:.3f} | ci95 +/-{summary['maker_ci95']:.3f}"
        f" | taker pnl {summary['taker_mean_pnl']:.3f} | ci95 +/-{summary['taker_ci95']:.3f}"
    )
    print(
        f"fills/ep {summary['fills_per_episode']:.2f}"
        f" | maker quote {summary['maker_quote_rate'] * 100:5.1f}%"
        f" | taker take {summary['taker_take_rate'] * 100:5.1f}%"
        f" | parity gap {summary['parity_gap']:.3f}"
    )
    print(
        f"maker mko {summary['maker_markout']:.3f}"
        f" | taker mko {summary['taker_markout']:.3f}"
        f" | maker fill/ep {summary['maker_fill_incentive_per_episode']:.3f}"
        f" | taker fee/ep {summary['taker_fill_fee_per_episode']:.3f}"
    )


def _print_role_balance_alerts(title: str, summary: dict) -> None:
    alerts = []
    if summary["quote_collapse"]:
        alerts.append("quote-collapse")
    if summary["taker_undertrade"]:
        alerts.append("taker-undertrade")
    if summary["taker_overtrade"]:
        alerts.append("taker-overtrade")
    if summary["maker_mean_pnl"] < -0.5 or summary["taker_mean_pnl"] > 0.5:
        alerts.append("taker-favored")
    elif summary["maker_mean_pnl"] > 0.5 or summary["taker_mean_pnl"] < -0.5:
        alerts.append("maker-favored")
    if not alerts:
        return
    print("")
    print(f"{title} Alerts")
    print(", ".join(alerts))


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate a card-market policy against heuristics.")
    parser.add_argument("--episodes", type=int, default=30)
    parser.add_argument("--role-balance-episodes", type=int, default=None)
    parser.add_argument("--policy", type=Path, default=Path("workers/src/card-rl-policy-registry-data.js"))
    parser.add_argument("--family", choices=["all", "linear", "neural"], default="all")
    parser.add_argument("--compare-bootstrap", action="store_true")
    parser.add_argument("--workers", type=int, default=default_worker_count())
    parser.add_argument("--seed", type=int, default=17)
    args = parser.parse_args()

    seat_counts = [2, 4, 6, 8, 10]
    workers = max(1, int(args.workers))
    role_balance_episodes = max(20, int(args.role_balance_episodes or max(20, args.episodes)))

    registry = load_exported_registry(args.policy)
    policy_entries = registry.get("policies", {})
    selected_policy_ids = []
    if args.family == "all":
        selected_policy_ids = list(dict.fromkeys((registry.get("metadata", {}).get("defaultPolicyIds", {}) or {}).values()))
        if not selected_policy_ids:
            selected_policy_ids = list(policy_entries.keys())
    else:
        preferred_id = registry.get("metadata", {}).get("defaultPolicyIds", {}).get(args.family)
        if preferred_id:
            selected_policy_ids = [preferred_id]
        else:
            selected_policy_ids = [policy_id for policy_id, entry in policy_entries.items() if entry.get("family") == args.family]

    print(f"Policy: {args.policy}")
    print(f"Workers: {workers}")
    eval_jobs = []
    for index, policy_id in enumerate(selected_policy_ids):
        entry = policy_entries.get(policy_id)
        if not entry:
            continue
        eval_jobs.append(
            {
                "key": policy_id,
                "display": policy_id,
                "family": entry.get("family", "unknown"),
                "name": policy_id,
                "policy_kind": "linear",
                "policy_data": entry["model"],
                "seed": args.seed + index * 131,
                "progress_label": f"Eval {entry.get('family', 'policy')}",
            }
        )

    if args.compare_bootstrap:
        eval_jobs.extend(
            [
                {
                    "key": "bootstrap-linear",
                    "display": "Bootstrap Policy",
                    "family": "bootstrap",
                    "name": "bootstrap-linear",
                    "policy_kind": "linear",
                    "policy_data": bootstrap_policy().to_dict(),
                    "seed": args.seed + 101,
                    "progress_label": "Eval boot",
                },
                {
                    "key": "bootstrap-neural",
                    "display": "Neural Bootstrap Policy",
                    "family": "bootstrap-neural",
                    "name": "bootstrap-neural",
                    "policy_kind": "linear",
                    "policy_data": bootstrap_neural_policy().to_dict(),
                    "seed": args.seed + 151,
                    "progress_label": "Eval neur",
                },
                {
                    "key": "wait-baseline",
                    "display": "Wait Baseline",
                    "family": "baseline",
                    "name": "wait-baseline",
                    "policy_kind": f"baseline:{BASELINE_WAIT}",
                    "policy_data": None,
                    "seed": args.seed + 181,
                    "progress_label": "Eval wait",
                },
                {
                    "key": "balanced-baseline",
                    "display": "Balanced Baseline",
                    "family": "baseline",
                    "name": "balanced-baseline",
                    "policy_kind": f"baseline:{BASELINE_BALANCED}",
                    "policy_data": None,
                    "seed": args.seed + 191,
                    "progress_label": "Eval baln",
                },
                {
                    "key": "public-maker-baseline",
                    "display": "Public Maker Baseline",
                    "family": "baseline",
                    "name": "public-maker-baseline",
                    "policy_kind": f"baseline:{BASELINE_MAKER_PUBLIC_MID}",
                    "policy_data": None,
                    "seed": args.seed + 196,
                    "progress_label": "Eval pmak",
                },
                {
                    "key": "heuristic",
                    "display": "Heuristic",
                    "family": "heuristic",
                    "name": "heuristic",
                    "policy_kind": "heuristic",
                    "policy_data": None,
                    "seed": args.seed + 202,
                    "progress_label": "Eval heur",
                },
            ]
        )

    if not eval_jobs:
        raise ValueError("No evaluation jobs were selected.")

    worker_allocations = [workers] * max(1, len(eval_jobs))
    results = {}
    if len(eval_jobs) > 1:
        print("Eval jobs:")
        print("Top-level jobs run sequentially; each job uses full internal parallelism.")
        for job, assigned_workers in zip(eval_jobs, worker_allocations):
            print(f"- {job['display']} | workers {assigned_workers} | seed {job['seed']}")
    if len(eval_jobs) <= 1:
        job = eval_jobs[0]
        summary, mode = _evaluate_policy(
            name=job["name"],
            policy_kind=job["policy_kind"],
            policy_data=job["policy_data"],
            episodes=args.episodes,
            seat_counts=seat_counts,
            workers=workers,
            seed=job["seed"],
            progress_label=job["progress_label"],
            show_progress=True,
        )
        results[job["key"]] = {
            "job": job,
            "summary": summary,
            "mode": mode,
            "workers": workers,
        }
    else:
        for job, assigned_workers in zip(eval_jobs, worker_allocations):
            summary, mode = _evaluate_policy(
                name=job["name"],
                policy_kind=job["policy_kind"],
                policy_data=job["policy_data"],
                episodes=args.episodes,
                seat_counts=seat_counts,
                workers=assigned_workers,
                seed=job["seed"],
                progress_label=job["progress_label"],
                show_progress=True,
            )
            mean_main = sum(summary[seat_count]["mean"] for seat_count in seat_counts) / max(1, len(seat_counts))
            print(
                f"Completed {job['display']} | {mode} | workers {assigned_workers} | "
                f"avg main pnl {mean_main:.3f}"
            )
            results[job["key"]] = {
                "job": job,
                "summary": summary,
                "mode": mode,
                "workers": assigned_workers,
            }

    family_summaries = {}
    for policy_id in selected_policy_ids:
        result = results.get(policy_id)
        if not result:
            continue
        summary = result["summary"]
        family_summaries[policy_id] = summary
        print(f"{policy_id}: family {result['job']['family']} ({result['mode']}, workers {result['workers']})")
        _print_summary_table(f"{policy_id} Summary", summary)
        _print_behavior_table(f"{policy_id} Behavior", summary)
        _print_behavior_alerts(policy_id, summary)

    role_balance_focus_key = next(
        (policy_id for policy_id in selected_policy_ids if results.get(policy_id, {}).get("job", {}).get("family") == "linear"),
        selected_policy_ids[0] if selected_policy_ids else eval_jobs[0]["key"],
    )
    role_balance_focus = results[role_balance_focus_key]
    chosen_schedule, chosen_focus_summary, sweep_rows = _choose_role_balance_schedule(
        name=role_balance_focus["job"]["name"],
        policy_kind=role_balance_focus["job"]["policy_kind"],
        policy_data=role_balance_focus["job"]["policy_data"],
        episodes=role_balance_episodes,
        workers=workers,
        seed=args.seed + 701,
    )
    print("")
    print(f"Role-balance sweep focus: {role_balance_focus_key}")
    for row in sweep_rows:
        schedule = row["schedule"]
        print(
            "  "
            f"fill {float(schedule.get('maker_fill_rebate', 0.0)):+.5f}"
            f" | pass {float(schedule.get('wide_quote_pass_penalty', 0.0)):+.5f}"
            f" | parity {row['summary']['parity_gap']:.3f}"
            f" | maker quote {row['summary']['maker_quote_rate'] * 100:5.1f}%"
            f" | taker take {row['summary']['taker_take_rate'] * 100:5.1f}%"
            f" | activity {'ok' if row['activity_ok'] else 'fail'}"
        )
    _print_role_balance_summary(f"{role_balance_focus_key} Role Balance", chosen_focus_summary, chosen_schedule)
    _print_role_balance_alerts(role_balance_focus_key, chosen_focus_summary)

    role_balance_jobs = list(selected_policy_ids)
    if args.compare_bootstrap:
        role_balance_jobs.extend(
            [
                "wait-baseline",
                "balanced-baseline",
                "public-maker-baseline",
                "heuristic",
            ]
        )
    seen_role_jobs = set()
    for job_key in role_balance_jobs:
        if job_key in seen_role_jobs or job_key not in results:
            continue
        seen_role_jobs.add(job_key)
        if job_key == role_balance_focus_key:
            continue
        result = results[job_key]
        summary, mode = _evaluate_role_balance_policy(
            name=result["job"]["name"],
            maker_policy_kind=result["job"]["policy_kind"],
            maker_policy_data=result["job"]["policy_data"],
            taker_policy_kind=result["job"]["policy_kind"],
            taker_policy_data=result["job"]["policy_data"],
            episodes=role_balance_episodes,
            workers=result["workers"],
            seed=result["job"]["seed"] + 809,
            incentive_schedule=chosen_schedule,
            progress_label=f"Role {job_key[:6]}",
            show_progress=True,
        )
        print(f"{job_key}: role balance ({mode}, workers {result['workers']})")
        _print_role_balance_summary(f"{job_key} Role Balance", summary, chosen_schedule)
        _print_role_balance_alerts(job_key, summary)

    if args.compare_bootstrap:
        bootstrap_result = results["bootstrap-linear"]
        neural_bootstrap_result = results["bootstrap-neural"]
        wait_result = results["wait-baseline"]
        balanced_result = results["balanced-baseline"]
        public_maker_result = results["public-maker-baseline"]
        heuristic_result = results["heuristic"]
        bootstrap_summary = bootstrap_result["summary"]
        neural_bootstrap_summary = neural_bootstrap_result["summary"]
        wait_summary = wait_result["summary"]
        balanced_summary = balanced_result["summary"]
        public_maker_summary = public_maker_result["summary"]
        heuristic_summary = heuristic_result["summary"]

        print("")
        print(f"Bootstrap workers: {bootstrap_result['workers']} ({bootstrap_result['mode']})")
        _print_summary_table("Bootstrap Policy", bootstrap_summary)
        _print_behavior_table("Bootstrap Behavior", bootstrap_summary)
        print("")
        print(f"Neural bootstrap workers: {neural_bootstrap_result['workers']} ({neural_bootstrap_result['mode']})")
        _print_summary_table("Neural Bootstrap Policy", neural_bootstrap_summary)
        _print_behavior_table("Neural Bootstrap Behavior", neural_bootstrap_summary)
        print("")
        print(f"Wait baseline workers: {wait_result['workers']} ({wait_result['mode']})")
        _print_summary_table("Wait Baseline", wait_summary)
        _print_behavior_table("Wait Behavior", wait_summary)
        print("")
        print(f"Balanced baseline workers: {balanced_result['workers']} ({balanced_result['mode']})")
        _print_summary_table("Balanced Baseline", balanced_summary)
        _print_behavior_table("Balanced Baseline Behavior", balanced_summary)
        print("")
        print(f"Public maker workers: {public_maker_result['workers']} ({public_maker_result['mode']})")
        _print_summary_table("Public Maker Baseline", public_maker_summary)
        _print_behavior_table("Public Maker Behavior", public_maker_summary)

        print("")
        print(f"Heuristic workers: {heuristic_result['workers']} ({heuristic_result['mode']})")
        _print_summary_table("Heuristic Seat", heuristic_summary)
        _print_behavior_table("Heuristic Behavior", heuristic_summary)

        for policy_id, summary in family_summaries.items():
            print("")
            print(f"Relative Uplift: {policy_id}")
            for seat_count in seat_counts:
                trained_row = summary[seat_count]
                bootstrap_row = bootstrap_summary[seat_count]
                neural_row = neural_bootstrap_summary[seat_count]
                heuristic_row = heuristic_summary[seat_count]
                print(
                    f"{seat_count} seats: vs bootstrap {trained_row['mean'] - bootstrap_row['mean']:+.3f}"
                    f" | vs neural boot {trained_row['mean'] - neural_row['mean']:+.3f}"
                    f" | vs wait {trained_row['mean'] - wait_summary[seat_count]['mean']:+.3f}"
                    f" | vs balanced {trained_row['mean'] - balanced_summary[seat_count]['mean']:+.3f}"
                    f" | vs public maker {trained_row['mean'] - public_maker_summary[seat_count]['mean']:+.3f}"
                    f" | vs heuristic {trained_row['mean'] - heuristic_row['mean']:+.3f}"
                )


if __name__ == "__main__":
    main()
