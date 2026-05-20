#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results" / "portfolio"


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, check=False)


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
    args = parser.parse_args()

    RESULTS.mkdir(parents=True, exist_ok=True)
    configs = [
        {"seed": 7, "bc": 800 if args.mode == "quick" else 30_000, "ppo": 800 if args.mode == "quick" else 40_000, "penalty": 0.25},
        {"seed": 17, "bc": 800 if args.mode == "quick" else 40_000, "ppo": 800 if args.mode == "quick" else 50_000, "penalty": 0.45},
        {"seed": 29, "bc": 800 if args.mode == "quick" else 50_000, "ppo": 800 if args.mode == "quick" else 60_000, "penalty": 0.65},
    ]
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
            proc = run(cmd)
            log_path = RESULTS / f"card_rl_sweep_candidate_{index}.log"
            log_path.write_text(proc.stdout + "\n" + proc.stderr, encoding="utf-8")
            if proc.returncode != 0 or not out.exists():
                rows.append({"candidate": index, **cfg, "status": "failed", "liveCandidate": False, "mainSeatMean": "", "gateFailures": "train_failed"})
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
    if best_registry is not None:
        output = ROOT / "workers" / "src" / "card-rl-policy-registry-data.js"
        output.write_text("export const CARD_RL_POLICY_REGISTRY = " + json.dumps(best_registry, indent=2) + ";\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
