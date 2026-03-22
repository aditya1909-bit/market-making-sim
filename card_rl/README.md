# Card RL

Local Python training package for the multi-seat `card_market` bot.

## What it includes

- a seat-based card-market simulator
- exact posterior mean / uncertainty features from private hand and revealed board
- heuristic teacher for quote, take, and reveal decisions
- a compact linear policy with quote, take, reveal, and value heads
- behavior-cloning warm start plus lightweight PPO-style self-play fine-tuning
- export to `workers/src/card-rl-policy-data.js` for KV upload

## Train

```bash
python3 -m card_rl.train --bc-episodes 50000 --ppo-episodes 50000
```

The trainer defaults to all available logical CPUs and prints live progress bars for rollout collection, behavior-cloning warm start, and PPO self-play.
Use `--workers N` to override the parallelism level.
Behavior cloning now learns from full heuristic episodes rather than only opening states, oversamples mid-round take opportunities, and reweights take decisions more heavily than passive states.
PPO self-play now mixes bootstrap, heuristic-teacher, historical-snapshot, and current-policy opponents instead of training mostly against heuristic-like seats.
Both BC and PPO now accumulate gradients inside worker processes and reduce them in the parent process, so rollout generation and most training math scale across cores instead of bottlenecking on per-example Python updates.

## Evaluate

```bash
python3 -m card_rl.evaluate --episodes 3000 --compare-bootstrap
```

The evaluator defaults to all available logical CPUs, batches simulations across workers, and reports:
- mean risk-adjusted PnL
- 95% confidence intervals
- per-seat standard deviation
- average absolute ending inventory
- action mix for quote, take, reveal, and wait
- buy / sell / pass take-side mix

With `--compare-bootstrap`, it also evaluates the bootstrap and heuristic baselines, prints relative uplift by seat count, and warns explicitly when the trained policy is still take-starved.
Use `--workers N` to override parallelism.
