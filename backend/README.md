# Backend Prototype

This folder contains the multiplayer backend prototype for the 1v1 bluffing market game.

## What It Supports

- private room creation with short room codes
- joining a private room by code
- simple random matchmaking queue
- authoritative role assignment
- one hidden scalar contract per match
- role-based turn loop:
  - market maker submits quote
  - market taker chooses `buy`, `sell`, or `pass`
  - settlement at the hidden true value

## API

### HTTP

- `GET /health`
- `POST /api/rooms`
- `POST /api/rooms/:code/join`
- `POST /api/matchmaking/join`
- `GET /api/matchmaking/:ticketId`

### WebSocket

- `GET /ws?playerId=<playerId>`

Client events:
- `ready`
- `start_game`
- `submit_quote`
- `taker_action`
- `leave_room`

Server events:
- `room_state`
- `error`
- `pong`

## Local Run

```bash
cd /Users/adityadutta/Desktop/GitHub/market-making-sim/backend
npm install
npm run dev
```

The server defaults to port `8787`.
