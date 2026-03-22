from __future__ import annotations

import argparse
import json
import math
import os
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from multiprocessing import get_context
from pathlib import Path
from typing import Callable

from .heuristic import heuristic_decision
from .model import LinearCardPolicy, bootstrap_policy
from .simulator import CardMarketSimulator


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


def _batch_size(total_episodes: int, workers: int, cap: int = 256) -> int:
    return max(1, min(cap, max(1, total_episodes // max(1, workers * 8))))


def _open_parallel_executor(workers: int):
    if workers <= 1:
        return None, "sequential"
    try:
        mp_context = get_context("spawn")
        return ProcessPoolExecutor(max_workers=workers, mp_context=mp_context), "process"
    except (OSError, PermissionError):
        return ThreadPoolExecutor(max_workers=workers), "thread"


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
    }


def _merge_metric_bucket(target: dict, payload: dict) -> None:
    for key, value in payload.items():
        target[key] = target.get(key, 0) + value


def _policy_actor(kind: str, policy_data: dict | None) -> Callable[[dict, str, int], dict]:
    if kind == "heuristic":
        return heuristic_decision
    if policy_data is None:
        raise ValueError("Linear policy evaluation requires policy data.")
    policy = LinearCardPolicy.from_dict(policy_data)
    return lambda state, player_id, now_step: policy.choose_action(state, player_id, now_step)


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
            decision = tracked_actor(state, player_id, now_step)
            decision_type = decision.get("type", "wait")
            metrics["decision_count"] += 1
            if decision_type == "submit_quote":
                metrics["action_quote"] += 1
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
        metrics["episodes"] += 1
        metrics["sum"] += score
        metrics["sum_sq"] += score * score
        metrics["inventory_sum"] += inventory
        metrics["abs_inventory_sum"] += abs(inventory)

    return {
        "seat_count": seat_count,
        "metrics": metrics,
    }


def load_exported_policy(path: Path) -> LinearCardPolicy:
    text = path.read_text(encoding="utf-8").strip()
    prefix = "export const CARD_RL_POLICY = "
    if not text.startswith(prefix):
        raise ValueError(f"{path} is not a CARD_RL_POLICY module.")
    payload = json.loads(text[len(prefix) :].rstrip(";\n"))
    return LinearCardPolicy.from_dict(payload["model"])


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

    progress = ProgressBar(progress_label, len(jobs))
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
        }
    return summary, mode


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
        )


def _print_behavior_alerts(title: str, summary: dict[int, dict]) -> None:
    low_take = [
        seat_count
        for seat_count, row in sorted(summary.items())
        if row["take_rate"] < 0.005 and (row["quote_rate"] + row["wait_rate"]) > 0.9
    ]
    if not low_take:
        return
    seats = ", ".join(str(seat_count) for seat_count in low_take)
    print("")
    print(f"{title} Alerts")
    print(f"Low take-rate warning on seats: {seats}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate a card-market policy against heuristics.")
    parser.add_argument("--episodes", type=int, default=30)
    parser.add_argument("--policy", type=Path, default=Path("workers/src/card-rl-policy-data.js"))
    parser.add_argument("--compare-bootstrap", action="store_true")
    parser.add_argument("--workers", type=int, default=default_worker_count())
    parser.add_argument("--seed", type=int, default=17)
    args = parser.parse_args()

    seat_counts = [2, 4, 6, 8, 10]
    workers = max(1, int(args.workers))

    trained_policy = load_exported_policy(args.policy)
    trained_summary, trained_mode = _evaluate_policy(
        name="trained",
        policy_kind="linear",
        policy_data=trained_policy.to_dict(),
        episodes=args.episodes,
        seat_counts=seat_counts,
        workers=workers,
        seed=args.seed,
        progress_label="Eval trained",
    )

    print(f"Policy: {args.policy}")
    print(f"Workers: {workers} ({trained_mode})")
    _print_summary_table("Trained Policy", trained_summary)
    _print_behavior_table("Trained Behavior", trained_summary)
    _print_behavior_alerts("Trained", trained_summary)

    if args.compare_bootstrap:
        bootstrap_summary, bootstrap_mode = _evaluate_policy(
            name="bootstrap",
            policy_kind="linear",
            policy_data=bootstrap_policy().to_dict(),
            episodes=args.episodes,
            seat_counts=seat_counts,
            workers=workers,
            seed=args.seed + 101,
            progress_label="Eval boot",
        )
        heuristic_summary, heuristic_mode = _evaluate_policy(
            name="heuristic",
            policy_kind="heuristic",
            policy_data=None,
            episodes=args.episodes,
            seat_counts=seat_counts,
            workers=workers,
            seed=args.seed + 202,
            progress_label="Eval heur",
        )

        print("")
        print(f"Bootstrap workers: {workers} ({bootstrap_mode})")
        _print_summary_table("Bootstrap Policy", bootstrap_summary)
        _print_behavior_table("Bootstrap Behavior", bootstrap_summary)

        print("")
        print(f"Heuristic workers: {workers} ({heuristic_mode})")
        _print_summary_table("Heuristic Seat", heuristic_summary)
        _print_behavior_table("Heuristic Behavior", heuristic_summary)

        print("")
        print("Relative Uplift")
        for seat_count in seat_counts:
            trained_row = trained_summary[seat_count]
            bootstrap_row = bootstrap_summary[seat_count]
            heuristic_row = heuristic_summary[seat_count]
            print(
                f"{seat_count} seats: vs bootstrap {trained_row['mean'] - bootstrap_row['mean']:+.3f}"
                f" | vs heuristic {trained_row['mean'] - heuristic_row['mean']:+.3f}"
            )


if __name__ == "__main__":
    main()
