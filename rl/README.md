# RL Self-Play

This folder contains the local self-play trainer for the Worker bot policy.

## What it does

- trains a simple tabular Q-learning style policy for the maker side
- trains a simple tabular Q-learning style policy for the taker side
- shards training across worker threads when you pass `--workers`
- samples from the same `10,000` scenario pool the live game uses
- exports the learned tables into [`workers/src/rl-policy-data.js`](/Users/adityadutta/Desktop/GitHub/market-making-sim/workers/src/rl-policy-data.js)
- includes a benchmark script to compare RL and fallback policies on the live scenario pool

## Run it

```bash
cd /Users/adityadutta/Desktop/GitHub/market-making-sim
node rl/train-self-play.js --episodes 50000 --workers 8 --min-samples 20
```

Optional flags:

- `--episodes 100000`
- `--alpha 0.05`
- `--epsilon 0.15`
- `--workers 8`
- `--min-samples 20`
- `--out workers/src/rl-policy-data.js`

After training, redeploy the Worker so the new policy is live.

The live bot also gates RL decisions by state support and falls back to the heuristic policy in sparse states.

## Evaluate it

```bash
cd /Users/adityadutta/Desktop/GitHub/market-making-sim
node rl/evaluate-policy.js --scenarios 2000 --games-per-scenario 2
```

For holdout-only evaluation:

```bash
node rl/evaluate-policy.js --scenarios 2000 --games-per-scenario 2 --split holdout
```

That reports:

- fallback maker vs fallback taker
- RL maker vs fallback taker
- fallback maker vs RL taker
- RL maker vs RL taker
