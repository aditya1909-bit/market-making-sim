# Cloudflare Workers Backend

This folder is the Cloudflare Workers + Durable Objects backend for the 1v1 maker/taker game.

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
cd /Users/adityadutta/Desktop/GitHub/market-making-sim/workers
npm install
npm run dev
```

That serves the Worker locally on `http://127.0.0.1:8787`.
