# RL Self-Play

This folder contains the local self-play trainer for the Worker bot policy.

## What it does

- trains a simple tabular Q-learning style policy for the maker side
- trains a hierarchical taker policy with explicit `take`, `pass`, and `probe` modes plus an action layer
- shards training across worker threads when you pass `--workers`
- samples from the same `10,000` scenario pool the live game uses
- exports the learned tables into `workers/src/rl-policy-data.js`
- splits and uploads the trained policy into Workers KV for live bot play
- includes a benchmark script to compare RL and fallback policies on the live scenario pool

## Run it

```bash
cd market-making-sim
node rl/train-self-play.js --episodes 50000 --workers 8 --min-samples 20
```

Optional flags:

- `--episodes 100000`
- `--alpha 0.05`
- `--epsilon 0.15`
- `--workers 8`
- `--min-samples 20`
- `--progress-every 25000`
- `--out workers/src/rl-policy-data.js`

After training, upload the policy to Workers KV and then redeploy the Worker so the new policy is live.

## Push The Policy Live

The live Worker no longer bundles `rl-policy-data.js` directly. That file stays local for evaluation and for KV upload, while the deployed bot reads the policy from a KV namespace bound as `RL_POLICY_KV`.

Create the namespace and add the binding to `workers/wrangler.jsonc`:

```bash
cd market-making-sim/workers
npx wrangler kv namespace create RL_POLICY_KV --binding RL_POLICY_KV --update-config
```

Split the current policy into KV-sized JSON blobs:

```bash
cd ../
node rl/upload-policy-to-kv.js
```

Upload those blobs to the bound namespace:

```bash
node rl/upload-policy-to-kv.js --apply
```

If you also use a preview namespace in local Worker development, upload that too:

```bash
node rl/upload-policy-to-kv.js --apply --preview
```

The live bot also gates RL decisions by state support and falls back to the heuristic policy in sparse states.
The taker also uses short quote memory and mode selection before choosing a buy/sell/pass action.

## Evaluate it

```bash
cd market-making-sim
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
