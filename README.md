# market-making-sim

`market-making-sim` is now a GitHub Pages-native, single-player browser game: one human versus one market-making bot, with no backend and no build requirement.

## What It Does

- Runs entirely in the browser with static HTML, CSS, and JavaScript.
- Simulates a shallow order book with ambient liquidity, a quoting bot, and random external order flow.
- Lets the player send market orders, place resting bid/ask quotes, cancel quotes, and play a timed round.
- Stores the local best score in `localStorage`.
- Supports seeded challenge links so the same scenario can be replayed from GitHub Pages.

## Repo Layout

```text
index.html          # App shell
styles.css          # Visual design
app.js              # Browser-only game engine and UI bindings
.github/workflows/
  deploy-pages.yml  # GitHub Pages deployment workflow
```

## Local Run

No install step is required. Open [`index.html`](/Users/adityadutta/Desktop/GitHub/market-making-sim/index.html) in a browser, or serve the repo root with any static file server.

For example:

```bash
cd /Users/adityadutta/Desktop/GitHub/market-making-sim
python3 -m http.server 8000
```

Then visit [http://127.0.0.1:8000](http://127.0.0.1:8000).

## Game Model

This is intentionally lighter than `microexec`. It does not try to port the Python/C++ stack into the browser. Instead it borrows the same ideas:

- a latent fair price with stochastic movement
- a market-making bot that skews quotes based on inventory and short-term volatility
- top-of-book and shallow depth
- market orders, resting orders, fills, inventory, and mark-to-market PnL

That tradeoff is what makes it compatible with GitHub Pages.

## Controls

- `Buy MKT` and `Sell MKT`: cross the spread immediately.
- `Join Bid/Ask`: place a quote at the current best price.
- `Improve Bid/Ask`: step one tick inside the spread when possible.
- `Cancel Quotes`: remove your resting bid and ask.
- `Pause`: stop the timer and inspect the book.
- `Randomize`: start a new seeded scenario.

## Seeded Challenges

The `seed` field defines the scenario. The `Copy Link` button generates a URL containing that seed, so anyone opening the link gets the same starting conditions and market path.

That is the GitHub Pages substitute for server-side game/session codes.

## Deploy To GitHub Pages

1. Push this repo to GitHub.
2. In the repo settings, enable GitHub Pages and choose `GitHub Actions` as the source.
3. Push to `main`.

The workflow in [`.github/workflows/deploy-pages.yml`](/Users/adityadutta/Desktop/GitHub/market-making-sim/.github/workflows/deploy-pages.yml) uploads a static artifact and deploys it to Pages.

## Next Extensions

- Swap the current heuristic bot for a compact in-browser ML policy.
- Add difficulty presets with different volatility and toxicity regimes.
- Add player analytics: fill ratio, adverse selection, inventory heat map.
- Add historical scenario packs encoded as seeds or JSON fixtures.
