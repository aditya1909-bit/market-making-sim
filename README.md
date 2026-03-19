# market-making-sim

`market-making-sim` now contains:

- a browser client in the repo root for room creation, room-code joins, and random matchmaking
- a Cloudflare Workers + Durable Objects backend in [`workers/`](/Users/adityadutta/Desktop/GitHub/market-making-sim/workers/README.md) for the 1v1 bluffing game
- the older Node prototype in [`backend/`](/Users/adityadutta/Desktop/GitHub/market-making-sim/backend/README.md), retained only as a reference path

## What It Does

- Serves a static browser client from GitHub Pages or any simple file host.
- Connects that client to an authoritative Cloudflare Worker over HTTP and WebSocket.
- Supports private room creation with short join codes.
- Supports random matchmaking into a 1v1 game.
- Runs a hidden-scalar maker/taker game that matches the bluffing interview format much more closely than the earlier single-player prototype.
- Assigns one player as `market_maker` and one as `market_taker`.
- Lets the maker quote `bid / ask / size` and the taker answer with `buy / sell / pass`.
- Settles both sides against a hidden true value at the end of the game.

## Repo Layout

```text
index.html          # Browser client shell
styles.css          # Browser client styles
app.js              # Browser client logic for create/join/matchmaking/ws
asset-data.js       # Older browser-only scenario pack retained from prototype stage
workers/
  src/
    index.js        # Worker entrypoint and HTTP/WebSocket routing
    room-do.js      # One Durable Object per room
    matchmaker-do.js# Global matchmaking Durable Object
    game-engine.js  # Authoritative maker/taker game loop
    contracts.js    # Hidden scalar contract generator
    protocol.js     # Client/server event names and enums
  wrangler.jsonc
  package.json
backend/
  src/
    server.js       # HTTP + WebSocket server
    room-manager.js # Rooms, players, matchmaking, broadcasts
    game-engine.js  # Authoritative maker/taker game loop
    contracts.js    # Hidden scalar contract generator
  shared/
    protocol.js     # Client/server event names and enums
  package.json
.github/workflows/
  deploy-pages.yml  # GitHub Pages deployment workflow
```

## Local Run

Run the Cloudflare Worker backend first:

```bash
cd /Users/adityadutta/Desktop/GitHub/market-making-sim/workers
npm install
npm run dev
```

Then serve the frontend from the repo root:

```bash
cd /Users/adityadutta/Desktop/GitHub/market-making-sim
python3 -m http.server 8000
```

Then visit [http://127.0.0.1:8000](http://127.0.0.1:8000) and use backend URL `http://127.0.0.1:8787`.

## Multiplayer Game Model

- one hidden scalar contract value per room
- one market maker
- one market taker
- maker submits `bid / ask / size`
- taker responds with `buy / sell / pass`
- settlement at the hidden true value
- room-code private games and random matchmaking

## Browser Client Controls

- `Player name` and `Backend URL`
- `Create Private Room`
- `Join Room` by code
- `Find Random Opponent`
- `Mark Ready`
- maker-side quote submission
- taker-side `Buy Ask / Sell Bid / Pass`

## Deploy Split

- frontend: GitHub Pages is fine
- backend: deploy the Worker separately on Cloudflare

The workflow in [`.github/workflows/deploy-pages.yml`](/Users/adityadutta/Desktop/GitHub/market-making-sim/.github/workflows/deploy-pages.yml) still deploys the static frontend to Pages.

## Next Extensions

- deploy the Worker to your Cloudflare account
- point the browser client at that deployed Worker URL
- add turn timers server-side
- add rematch / role-swap flow
- add a bluffing bot so a solo player can face the authoritative server model
