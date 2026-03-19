# Cloudflare Workers Backend

This folder is the Cloudflare Workers + Durable Objects backend for the 1v1 maker/taker game.

## What It Supports

- private room creation with short room codes
- joining a private room by code
- random matchmaking
- authoritative role assignment
- one hidden scalar contract per room
- persistent room state in Durable Objects
- WebSocket-based turn play

## Routes

- `GET /health`
- `POST /api/rooms`
- `POST /api/rooms/:code/join`
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
