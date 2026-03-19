(function () {
  const STORAGE_KEY = "market-making-sim.interview-best-score";
  const TICK = 0.05;
  const MAX_TURNS = 10;
  const TURN_SECONDS = 30;
  const DEFAULT_SIZE = 4;
  const SCRIPT_NAME = "Counterparty Script";
  const SCRIPT_PROFILES = ["patient", "inventory-sensitive", "aggressive"];

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function roundTick(value) {
    return Math.round(value / TICK) * TICK;
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

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, String(value));
    } catch (error) {
      // ignore storage failures in restricted environments
    }
  }

  class InterviewGame {
    constructor(seedText) {
      this.reset(seedText || randomSeed());
    }

    reset(seedText) {
      this.seed = (seedText || randomSeed()).toUpperCase();
      this.rng = makeRng(this.seed);
      this.profile = SCRIPT_PROFILES[Math.floor(this.rng() * SCRIPT_PROFILES.length)];
      this.mode = "ready";
      this.turn = 0;
      this.maxTurns = MAX_TURNS;
      this.bestScore = Number(safeStorageGet(STORAGE_KEY) || 0);
      this.player = { cash: 0, inventory: 0 };
      this.script = { inventory: 0, lastDecisionAt: null };
      this.referencePrice = roundTick(100 + this.rng() * 8 - 4);
      this.previousClose = this.referencePrice;
      this.lastMark = this.referencePrice;
      this.lastQuote = null;
      this.lastResponse = {
        action: "Press start to begin.",
        reason: "The round stays idle until the player explicitly starts it.",
        markAfter: this.lastMark,
      };
      this.shotClock = TURN_SECONDS;
      this.turnStartedAt = null;
      this.missedTurns = 0;
      this.recentMarks = [this.referencePrice];
      this.history = [];
      this.currentTurn = null;
      setSeedOnUrl(this.seed);
      return this.snapshot();
    }

    start() {
      if (this.mode === "quote") {
        return this.snapshot();
      }
      this.mode = "quote";
      this.turn = 0;
      this.player = { cash: 0, inventory: 0 };
      this.script = { inventory: 0, lastDecisionAt: null };
      this.previousClose = this.referencePrice;
      this.lastMark = this.referencePrice;
      this.lastQuote = null;
      this.lastResponse = {
        action: "Round started.",
        reason: "Quote a two-way market. The script can trade only once per turn.",
        markAfter: this.lastMark,
      };
      this.missedTurns = 0;
      this.history = [];
      this.recentMarks = [this.referencePrice];
      this.prepareTurn();
      return this.snapshot();
    }

    updateClock() {
      if (this.mode !== "quote" || !this.turnStartedAt) {
        return this.snapshot();
      }
      const elapsed = Math.floor((Date.now() - this.turnStartedAt) / 1000);
      this.shotClock = clamp(TURN_SECONDS - elapsed, 0, TURN_SECONDS);
      if (this.shotClock <= 0) {
        this.handleTimeout();
      }
      return this.snapshot();
    }

    prepareTurn() {
      if (this.turn >= this.maxTurns) {
        this.finishRound();
        return;
      }

      this.turn += 1;
      const rawShock = signedNormalish(this.rng);
      const momentum = this.recentMarks.length >= 2
        ? this.recentMarks[this.recentMarks.length - 1] - this.recentMarks[this.recentMarks.length - 2]
        : 0;
      const volatility = clamp(0.12 + Math.abs(rawShock) * 0.22 + Math.abs(momentum) * 0.25, 0.12, 0.55);
      const flowBias = signedNormalish(this.rng) * 0.35;
      const pressure = signedNormalish(this.rng) * 0.25;

      this.previousClose = this.lastMark;
      this.referencePrice = roundTick(
        Math.max(
          25,
          this.lastMark + momentum * 0.25 + pressure * 0.18 + rawShock * volatility * 0.4
        )
      );

      const hiddenFair = roundTick(
        this.referencePrice + flowBias * 0.45 + momentum * 0.35 + pressure * 0.15
      );

      const baseHalfWidth = roundTick(
        Math.max(TICK * 2, 0.12 + volatility * 0.3 + Math.abs(this.player.inventory) * 0.01)
      );

      this.currentTurn = {
        referencePrice: this.referencePrice,
        volatility,
        momentum,
        flowBias,
        pressure,
        hiddenFair,
        suggestedBid: roundTick(this.referencePrice - baseHalfWidth),
        suggestedAsk: roundTick(this.referencePrice + baseHalfWidth),
      };

      this.turnStartedAt = Date.now();
      this.shotClock = TURN_SECONDS;
    }

    preset(widthName) {
      if (!this.currentTurn) {
        return null;
      }

      const widths = {
        tight: roundTick(Math.max(TICK * 2, this.currentTurn.volatility * 0.22)),
        normal: roundTick(Math.max(TICK * 3, this.currentTurn.volatility * 0.34)),
        wide: roundTick(Math.max(TICK * 4, this.currentTurn.volatility * 0.48)),
      };
      const halfWidth = widths[widthName] || widths.normal;
      return {
        bid: roundTick(this.currentTurn.referencePrice - halfWidth),
        ask: roundTick(this.currentTurn.referencePrice + halfWidth),
      };
    }

    submitQuote(bidValue, askValue, sizeValue) {
      if (this.mode !== "quote" || !this.currentTurn) {
        return this.snapshot();
      }

      this.updateClock();
      if (this.mode !== "quote") {
        return this.snapshot();
      }

      const bid = roundTick(Number(bidValue));
      const ask = roundTick(Number(askValue));
      const size = clamp(Number(sizeValue) || DEFAULT_SIZE, 1, 10);

      if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
        this.lastResponse = {
          action: "Invalid quote.",
          reason: "Both bid and ask must be numeric prices.",
          markAfter: this.lastMark,
        };
        return this.snapshot();
      }
      if (ask <= bid) {
        this.lastResponse = {
          action: "Invalid quote.",
          reason: "Ask must be strictly above bid.",
          markAfter: this.lastMark,
        };
        return this.snapshot();
      }

      this.lastQuote = { bid, ask, size };
      const decision = this.resolveScriptDecision(bid, ask, size);
      this.script.lastDecisionAt = Date.now();

      if (decision.side === "buy") {
        this.player.inventory -= decision.qty;
        this.player.cash += ask * decision.qty;
        this.script.inventory += decision.qty;
      } else if (decision.side === "sell") {
        this.player.inventory += decision.qty;
        this.player.cash -= bid * decision.qty;
        this.script.inventory -= decision.qty;
      }

      const markMove =
        (this.currentTurn.hiddenFair - this.currentTurn.referencePrice) * 0.45 +
        signedNormalish(this.rng) * this.currentTurn.volatility * 0.25 +
        (decision.side === "buy" ? 0.08 : decision.side === "sell" ? -0.08 : 0);

      this.lastMark = roundTick(Math.max(25, this.currentTurn.referencePrice + markMove));
      this.recentMarks.push(this.lastMark);
      if (this.recentMarks.length > 6) {
        this.recentMarks.shift();
      }

      this.lastResponse = {
        action: decision.headline,
        reason: decision.reason,
        markAfter: this.lastMark,
      };

      this.history.unshift({
        turn: this.turn,
        kind: decision.kind,
        text: `Turn ${this.turn}: ${decision.headline} | You quoted ${format(bid)} / ${format(ask)} x ${size}.`,
      });
      if (this.history.length > 18) {
        this.history.length = 18;
      }

      if (this.turn >= this.maxTurns) {
        this.finishRound();
      } else {
        this.prepareTurn();
      }

      return this.snapshot();
    }

    resolveScriptDecision(bid, ask, size) {
      const hiddenFair = this.currentTurn.hiddenFair;
      const volatility = this.currentTurn.volatility;
      const thresholdBase =
        this.profile === "aggressive" ? 0.04 : this.profile === "inventory-sensitive" ? 0.07 : 0.055;
      const inventoryDrag =
        this.profile === "inventory-sensitive" ? Math.abs(this.script.inventory) * 0.01 : Math.abs(this.script.inventory) * 0.005;
      const threshold = roundTick(thresholdBase + volatility * 0.12 + inventoryDrag + Math.max(0, size - 4) * 0.01);

      const buyEdge = hiddenFair - ask;
      const sellEdge = bid - hiddenFair;

      if (buyEdge > threshold && buyEdge >= sellEdge) {
        const qty = clamp(Math.ceil((buyEdge - threshold) / TICK) + 1, 1, size);
        return {
          side: "buy",
          qty,
          kind: "buy",
          headline: `${SCRIPT_NAME} buys ${qty} from your ask at ${format(ask)}.`,
          reason: `Your ask traded through the script's internal fair by ${format(buyEdge)}.`,
        };
      }

      if (sellEdge > threshold) {
        const qty = clamp(Math.ceil((sellEdge - threshold) / TICK) + 1, 1, size);
        return {
          side: "sell",
          qty,
          kind: "sell",
          headline: `${SCRIPT_NAME} sells ${qty} to your bid at ${format(bid)}.`,
          reason: `Your bid was rich relative to the script's internal fair by ${format(sellEdge)}.`,
        };
      }

      return {
        side: "pass",
        qty: 0,
        kind: "pass",
        headline: `${SCRIPT_NAME} passes.`,
        reason: "Your spread was defensible enough that the script declined to trade.",
      };
    }

    handleTimeout() {
      if (this.mode !== "quote" || !this.currentTurn) {
        return this.snapshot();
      }

      this.missedTurns += 1;
      this.lastMark = roundTick(
        Math.max(
          25,
          this.currentTurn.referencePrice +
            signedNormalish(this.rng) * this.currentTurn.volatility * 0.28 +
            this.currentTurn.flowBias * 0.18
        )
      );
      this.recentMarks.push(this.lastMark);
      if (this.recentMarks.length > 6) {
        this.recentMarks.shift();
      }

      this.lastResponse = {
        action: "Turn forfeited.",
        reason: "No quote was submitted before the 30-second shot clock expired.",
        markAfter: this.lastMark,
      };

      this.history.unshift({
        turn: this.turn,
        kind: "timeout",
        text: `Turn ${this.turn}: no quote submitted before the shot clock expired.`,
      });
      if (this.history.length > 18) {
        this.history.length = 18;
      }

      if (this.turn >= this.maxTurns) {
        this.finishRound();
      } else {
        this.prepareTurn();
      }

      return this.snapshot();
    }

    finishRound() {
      this.mode = "finished";
      this.turnStartedAt = null;
      this.shotClock = 0;
      this.lastMark = roundTick(this.lastMark);
      const score = this.adjustedScore();
      this.bestScore = Math.max(this.bestScore, score);
      safeStorageSet(STORAGE_KEY, this.bestScore);
      this.lastResponse = {
        action: "Round complete.",
        reason: "Final score includes inventory and missed-turn penalties.",
        markAfter: this.lastMark,
      };
    }

    rawMtm() {
      return this.player.cash + this.player.inventory * this.lastMark;
    }

    inventoryPenalty() {
      return Math.abs(this.player.inventory) * 0.35 + this.missedTurns * 0.25;
    }

    adjustedScore() {
      return this.rawMtm() - this.inventoryPenalty();
    }

    flowHint() {
      const x = this.currentTurn ? this.currentTurn.flowBias : 0;
      if (x > 0.18) {
        return "buyer skew";
      }
      if (x < -0.18) {
        return "seller skew";
      }
      return "two-way";
    }

    pressureHint() {
      const x = this.currentTurn ? this.currentTurn.pressure : 0;
      if (x > 0.12) {
        return "up pressure";
      }
      if (x < -0.12) {
        return "down pressure";
      }
      return "balanced";
    }

    snapshot() {
      return {
        seed: this.seed,
        mode: this.mode,
        turn: this.turn,
        maxTurns: this.maxTurns,
        shotClock: this.shotClock,
        profile: this.profile,
        referencePrice: this.currentTurn ? this.currentTurn.referencePrice : this.referencePrice,
        previousClose: this.previousClose,
        lastMark: this.lastMark,
        volatility: this.currentTurn ? this.currentTurn.volatility : 0,
        momentum: this.currentTurn ? this.currentTurn.momentum : 0,
        flowHint: this.flowHint(),
        pressureHint: this.pressureHint(),
        suggestedBid: this.currentTurn ? this.currentTurn.suggestedBid : null,
        suggestedAsk: this.currentTurn ? this.currentTurn.suggestedAsk : null,
        rawMtm: this.rawMtm(),
        adjustedScore: this.adjustedScore(),
        bestScore: this.bestScore,
        inventoryPenalty: this.inventoryPenalty(),
        player: { ...this.player },
        lastQuote: this.lastQuote,
        lastResponse: this.lastResponse,
        missedTurns: this.missedTurns,
        history: this.history.slice(0, 12),
      };
    }
  }

  const elements = {
    seedInput: document.getElementById("seed-input"),
    copySeedLink: document.getElementById("copy-seed-link"),
    randomizeSeed: document.getElementById("randomize-seed"),
    startButton: document.getElementById("start-button"),
    adjustedScore: document.getElementById("adjusted-score"),
    rawMtm: document.getElementById("raw-mtm"),
    bestScore: document.getElementById("best-score"),
    roundStatus: document.getElementById("round-status"),
    shotClock: document.getElementById("shot-clock"),
    stateLabel: document.getElementById("state-label"),
    inventory: document.getElementById("inventory"),
    cash: document.getElementById("cash"),
    refPrice: document.getElementById("ref-price"),
    prevClose: document.getElementById("prev-close"),
    lastMark: document.getElementById("last-mark"),
    volatility: document.getElementById("volatility"),
    momentum: document.getElementById("momentum"),
    flowHint: document.getElementById("flow-hint"),
    pressureHint: document.getElementById("pressure-hint"),
    bidInput: document.getElementById("bid-input"),
    askInput: document.getElementById("ask-input"),
    sizeInput: document.getElementById("size-input"),
    submitQuote: document.getElementById("submit-quote"),
    skipTurn: document.getElementById("skip-turn"),
    suggestedBid: document.getElementById("suggested-bid"),
    suggestedAsk: document.getElementById("suggested-ask"),
    lastQuoteBid: document.getElementById("last-quote-bid"),
    lastQuoteAsk: document.getElementById("last-quote-ask"),
    scriptAction: document.getElementById("script-action"),
    scriptReason: document.getElementById("script-reason"),
    botProfile: document.getElementById("bot-profile"),
    markAfter: document.getElementById("mark-after"),
    missedTurns: document.getElementById("missed-turns"),
    inventoryPenalty: document.getElementById("inventory-penalty"),
    historyList: document.getElementById("history-list"),
  };

  let game = new InterviewGame(parseSeedFromUrl() || randomSeed());
  let renderedTurn = -1;

  function renderHistory(items) {
    elements.historyList.innerHTML = "";
    items.forEach((item) => {
      const li = document.createElement("li");
      li.className = item.kind;
      li.textContent = item.text;
      elements.historyList.appendChild(li);
    });
  }

  function applySuggestedQuote(snapshot) {
    if (snapshot.turn !== renderedTurn && snapshot.mode === "quote") {
      elements.bidInput.value = format(snapshot.suggestedBid, 2);
      elements.askInput.value = format(snapshot.suggestedAsk, 2);
      elements.sizeInput.value = String(DEFAULT_SIZE);
    }
  }

  function render() {
    const snapshot = game.snapshot();
    applySuggestedQuote(snapshot);
    renderedTurn = snapshot.turn;

    elements.seedInput.value = snapshot.seed;
    elements.adjustedScore.textContent = format(snapshot.adjustedScore);
    elements.rawMtm.textContent = format(snapshot.rawMtm);
    elements.bestScore.textContent = format(snapshot.bestScore);
    elements.roundStatus.textContent = `${snapshot.turn} / ${snapshot.maxTurns}`;
    elements.shotClock.textContent = `${snapshot.shotClock}s`;
    elements.stateLabel.textContent = snapshot.mode;
    elements.inventory.textContent = String(snapshot.player.inventory);
    elements.cash.textContent = format(snapshot.player.cash);
    elements.refPrice.textContent = format(snapshot.referencePrice);
    elements.prevClose.textContent = format(snapshot.previousClose);
    elements.lastMark.textContent = format(snapshot.lastMark);
    elements.volatility.textContent = format(snapshot.volatility);
    elements.momentum.textContent = format(snapshot.momentum);
    elements.flowHint.textContent = snapshot.flowHint;
    elements.pressureHint.textContent = snapshot.pressureHint;
    elements.suggestedBid.textContent = format(snapshot.suggestedBid);
    elements.suggestedAsk.textContent = format(snapshot.suggestedAsk);
    elements.lastQuoteBid.textContent = snapshot.lastQuote ? format(snapshot.lastQuote.bid) : "-";
    elements.lastQuoteAsk.textContent = snapshot.lastQuote ? format(snapshot.lastQuote.ask) : "-";
    elements.scriptAction.textContent = snapshot.lastResponse.action;
    elements.scriptReason.textContent = snapshot.lastResponse.reason;
    elements.botProfile.textContent = snapshot.profile;
    elements.markAfter.textContent = format(snapshot.lastResponse.markAfter);
    elements.missedTurns.textContent = String(snapshot.missedTurns);
    elements.inventoryPenalty.textContent = format(snapshot.inventoryPenalty);
    elements.startButton.textContent = snapshot.mode === "ready" ? "Start Interview" : "Restart Interview";
    elements.submitQuote.disabled = snapshot.mode !== "quote";
    elements.skipTurn.disabled = snapshot.mode !== "quote";

    renderHistory(snapshot.history);
  }

  function submitQuote() {
    game.submitQuote(elements.bidInput.value, elements.askInput.value, elements.sizeInput.value);
    render();
  }

  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      const preset = game.preset(button.dataset.preset);
      if (!preset) {
        return;
      }
      elements.bidInput.value = format(preset.bid);
      elements.askInput.value = format(preset.ask);
    });
  });

  elements.startButton.addEventListener("click", () => {
    if (game.mode === "ready" || game.mode === "finished") {
      game.start();
    } else {
      game.reset(elements.seedInput.value.trim() || randomSeed());
      game.start();
    }
    render();
  });

  elements.submitQuote.addEventListener("click", submitQuote);
  elements.skipTurn.addEventListener("click", () => {
    game.handleTimeout();
    render();
  });

  elements.seedInput.addEventListener("change", () => {
    game.reset(elements.seedInput.value.trim() || randomSeed());
    render();
  });

  elements.randomizeSeed.addEventListener("click", () => {
    game.reset(randomSeed());
    render();
  });

  elements.copySeedLink.addEventListener("click", async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("seed", elements.seedInput.value.trim() || game.seed);
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
    snapshot: () => game.snapshot(),
    reset: (seed) => game.reset(seed),
    start: () => game.start(),
    submitQuote: (bid, ask, size) => game.submitQuote(bid, ask, size),
    timeout: () => game.handleTimeout(),
  };

  window.setInterval(() => {
    if (game.mode === "quote") {
      game.updateClock();
      render();
    }
  }, 1000);

  render();
})();
