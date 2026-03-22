# Cloudflare Workers Backend

This folder contains the authoritative backend for live matches.

## What It Supports

- private room creation with short room codes
- joining a private room by code
- random matchmaking
- bot rooms against the exported RL policy
- authoritative role assignment
- one hidden scalar contract per room
- a shared pool of `10,000` randomized interview scenarios
- persistent room state in Durable Objects
- WebSocket-based turn play
- rematches with automatic role swap
- reconnecting into an existing room after refresh

## Routes

- `GET /health`
- `POST /api/rooms`
- `POST /api/bot-rooms`
- `POST /api/rooms/:code/join`
- `GET /api/rooms/:code/state?playerId=...`
- `POST /api/matchmaking/join`
- `GET /api/matchmaking/:ticketId`
- `DELETE /api/matchmaking/:ticketId`
- `GET /ws?roomCode=<roomCode>&playerId=<playerId>`

## Local Run

```bash
cd workers
npm install
npm run dev
```

That serves the Worker locally on `http://127.0.0.1:8787`.

## RL Bot Policy

The live RL bot policy is loaded from a Workers KV binding named `RL_POLICY_KV`.
The local training export in `workers/src/rl-policy-data.js` is no longer bundled into the Worker.
The card-market bot uses a separate binding named `CARD_RL_POLICY_KV`.

Create the namespace and bind it:

```bash
cd workers
npx wrangler kv namespace create RL_POLICY_KV --binding RL_POLICY_KV --update-config
```

Then, from the repo root, upload the split policy blobs:

```bash
node rl/upload-policy-to-kv.js --apply
```

If the binding is absent or empty, bot rooms still run, but they fall back to the heuristic policy instead of the trained RL policy.

For the card-market bot:

```bash
cd workers
npx wrangler kv namespace create CARD_RL_POLICY_KV --binding CARD_RL_POLICY_KV --update-config
cd ..
node rl/upload-card-policy-to-kv.js --apply
```

If `CARD_RL_POLICY_KV` is absent, incompatible, or empty, card bots still run with the built-in heuristic teacher.
