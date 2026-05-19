#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "results" / "portfolio"


def cpu_count() -> int:
    return max(1, int(os.cpu_count() or 1))


def mode_defaults(mode: str) -> dict[str, int]:
    cpus = cpu_count()
    if mode == "full":
        return {
            "hidden_scenarios": 1000,
            "hidden_games_per_scenario": 2,
            "card_episodes": 3000,
            "card_role_balance_episodes": 3000,
            "card_workers": min(11, cpus),
        }
    return {
        "hidden_scenarios": 200,
        "hidden_games_per_scenario": 2,
        "card_episodes": 120,
        "card_role_balance_episodes": 120,
        "card_workers": 1,
    }


def run_command(
    label: str,
    command: list[str],
    *,
    cwd: Path,
    log_path: Path,
    timeout: int | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    print(f"[portfolio] {label}: {' '.join(command)}", flush=True)
    process = subprocess.run(
        command,
        cwd=str(cwd),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )
    elapsed = time.perf_counter() - started
    log_path.write_text(process.stdout, encoding="utf-8")
    print(f"[portfolio] {label}: exit {process.returncode} in {elapsed:.1f}s", flush=True)
    return {
        "label": label,
        "command": command,
        "cwd": str(cwd.relative_to(ROOT)),
        "returncode": process.returncode,
        "elapsed_seconds": elapsed,
        "log": str(log_path.relative_to(ROOT)),
    }


def parse_test_counts(text: str) -> dict[str, int | None]:
    matches = re.findall(r"(?:#|ℹ)\s+(pass|fail)\s+(\d+)", text)
    counts = {"pass": None, "fail": None}
    for key, value in matches:
        counts[key] = int(value)
    if counts["pass"] is None:
        unittest = re.search(r"Ran\s+(\d+)\s+tests?", text)
        ok = re.search(r"\bOK\b", text)
        if unittest and ok:
            counts["pass"] = int(unittest.group(1))
            counts["fail"] = 0
    return counts


def parse_hidden_value_eval(text: str) -> tuple[list[dict[str, Any]], dict[str, float]]:
    rows: list[dict[str, Any]] = []
    block_re = re.compile(
        r"\n(?P<label>(?:Fallback|RL)[^\n]+)\n"
        r"\s+games:\s+(?P<games>[-0-9.]+)\n"
        r"\s+maker pnl/game:\s+(?P<maker>[-0-9.]+)\n"
        r"\s+taker pnl/game:\s+(?P<taker>[-0-9.]+)\n"
        r"\s+maker win rate:\s+(?P<maker_win>[-0-9.]+)%\n"
        r"\s+taker win rate:\s+(?P<taker_win>[-0-9.]+)%\n"
        r"\s+draw rate:\s+(?P<draw>[-0-9.]+)%\n"
        r"\s+avg spread:\s+(?P<spread>[-0-9.]+)\n"
        r"\s+buys/game:\s+(?P<buys>[-0-9.]+)\n"
        r"\s+sells/game:\s+(?P<sells>[-0-9.]+)\n"
        r"\s+passes/game:\s+(?P<passes>[-0-9.]+)",
        re.MULTILINE,
    )
    for match in block_re.finditer(text):
        groups = match.groupdict()
        rows.append(
            {
                "matchup": groups["label"].strip(),
                "games": int(float(groups["games"])),
                "maker_pnl_per_game": float(groups["maker"]),
                "taker_pnl_per_game": float(groups["taker"]),
                "maker_win_rate": float(groups["maker_win"]) / 100,
                "taker_win_rate": float(groups["taker_win"]) / 100,
                "draw_rate": float(groups["draw"]) / 100,
                "avg_spread": float(groups["spread"]),
                "buys_per_game": float(groups["buys"]),
                "sells_per_game": float(groups["sells"]),
                "passes_per_game": float(groups["passes"]),
            }
        )

    uplifts = {}
    maker = re.search(r"maker uplift:\s+([-0-9.]+)", text)
    taker = re.search(r"taker uplift:\s+([-0-9.]+)", text)
    if maker:
        uplifts["maker_uplift"] = float(maker.group(1))
    if taker:
        uplifts["taker_uplift"] = float(taker.group(1))
    return rows, uplifts


def _table_section(text: str, title: str) -> str:
    pattern = re.compile(rf"\n{re.escape(title)}\n(?P<body>.*?)(?=\n\n[A-Z0-9a-z][^\n]*\n|\Z)", re.S)
    match = pattern.search(text)
    return match.group("body") if match else ""


def parse_card_eval(text: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    summary_rows: list[dict[str, Any]] = []
    behavior_rows: list[dict[str, Any]] = []

    summary_re = re.compile(
        r"(?P<seats>\d+) seats:\s+(?P<mean>[-0-9.]+) pnl"
        r"\s+\|\s+ci95 \+/-?(?P<ci95>[-0-9.]+)"
        r"\s+\|\s+stdev (?P<stdev>[-0-9.]+)"
        r"\s+\|\s+avg \|inv\| (?P<inv>[-0-9.]+)"
    )
    behavior_re = re.compile(
        r"(?P<seats>\d+) seats:\s+quote\s+(?P<quote>[-0-9.]+)%"
        r"\s+\|\s+take\s+(?P<take>[-0-9.]+)%"
        r"\s+\|\s+reveal\s+(?P<reveal>[-0-9.]+)%"
        r"\s+\|\s+wait\s+(?P<wait>[-0-9.]+)%"
        r"\s+\|\s+buy\s+(?P<buy>[-0-9.]+)%"
        r"\s+\|\s+sell\s+(?P<sell>[-0-9.]+)%"
        r"\s+\|\s+pass\s+(?P<pass>[-0-9.]+)%"
        r"\s+\|\s+opp\s+(?P<opp>[-0-9.]+)%"
        r"\s+\|\s+missed\s+(?P<missed>[-0-9.]+)%"
        r"\s+\|\s+maker vol (?P<maker_vol>[-0-9.]+)"
        r"\s+\|\s+taker vol (?P<taker_vol>[-0-9.]+)"
        r"\s+\|\s+maker mko (?P<maker_mko>[-0-9.]+)"
        r"\s+\|\s+taker mko (?P<taker_mko>[-0-9.]+)"
        r"\s+\|\s+q-disp (?P<qdisp>[-0-9.]+)"
    )

    for title in [
        "linear-v2 Summary",
        "neural-v1 Summary",
        "Bootstrap Policy",
        "Neural Bootstrap Policy",
        "Wait Baseline",
        "Balanced Baseline",
        "Public Maker Baseline",
        "Heuristic Seat",
    ]:
        section = _table_section(text, title)
        policy = title.replace(" Summary", "").replace(" Policy", "").replace(" Seat", "")
        for match in summary_re.finditer(section):
            row = match.groupdict()
            summary_rows.append(
                {
                    "policy": policy,
                    "seats": int(row["seats"]),
                    "mean_pnl": float(row["mean"]),
                    "ci95": float(row["ci95"]),
                    "stdev": float(row["stdev"]),
                    "avg_abs_inventory": float(row["inv"]),
                }
            )

    for title in [
        "linear-v2 Behavior",
        "neural-v1 Behavior",
        "Bootstrap Behavior",
        "Neural Bootstrap Behavior",
        "Wait Behavior",
        "Balanced Baseline Behavior",
        "Public Maker Behavior",
        "Heuristic Behavior",
    ]:
        section = _table_section(text, title)
        policy = title.replace(" Behavior", "")
        for match in behavior_re.finditer(section):
            row = match.groupdict()
            behavior_rows.append(
                {
                    "policy": policy,
                    "seats": int(row["seats"]),
                    "quote_rate": float(row["quote"]) / 100,
                    "take_rate": float(row["take"]) / 100,
                    "reveal_rate": float(row["reveal"]) / 100,
                    "wait_rate": float(row["wait"]) / 100,
                    "buy_rate": float(row["buy"]) / 100,
                    "sell_rate": float(row["sell"]) / 100,
                    "pass_rate": float(row["pass"]) / 100,
                    "take_opportunity_rate": float(row["opp"]) / 100,
                    "missed_take_rate": float(row["missed"]) / 100,
                    "maker_volume_per_episode": float(row["maker_vol"]),
                    "taker_volume_per_episode": float(row["taker_vol"]),
                    "maker_markout": float(row["maker_mko"]),
                    "taker_markout": float(row["taker_mko"]),
                    "quote_mid_dispersion": float(row["qdisp"]),
                }
            )

    role = {}
    role_match = re.search(
        r"linear-v2 Role Balance\n"
        r"incentives: maker_fill (?P<maker_fill>[-0-9.]+) \| taker_fill (?P<taker_fill>[-0-9.]+)"
        r" \| wide_pass (?P<wide_pass>[-0-9.]+) \| tight_refusal (?P<tight_refusal>[-0-9.]+)\n"
        r"maker pnl (?P<maker_pnl>[-0-9.]+) \| ci95 \+/-?(?P<maker_ci95>[-0-9.]+)"
        r" \| taker pnl (?P<taker_pnl>[-0-9.]+) \| ci95 \+/-?(?P<taker_ci95>[-0-9.]+)\n"
        r"fills/ep (?P<fills>[-0-9.]+) \| maker quote\s+(?P<maker_quote>[-0-9.]+)%"
        r" \| taker take\s+(?P<taker_take>[-0-9.]+)% \| parity gap (?P<parity>[-0-9.]+)",
        text,
    )
    if role_match:
        row = role_match.groupdict()
        role = {
            "policy": "linear-v2",
            "maker_fill_rebate": float(row["maker_fill"]),
            "taker_fill_fee": float(row["taker_fill"]),
            "wide_quote_pass_penalty": float(row["wide_pass"]),
            "tight_quote_refusal_penalty": float(row["tight_refusal"]),
            "maker_pnl": float(row["maker_pnl"]),
            "maker_ci95": float(row["maker_ci95"]),
            "taker_pnl": float(row["taker_pnl"]),
            "taker_ci95": float(row["taker_ci95"]),
            "fills_per_episode": float(row["fills"]),
            "maker_quote_rate": float(row["maker_quote"]) / 100,
            "taker_take_rate": float(row["taker_take"]) / 100,
            "parity_gap": float(row["parity"]),
        }

    alerts = []
    for line in text.splitlines():
        if "warning on seats" in line or line.strip() in {"taker-undertrade", "quote-collapse", "taker-overtrade", "maker-favored", "taker-favored"}:
            alerts.append(line.strip())
    card_meta = {"role_balance": role, "alerts": alerts}
    return summary_rows, behavior_rows, card_meta


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run portfolio-grade benchmark evidence for market-making-sim.")
    parser.add_argument("--mode", choices=["quick", "full"], default="quick")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--hidden-scenarios", type=int, default=None)
    parser.add_argument("--hidden-games-per-scenario", type=int, default=None)
    parser.add_argument("--card-episodes", type=int, default=None)
    parser.add_argument("--card-role-balance-episodes", type=int, default=None)
    parser.add_argument("--card-workers", type=int, default=None)
    parser.add_argument("--skip-tests", action="store_true")
    args = parser.parse_args()

    defaults = mode_defaults(args.mode)
    hidden_scenarios = args.hidden_scenarios or defaults["hidden_scenarios"]
    hidden_games = args.hidden_games_per_scenario or defaults["hidden_games_per_scenario"]
    card_episodes = args.card_episodes or defaults["card_episodes"]
    card_role_episodes = args.card_role_balance_episodes or defaults["card_role_balance_episodes"]
    card_workers = args.card_workers or defaults["card_workers"]

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    raw_dir = output / "raw_logs"
    raw_dir.mkdir(parents=True, exist_ok=True)

    commands = []
    if not args.skip_tests:
        commands.append(
            run_command(
                "worker tests",
                ["npm", "test"],
                cwd=ROOT / "workers",
                log_path=raw_dir / "worker_tests.log",
            )
        )
        commands.append(
            run_command(
                "card RL unit tests",
                [sys.executable, "-m", "unittest", "discover", "card_rl/tests"],
                cwd=ROOT,
                log_path=raw_dir / "card_rl_tests.log",
            )
        )

    commands.append(
        run_command(
            "hidden value holdout eval",
            [
                "node",
                "rl/evaluate-policy.js",
                "--scenarios",
                str(hidden_scenarios),
                "--games-per-scenario",
                str(hidden_games),
                "--split",
                "holdout",
            ],
            cwd=ROOT,
            log_path=raw_dir / "hidden_value_eval.log",
        )
    )
    commands.append(
        run_command(
            "card market RL eval",
            [
                sys.executable,
                "-m",
                "card_rl.evaluate",
                "--episodes",
                str(card_episodes),
                "--role-balance-episodes",
                str(card_role_episodes),
                "--compare-bootstrap",
                "--workers",
                str(card_workers),
            ],
            cwd=ROOT,
            log_path=raw_dir / "card_rl_eval.log",
        )
    )

    worker_log = (raw_dir / "worker_tests.log").read_text(encoding="utf-8") if (raw_dir / "worker_tests.log").exists() else ""
    card_test_log = (raw_dir / "card_rl_tests.log").read_text(encoding="utf-8") if (raw_dir / "card_rl_tests.log").exists() else ""
    hidden_log = (raw_dir / "hidden_value_eval.log").read_text(encoding="utf-8")
    card_log = (raw_dir / "card_rl_eval.log").read_text(encoding="utf-8")

    hidden_rows, hidden_uplifts = parse_hidden_value_eval(hidden_log)
    card_rows, card_behavior_rows, card_meta = parse_card_eval(card_log)

    write_csv(output / "hidden_value_eval.csv", hidden_rows)
    write_csv(output / "card_rl_eval.csv", card_rows)
    write_csv(output / "card_behavior.csv", card_behavior_rows)
    if card_meta.get("role_balance"):
        write_csv(output / "role_balance.csv", [card_meta["role_balance"]])

    linear_rows = [row for row in card_rows if row["policy"] == "linear-v2"]
    bootstrap_rows = {row["seats"]: row for row in card_rows if row["policy"] == "Bootstrap"}
    linear_vs_bootstrap = [
        {
            "seats": row["seats"],
            "uplift_vs_bootstrap": row["mean_pnl"] - bootstrap_rows[row["seats"]]["mean_pnl"],
        }
        for row in linear_rows
        if row["seats"] in bootstrap_rows
    ]
    live_card_policy_ready = False
    role_balance = card_meta.get("role_balance") or {}
    if role_balance:
        live_card_policy_ready = bool(
            role_balance.get("maker_quote_rate", 0) >= 0.40
            and 0.10 <= role_balance.get("taker_take_rate", 0) <= 0.35
            and abs(role_balance.get("maker_pnl", 0)) <= max(0.5, role_balance.get("maker_ci95", 0))
            and abs(role_balance.get("taker_pnl", 0)) <= max(0.5, role_balance.get("taker_ci95", 0))
        )

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": args.mode,
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "cpu_count": cpu_count(),
        },
        "parameters": {
            "hidden_scenarios": hidden_scenarios,
            "hidden_games_per_scenario": hidden_games,
            "card_episodes": card_episodes,
            "card_role_balance_episodes": card_role_episodes,
            "card_workers": card_workers,
        },
        "commands": commands,
        "tests": {
            "worker": parse_test_counts(worker_log),
            "card_rl": parse_test_counts(card_test_log),
        },
        "hidden_value": {
            "rows": hidden_rows,
            "uplifts": hidden_uplifts,
        },
        "card_market": {
            "summary_rows": card_rows,
            "behavior_rows": card_behavior_rows,
            "role_balance": role_balance,
            "linear_vs_bootstrap": linear_vs_bootstrap,
            "alerts": card_meta.get("alerts", []),
            "live_card_policy_ready": live_card_policy_ready,
            "positioning": "live-default" if live_card_policy_ready else "research-benchmark",
        },
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"[portfolio] wrote {output / 'summary.json'}", flush=True)
    return 0 if all(row["returncode"] == 0 for row in commands) else 1


if __name__ == "__main__":
    raise SystemExit(main())
