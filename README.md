# market-making-sim

`market-making-sim` is now a GitHub Pages-native, single-player browser interview sim: the human makes a two-sided market in a contract and a scripted counterparty chooses whether to buy, sell, or pass.

## What It Does

- Runs entirely in the browser with static HTML, CSS, and JavaScript.
- Starts idle instead of auto-running; the round begins only when the player presses `Start Interview`.
- Maps each seed to a built-in real-asset scenario pack so the player sees an actual ticker, sector, session label, and recent price path before quoting.
- Frames each round as a contract that settles to a hidden end-of-session print, which is closer to public descriptions of interview market-making games.
- Uses turn-based quoting with a 30-second shot clock, so the player can think between decisions.
- Puts the human in the market-maker role and the script in the taker role, which is closer to quant interview games.
- Scores the player on marked-to-market PnL with explicit inventory and missed-turn penalties.
- Stores the local best score in `localStorage`.
- Supports seeded challenge links so the same scenario can be replayed from GitHub Pages.

## Repo Layout

```text
index.html          # App shell
styles.css          # Visual design
asset-data.js       # Built-in asset-backed scenario pack
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

This is intentionally lighter than `microexec`. It does not try to port the Python/C++ stack into the browser. Instead it borrows the same ideas and repackages them into an interview loop:

- a latent fair price with stochastic movement
- a seeded underlying asset brief with recent path and session context
- public signals like momentum, volatility, and flow hints
- a hidden settlement value and script fair value that react to your quotes
- two-sided quoting, fills, inventory, and mark-to-market PnL

That tradeoff is what makes it compatible with GitHub Pages.

## Controls

- `Start Interview`: begins the round; the site does nothing before this.
- `Underlying Brief`: tells you what asset you are making a market in, what kind of session it is, and how the recent tape behaved.
- `Bid / Ask / Size`: your quoted market for the current turn.
- `Tight / Normal / Wide`: quick quote presets around the reference mark.
- `Submit Quote`: sends one two-sided market to the script.
- `Forfeit Turn`: intentionally skip a turn if you do not want to quote.
- `Randomize`: generate a new seeded scenario.

## Seeded Challenges

The `seed` field defines the scenario. The `Copy Link` button generates a URL containing that seed, so anyone opening the link gets the same asset, same interview setup, and same hidden script path.

That is the GitHub Pages substitute for server-side game/session codes.

## Deploy To GitHub Pages

1. Push this repo to GitHub.
2. In the repo settings, enable GitHub Pages and choose `GitHub Actions` as the source.
3. Push to `main`.

The workflow in [`.github/workflows/deploy-pages.yml`](/Users/adityadutta/Desktop/GitHub/market-making-sim/.github/workflows/deploy-pages.yml) uploads a static artifact and deploys it to Pages.

## Next Extensions

- Swap the current heuristic counterparty script for a compact in-browser ML policy.
- Add difficulty presets with different script aggressiveness and inventory budgets.
- Add post-round analytics: quote width distribution, hit ratio, adverse selection, and inventory path.
- Add scenario packs encoded as JSON files or deterministic seeds.
