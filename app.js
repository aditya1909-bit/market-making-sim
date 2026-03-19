(function () {
  const STORAGE_KEY = "market-making-sim.best-score";
  const TICK_SIZE = 0.1;
  const ROUND_TICKS = 180;
  const DEFAULT_QTY = 2;
  const BOT_NAME = "Inventory Maker";
  const BOT_PROFILES = ["balanced", "inventory-heavy", "sharp-spread"];

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function roundTick(value) {
    return Math.round(value / TICK_SIZE) * TICK_SIZE;
  }

  function format(value, digits = 2) {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return "-";
    }
    return Number(value).toFixed(digits);
  }

  function parseSeedFromUrl() {
    const url = new URL(window.location.href);
    return url.searchParams.get("seed") || "";
  }

  function setSeedOnUrl(seed) {
    const url = new URL(window.location.href);
    url.searchParams.set("seed", seed);
    window.history.replaceState({}, "", url.toString());
  }

  function hashString(input) {
    let h = 1779033703 ^ input.length;
    for (let i = 0; i < input.length; i += 1) {
      h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t += 0x6d2b79f5;
      let x = Math.imul(t ^ (t >>> 15), 1 | t);
      x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRng(seedText) {
    const seedHash = hashString(seedText || "market-making");
    return mulberry32(seedHash());
  }

  function randomSeed() {
    return Math.random().toString(36).slice(2, 10).toUpperCase();
  }

  function signedNormalish(rng) {
    let total = 0;
    for (let i = 0; i < 6; i += 1) {
      total += rng() - 0.5;
    }
    return total / 3;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error("Clipboard unavailable"));
  }

  class GameEngine {
    constructor(seedText) {
      this.reset(seedText || randomSeed());
    }

    reset(seedText) {
      this.seed = (seedText || randomSeed()).toUpperCase();
      this.rng = makeRng(this.seed);
      this.tick = 0;
      this.maxTicks = ROUND_TICKS;
      this.state = "running";
      this.regime = BOT_PROFILES[Math.floor(this.rng() * BOT_PROFILES.length)];
      this.fairPrice = roundTick(100 + this.rng() * 12 - 6);
      this.previousFair = this.fairPrice;
      this.lastTrade = this.fairPrice;
      this.lastSpread = 0.4;
      this.returns = [];
      this.timePriority = 1;
      this.externalPressure = 0;
      this.tape = [];
      this.bestScore = Number(window.localStorage.getItem(STORAGE_KEY) || 0);
      this.player = {
        name: "Player",
        inventory: 0,
        cash: 0,
        bidOrder: null,
        askOrder: null,
      };
      this.bot = {
        name: BOT_NAME,
        inventory: 0,
        cash: 0,
        bidOrder: null,
        askOrder: null,
      };
      this.ambient = { bids: [], asks: [] };
      this.rebuildMarket();
      setSeedOnUrl(this.seed);
      return this.snapshot();
    }

    pause() {
      this.state = "paused";
      return this.snapshot();
    }

    resume() {
      if (this.tick < this.maxTicks) {
        this.state = "running";
      }
      return this.snapshot();
    }

    act(action, qty) {
      const size = clamp(Number(qty) || DEFAULT_QTY, 1, 10);

      if (action === "pause") {
        return this.pause();
      }
      if (action === "resume") {
        return this.resume();
      }
      if (action === "randomize") {
        return this.reset(randomSeed());
      }
      if (action === "cancel-all") {
        this.player.bidOrder = null;
        this.player.askOrder = null;
        this.log({
          kind: "info",
          message: "Player canceled all resting quotes.",
        });
      }
      if (this.state !== "running") {
        return this.snapshot();
      }

      if (this.tick >= this.maxTicks) {
        this.finishRound();
        return this.snapshot();
      }

      if (action === "market-buy") {
        this.executeMarketOrder("player", "buy", size);
      } else if (action === "market-sell") {
        this.executeMarketOrder("player", "sell", size);
      } else if (action === "join-bid") {
        this.placePlayerOrder("bid", "join", size);
      } else if (action === "join-ask") {
        this.placePlayerOrder("ask", "join", size);
      } else if (action === "improve-bid") {
        this.placePlayerOrder("bid", "improve", size);
      } else if (action === "improve-ask") {
        this.placePlayerOrder("ask", "improve", size);
      }

      this.advanceOneTick();
      return this.snapshot();
    }

    advanceOneTick() {
      if (this.state !== "running") {
        return;
      }

      this.tick += 1;
      this.previousFair = this.fairPrice;

      const noiseScale = this.regime === "sharp-spread" ? 0.45 : this.regime === "inventory-heavy" ? 0.28 : 0.35;
      const drift = (this.rng() - 0.5) * 0.06 + this.externalPressure * 0.03;
      const shock = signedNormalish(this.rng) * noiseScale;
      this.fairPrice = roundTick(Math.max(50, this.fairPrice + drift + shock));

      const ret = this.fairPrice - this.previousFair;
      this.returns.push(Math.abs(ret));
      if (this.returns.length > 20) {
        this.returns.shift();
      }

      this.externalPressure = clamp(this.externalPressure * 0.72 + signedNormalish(this.rng) * 0.18, -1.5, 1.5);
      this.rebuildMarket();
      this.simulateExternalFlow();

      if (this.tick >= this.maxTicks) {
        this.finishRound();
      }
    }

    rebuildMarket() {
      this.updateBotQuotes();
      this.rebuildAmbientDepth();
    }

    updateBotQuotes() {
      const vol = this.currentVolatility();
      const inventorySkew = this.bot.inventory * (this.regime === "inventory-heavy" ? 0.08 : 0.05);
      const reservation = this.fairPrice - inventorySkew + this.externalPressure * 0.07;
      const halfSpread = Math.max(
        0.2,
        (this.regime === "sharp-spread" ? 0.16 : 0.22) + vol * 0.7 + Math.abs(this.bot.inventory) * 0.01
      );
      const bestBid = roundTick(reservation - halfSpread);
      const bestAsk = roundTick(Math.max(bestBid + TICK_SIZE, reservation + halfSpread));
      const qtyBias = clamp(3 - Math.floor(Math.abs(this.bot.inventory) / 4), 1, 5);

      this.bot.bidOrder = {
        id: `bot-bid-${this.tick}`,
        owner: "bot",
        side: "bid",
        price: bestBid,
        qty: qtyBias + (this.bot.inventory < 0 ? 1 : 0),
        ts: this.nextPriority(),
      };
      this.bot.askOrder = {
        id: `bot-ask-${this.tick}`,
        owner: "bot",
        side: "ask",
        price: bestAsk,
        qty: qtyBias + (this.bot.inventory > 0 ? 1 : 0),
        ts: this.nextPriority(),
      };
      this.lastSpread = roundTick(bestAsk - bestBid);
    }

    rebuildAmbientDepth() {
      const spreadPad = Math.max(0.2, this.lastSpread / 2);
      const baseBid = roundTick(this.fairPrice - spreadPad);
      const baseAsk = roundTick(this.fairPrice + spreadPad);
      this.ambient = { bids: [], asks: [] };

      for (let level = 0; level < 5; level += 1) {
        this.ambient.bids.push({
          id: `ambient-bid-${this.tick}-${level}`,
          owner: "ambient",
          side: "bid",
          price: roundTick(baseBid - level * TICK_SIZE),
          qty: 4 + level * 2 + Math.floor(this.rng() * 4),
          ts: 10_000 + level,
        });
        this.ambient.asks.push({
          id: `ambient-ask-${this.tick}-${level}`,
          owner: "ambient",
          side: "ask",
          price: roundTick(baseAsk + level * TICK_SIZE),
          qty: 4 + level * 2 + Math.floor(this.rng() * 4),
          ts: 10_100 + level,
        });
      }
    }

    placePlayerOrder(side, mode, qty) {
      const book = this.currentBook();
      const bestBid = book.bestBid;
      const bestAsk = book.bestAsk;
      let price;

      if (side === "bid") {
        const joined = bestBid ?? roundTick(this.fairPrice - 0.2);
        const improved = bestAsk !== null ? roundTick(Math.min(bestAsk - TICK_SIZE, joined + TICK_SIZE)) : joined;
        price = mode === "improve" ? improved : joined;
        price = Math.max(TICK_SIZE, price);
      } else {
        const joined = bestAsk ?? roundTick(this.fairPrice + 0.2);
        const improved = bestBid !== null ? roundTick(Math.max(bestBid + TICK_SIZE, joined - TICK_SIZE)) : joined;
        price = mode === "improve" ? improved : joined;
      }

      const order = {
        id: `player-${side}-${this.tick}-${this.nextPriority()}`,
        owner: "player",
        side,
        price,
        qty,
        ts: this.nextPriority(),
      };

      if (side === "bid") {
        this.player.bidOrder = order;
      } else {
        this.player.askOrder = order;
      }

      this.log({
        kind: "info",
        message: `Player placed ${side.toUpperCase()} ${qty} @ ${format(price)}.`,
      });
    }

    executeMarketOrder(actor, direction, qty) {
      const wants = direction === "buy" ? "ask" : "bid";
      const levels = this.bookLevels(wants, actor);
      let remaining = qty;

      for (const level of levels) {
        if (remaining <= 0) {
          break;
        }
        if (level.qty <= 0) {
          continue;
        }

        const fillQty = Math.min(remaining, level.qty);
        remaining -= fillQty;
        this.applyFill(actor, level.owner, direction, level.price, fillQty, level);
      }

      if (remaining > 0) {
        this.log({
          kind: "info",
          message: `${this.actorName(actor)} swept the visible book and left ${remaining} unfilled.`,
        });
      }
    }

    applyFill(taker, maker, direction, price, qty, level) {
      const buyer = direction === "buy" ? taker : maker;
      const seller = direction === "buy" ? maker : taker;
      this.transferInventory(buyer, qty, -price * qty);
      this.transferInventory(seller, -qty, price * qty);

      if (level.owner === "player") {
        this.reduceOrder(this.player, level.side, qty);
      } else if (level.owner === "bot") {
        this.reduceOrder(this.bot, level.side, qty);
      } else {
        this.reduceAmbient(level.side, level.id, qty);
      }

      this.lastTrade = price;
      const cssKind =
        taker === "player" ? `${direction}-fill` : maker === "bot" ? "bot-fill" : direction === "buy" ? "buy-fill" : "sell-fill";
      this.log({
        kind: cssKind,
        message: `${this.actorName(taker)} ${direction.toUpperCase()} ${qty} @ ${format(price)} against ${this.actorName(maker)}.`,
      });
    }

    transferInventory(actor, inventoryDelta, cashDelta) {
      if (actor === "player") {
        this.player.inventory += inventoryDelta;
        this.player.cash += cashDelta;
      } else if (actor === "bot") {
        this.bot.inventory += inventoryDelta;
        this.bot.cash += cashDelta;
      }
    }

    reduceOrder(account, side, qty) {
      const key = side === "bid" ? "bidOrder" : "askOrder";
      if (!account[key]) {
        return;
      }
      account[key].qty -= qty;
      if (account[key].qty <= 0) {
        account[key] = null;
      }
    }

    reduceAmbient(side, id, qty) {
      const levels = side === "bid" ? this.ambient.bids : this.ambient.asks;
      const level = levels.find((entry) => entry.id === id);
      if (!level) {
        return;
      }
      level.qty -= qty;
      if (level.qty <= 0) {
        const index = levels.indexOf(level);
        if (index >= 0) {
          levels.splice(index, 1);
        }
      }
    }

    simulateExternalFlow() {
      const bursts = 1 + (this.rng() > 0.82 ? 1 : 0);

      for (let i = 0; i < bursts; i += 1) {
        const bias = this.externalPressure * 0.18 + this.bot.inventory * 0.003;
        const buyProb = clamp(0.5 + bias, 0.18, 0.82);
        const direction = this.rng() < buyProb ? "buy" : "sell";
        const qty = 1 + Math.floor(this.rng() * 4);
        this.executeMarketOrder("flow", direction, qty);
      }
    }

    currentBook() {
      const bids = this.bookLevels("bid", null);
      const asks = this.bookLevels("ask", null);
      return {
        bestBid: bids.length ? bids[0].price : null,
        bestAsk: asks.length ? asks[0].price : null,
        bids,
        asks,
      };
    }

    bookLevels(side, taker) {
      const levels = [];
      const ownBook = side === "bid" ? "bidOrder" : "askOrder";
      const ambientLevels = side === "bid" ? this.ambient.bids : this.ambient.asks;

      for (const level of ambientLevels) {
        levels.push({ ...level });
      }
      if (this.bot[ownBook]) {
        levels.push({ ...this.bot[ownBook] });
      }
      if (this.player[ownBook]) {
        levels.push({ ...this.player[ownBook] });
      }

      const filtered = levels.filter((level) => {
        if (taker === "player" && level.owner === "player") {
          return false;
        }
        if (taker === "bot" && level.owner === "bot") {
          return false;
        }
        return level.qty > 0;
      });

      filtered.sort((a, b) => {
        if (side === "bid") {
          if (b.price !== a.price) {
            return b.price - a.price;
          }
        } else if (a.price !== b.price) {
          return a.price - b.price;
        }
        return a.ts - b.ts;
      });

      const merged = [];
      for (const level of filtered) {
        const last = merged[merged.length - 1];
        if (last && last.price === level.price && last.owner === level.owner) {
          last.qty += level.qty;
        } else {
          merged.push({ ...level });
        }
      }
      return merged;
    }

    snapshot() {
      const book = this.currentBook();
      const mid =
        book.bestBid !== null && book.bestAsk !== null
          ? roundTick((book.bestBid + book.bestAsk) / 2)
          : this.fairPrice;
      const playerMtm = this.player.cash + this.player.inventory * mid;
      const botMtm = this.bot.cash + this.bot.inventory * mid;

      if (this.tick >= this.maxTicks) {
        this.bestScore = Math.max(this.bestScore, playerMtm);
        window.localStorage.setItem(STORAGE_KEY, String(this.bestScore));
      }

      return {
        seed: this.seed,
        tick: this.tick,
        maxTicks: this.maxTicks,
        state: this.state,
        regime: this.regime,
        market: {
          bestBid: book.bestBid,
          bestAsk: book.bestAsk,
          mid,
          spread: book.bestBid !== null && book.bestAsk !== null ? roundTick(book.bestAsk - book.bestBid) : null,
          volatility: this.currentVolatility(),
          bids: book.bids.slice(0, 6),
          asks: book.asks.slice(0, 6),
        },
        player: {
          inventory: this.player.inventory,
          cash: this.player.cash,
          mtm: playerMtm,
          bidOrder: this.player.bidOrder,
          askOrder: this.player.askOrder,
        },
        bot: {
          inventory: this.bot.inventory,
          cash: this.bot.cash,
          mtm: botMtm,
          bidOrder: this.bot.bidOrder,
          askOrder: this.bot.askOrder,
        },
        tape: this.tape.slice(0, 14),
        winner:
          this.tick >= this.maxTicks
            ? playerMtm === botMtm
              ? "tie"
              : playerMtm > botMtm
                ? "player"
                : "bot"
            : null,
        bestScore: this.bestScore,
      };
    }

    finishRound() {
      this.state = "finished";
    }

    currentVolatility() {
      if (!this.returns.length) {
        return 0.1;
      }
      const mean = this.returns.reduce((sum, value) => sum + value, 0) / this.returns.length;
      return roundTick(mean + 0.1);
    }

    nextPriority() {
      this.timePriority += 1;
      return this.timePriority;
    }

    actorName(actor) {
      if (actor === "player") {
        return "Player";
      }
      if (actor === "bot") {
        return BOT_NAME;
      }
      if (actor === "ambient") {
        return "Market";
      }
      return "Flow";
    }

    log(entry) {
      this.tape.unshift({
        ...entry,
        tick: this.tick,
      });
      if (this.tape.length > 18) {
        this.tape.length = 18;
      }
    }
  }

  const elements = {
    seedInput: document.getElementById("seed-input"),
    qtyInput: document.getElementById("qty-input"),
    copySeedLink: document.getElementById("copy-seed-link"),
    playerMtm: document.getElementById("player-mtm"),
    botMtm: document.getElementById("bot-mtm"),
    bestScore: document.getElementById("best-score"),
    roundStatus: document.getElementById("round-status"),
    bestBid: document.getElementById("best-bid"),
    bestAsk: document.getElementById("best-ask"),
    mid: document.getElementById("mid"),
    spread: document.getElementById("spread"),
    volatility: document.getElementById("volatility"),
    regime: document.getElementById("regime"),
    stateLabel: document.getElementById("state-label"),
    playerInventory: document.getElementById("player-inventory"),
    botInventory: document.getElementById("bot-inventory"),
    playerCash: document.getElementById("player-cash"),
    botCash: document.getElementById("bot-cash"),
    bidBook: document.getElementById("bid-book"),
    askBook: document.getElementById("ask-book"),
    tape: document.getElementById("tape"),
  };

  let engine = new GameEngine(parseSeedFromUrl() || randomSeed());

  function renderLevels(target, levels) {
    target.innerHTML = "";
    levels.forEach((level) => {
      const li = document.createElement("li");
      li.className = level.owner;
      li.textContent = `${format(level.price)} x ${level.qty} · ${level.owner}`;
      target.appendChild(li);
    });
  }

  function renderTape(entries) {
    elements.tape.innerHTML = "";
    entries.forEach((entry) => {
      const li = document.createElement("li");
      li.className = entry.kind;
      li.textContent = `t=${entry.tick} · ${entry.message}`;
      elements.tape.appendChild(li);
    });
  }

  function render() {
    const snapshot = engine.snapshot();
    elements.seedInput.value = snapshot.seed;
    elements.playerMtm.textContent = format(snapshot.player.mtm);
    elements.botMtm.textContent = format(snapshot.bot.mtm);
    elements.bestScore.textContent = format(snapshot.bestScore);
    elements.roundStatus.textContent = `${snapshot.tick} / ${snapshot.maxTicks}`;
    elements.bestBid.textContent = format(snapshot.market.bestBid);
    elements.bestAsk.textContent = format(snapshot.market.bestAsk);
    elements.mid.textContent = format(snapshot.market.mid);
    elements.spread.textContent = format(snapshot.market.spread);
    elements.volatility.textContent = format(snapshot.market.volatility);
    elements.regime.textContent = snapshot.regime;
    elements.stateLabel.textContent =
      snapshot.state === "finished" && snapshot.winner
        ? `finished · ${snapshot.winner}`
        : snapshot.state;
    elements.playerInventory.textContent = String(snapshot.player.inventory);
    elements.botInventory.textContent = String(snapshot.bot.inventory);
    elements.playerCash.textContent = format(snapshot.player.cash);
    elements.botCash.textContent = format(snapshot.bot.cash);

    renderLevels(elements.bidBook, snapshot.market.bids);
    renderLevels(elements.askBook, snapshot.market.asks);
    renderTape(snapshot.tape);
  }

  function qtyValue() {
    return clamp(Number(elements.qtyInput.value) || DEFAULT_QTY, 1, 10);
  }

  function handleAction(action) {
    engine.act(action, qtyValue());
    render();
  }

  function tickLoop() {
    if (engine.state === "running") {
      engine.act("wait", qtyValue());
      render();
    }
  }

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAction(button.dataset.action);
    });
  });

  elements.seedInput.addEventListener("change", () => {
    engine.reset(elements.seedInput.value.trim() || randomSeed());
    render();
  });

  elements.copySeedLink.addEventListener("click", async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("seed", elements.seedInput.value.trim() || engine.seed);
    try {
      await copyText(url.toString());
      elements.copySeedLink.textContent = "Copied";
      window.setTimeout(() => {
        elements.copySeedLink.textContent = "Copy Link";
      }, 1200);
    } catch (error) {
      elements.copySeedLink.textContent = "Copy Failed";
      window.setTimeout(() => {
        elements.copySeedLink.textContent = "Copy Link";
      }, 1200);
    }
  });

  window.__marketMakingSim = {
    getSnapshot: () => engine.snapshot(),
    act: (action, qty) => engine.act(action, qty),
    reset: (seed) => engine.reset(seed),
  };

  window.setInterval(tickLoop, 1000);
  render();
})();
