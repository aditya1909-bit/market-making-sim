#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results" / "portfolio"


def format_duration(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
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
        self.last_line_length = 0

    def update(self, completed: int, detail: str = "") -> None:
        now = time.perf_counter()
        completed = max(0, min(int(completed), self.total))
        ratio = completed / self.total
        filled = min(self.width, int(self.width * ratio))
        bar = "#" * filled + "-" * (self.width - filled)
        elapsed = now - self.started_at
        rate = completed / elapsed if elapsed > 0 else 0.0
        remaining = (self.total - completed) / rate if rate > 0 else 0.0
        line = (
            f"{self.label:<12} [{bar}] {ratio * 100:5.1f}% "
            f"{completed}/{self.total} | elapsed {format_duration(elapsed)}"
        )
        if completed < self.total:
            line += f" | eta {format_duration(remaining) if rate > 0 else 'calibrating'}"
        if detail:
            line += f" | {detail}"
        padded = line.ljust(self.last_line_length)
        self.last_line_length = max(self.last_line_length, len(line))
        print(f"\r{padded}", end="", flush=True)

    def finish(self, detail: str = "") -> None:
        self.update(self.total, detail=detail)
        print("", flush=True)


def run_streaming(cmd: list[str], log_path: Path) -> int:
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            cmd,
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
        )
        assert process.stdout is not None
        while True:
            chunk = process.stdout.read(1)
            if not chunk:
                break
            print(chunk, end="", flush=True)
            log.write(chunk)
        return process.wait()


def load_registry(path: Path) -> dict:
    text = path.read_text(encoding="utf-8").strip()
    prefix = "export const CARD_RL_POLICY_REGISTRY = "
    if not text.startswith(prefix):
        raise ValueError(f"Unexpected registry format: {path}")
    return json.loads(text[len(prefix) :].rstrip(";\n"))


def candidate_score(entry: dict) -> tuple:
    eval_data = entry.get("evaluation", {})
    live = bool(eval_data.get("liveCandidate"))
    toxicity = eval_data.get("toxicity", {})
    avg_toxicity = 0.0
    if toxicity:
        avg_toxicity = sum(float(row.get("quoteToxicity", 0.0)) for row in toxicity.values()) / max(1, len(toxicity))
    failures = len(eval_data.get("gateFailures", []))
    return (1 if live else 0, float(eval_data.get("mainSeatMean", -9999.0)), -avg_toxicity, -failures)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a production-gated card RL candidate sweep.")
    parser.add_argument("--mode", choices=["quick", "overnight"], default="quick")
    parser.add_argument("--workers", type=int, default=11)
    parser.add_argument(
        "--write-research-registry",
        action="store_true",
        help="Write the best research-only candidate to the Worker registry even when no candidate passes the live gate.",
    )
    args = parser.parse_args()

    RESULTS.mkdir(parents=True, exist_ok=True)
    configs = [
        {"seed": 7, "bc": 800 if args.mode == "quick" else 30_000, "ppo": 800 if args.mode == "quick" else 40_000, "penalty": 0.25},
        {"seed": 17, "bc": 800 if args.mode == "quick" else 40_000, "ppo": 800 if args.mode == "quick" else 50_000, "penalty": 0.45},
        {"seed": 29, "bc": 800 if args.mode == "quick" else 50_000, "ppo": 800 if args.mode == "quick" else 60_000, "penalty": 0.65},
    ]
    total_bc = sum(int(cfg["bc"]) for cfg in configs)
    total_ppo = sum(int(cfg["ppo"]) for cfg in configs)
    print(
        "Production sweep plan: "
        f"{len(configs)} candidate(s), {total_bc:,} BC episode(s), {total_ppo:,} PPO episode(s), "
        f"{args.workers} worker(s). Candidate logs stream live and are also saved under {RESULTS.relative_to(ROOT)}."
    )
    overall = ProgressBar("Sweep", len(configs))
    overall.update(0, detail="eta calibrates after the first candidate")
    rows = []
    best_registry = None
    best_entry = None
    with TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        for index, cfg in enumerate(configs, start=1):
            out = tmp / f"candidate-{index}.js"
            cmd = [
                sys.executable,
                "-m",
                "card_rl.train",
                "--objective",
                "hybrid-as",
                "--adversarial-curriculum",
                "--conservative-penalty",
                str(cfg["penalty"]),
                "--candidate-selector",
                "pareto-live-gate",
                "--bc-episodes",
                str(cfg["bc"]),
                "--ppo-episodes",
                str(cfg["ppo"]),
                "--workers",
                str(args.workers),
                "--seed",
                str(cfg["seed"]),
                "--linear-version",
                "linear-v3",
                "--out",
                str(out),
                "--no-train-neural",
            ]
            log_path = RESULTS / f"card_rl_sweep_candidate_{index}.log"
            print(
                f"\nCandidate {index}/{len(configs)}: seed {cfg['seed']} | "
                f"BC {cfg['bc']:,} | PPO {cfg['ppo']:,} | penalty {cfg['penalty']}"
            )
            returncode = run_streaming(cmd, log_path)
            if returncode != 0 or not out.exists():
                rows.append({"candidate": index, **cfg, "status": "failed", "liveCandidate": False, "mainSeatMean": "", "gateFailures": "train_failed"})
                overall.update(index, detail=f"candidate {index} failed")
                continue
            registry = load_registry(out)
            entry = registry.get("policies", {}).get("linear-v3", {})
            eval_data = entry.get("evaluation", {})
            failures = eval_data.get("gateFailures", [])
            rows.append(
                {
                    "candidate": index,
                    **cfg,
                    "status": "ok",
                    "liveCandidate": bool(eval_data.get("liveCandidate")),
                    "mainSeatMean": eval_data.get("mainSeatMean", ""),
                    "vsHeuristic": eval_data.get("vsHeuristic", ""),
                    "promotionDecision": eval_data.get("promotionDecision", "research-only"),
                    "gateFailures": "|".join(failures),
                }
            )
            if best_entry is None or candidate_score(entry) > candidate_score(best_entry):
                best_entry = entry
                best_registry = registry
            status = "live" if bool(eval_data.get("liveCandidate")) else "research"
            overall.update(index, detail=f"candidate {index} {status} | failures {len(failures)}")
    csv_path = RESULTS / "card_rl_candidates.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=sorted({key for row in rows for key in row}))
        writer.writeheader()
        writer.writerows(rows)
    report = {
        "mode": args.mode,
        "candidateCount": len(rows),
        "bestPolicyId": best_entry.get("id") if best_entry else None,
        "bestEvaluation": best_entry.get("evaluation") if best_entry else None,
        "candidates": rows,
    }
    (RESULTS / "card_rl_gate_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    best_live = bool((best_entry or {}).get("evaluation", {}).get("liveCandidate"))
    if best_registry is not None and (best_live or args.write_research_registry):
        output = ROOT / "workers" / "src" / "card-rl-policy-registry-data.js"
        output.write_text("export const CARD_RL_POLICY_REGISTRY = " + json.dumps(best_registry, indent=2) + ";\n", encoding="utf-8")
        registry_detail = "registry updated"
    else:
        registry_detail = "registry preserved; no live candidate"
    overall.finish(detail=f"best {best_entry.get('id') if best_entry else 'none'} | {registry_detail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
