(function () {
  const STORAGE_KEY = "market-making-sim.interview-best-score";
  const TICK = 0.05;
  const MAX_TURNS = 10;
  const TURN_SECONDS = 30;
  const DEFAULT_SIZE = 4;
  const SCRIPT_NAME = "Counterparty Script";
  const SCRIPT_PROFILES = ["patient", "inventory-sensitive", "aggressive"];
  const ASSET_SCENARIOS = Array.isArray(window.ASSET_SCENARIOS) ? window.ASSET_SCENARIOS : [];

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

  function volBand(value) {
    if (value >= 0.5) {
      return "high";
    }
    if (value >= 0.3) {
      return "medium";
    }
    return "low";
  }

  function spreadBand(value) {
    if (value >= 0.16) {
      return "wide";
    }
    if (value >= 0.08) {
      return "medium";
    }
    return "tight";
  }

  function capWords(value) {
    return String(value)
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
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

    chooseScenario(seedText) {
      if (!ASSET_SCENARIOS.length) {
        return {
          ticker: "SIM",
          name: "Estimated number of pianos in a medium-sized city",
          sector: "Fallback Contract",
          exchange: "count",
          scenario: "Fallback estimate",
          sessionDate: "anchor 32000",
          description: "Fallback contract used when no scenario pack is available. Plausible range: 22000 to 41000 count.",
          strategyNote: "Quote a balanced two-way market and manage inventory conservatively.",
          averageSpread: 0.1,
          realizedVol: 0.3,
          flowTone: "balanced",
          recentPath: [99.4, 99.8, 100.0, 100.1, 100.2, 100.3],
          turnMarks: [100.4, 100.5, 100.6, 100.4, 100.7, 100.8, 100.9, 101.0, 100.8, 100.9, 101.1],
          initialClue: "This is a pure estimation contract with no live order book behind it.",
          benchmarkText: "A quick households-times-ownership heuristic gives a rough center estimate.",
          valueRange: { low: 22000, high: 41000 },
        };
      }
      const pick = hashString(seedText || "market-making");
      const index = pick() % ASSET_SCENARIOS.length;
      return ASSET_SCENARIOS[index];
    }

    reset(seedText) {
      this.seed = (seedText || randomSeed()).toUpperCase();
      this.rng = makeRng(this.seed);
      this.asset = this.chooseScenario(this.seed);
      this.profile = SCRIPT_PROFILES[Math.floor(this.rng() * SCRIPT_PROFILES.length)];
      this.mode = "ready";
      this.turn = 0;
      this.maxTurns = MAX_TURNS;
      this.bestScore = Number(safeStorageGet(STORAGE_KEY) || 0);
      this.player = { cash: 0, inventory: 0 };
      this.script = { inventory: 0, lastDecisionAt: null };
      this.referencePrice = roundTick(this.asset.turnMarks[0]);
      this.previousClose = roundTick(this.asset.recentPath[this.asset.recentPath.length - 1]);
      this.lastMark = this.referencePrice;
      this.lastQuote = null;
      this.lastResponse = {
        action: "Press start to begin.",
        reason: "Read the contract brief, think about the likely range, then press start when you are ready to make a two-sided market.",
        markAfter: this.lastMark,
      };
      this.shotClock = TURN_SECONDS;
      this.turnStartedAt = null;
      this.missedTurns = 0;
      this.recentMarks = this.asset.recentPath.slice(-4).map((value) => roundTick(value)).concat([this.referencePrice]);
      this.history = [];
      this.currentTurn = null;
      this.clues = this.buildClues(this.asset);
      setSeedOnUrl(this.seed);
      return this.snapshot();
    }

    buildClues(asset) {
      const recentStart = asset.recentPath[0];
      const recentEnd = asset.recentPath[asset.recentPath.length - 1];
      const recentMove = roundTick(recentEnd - recentStart);
      const spreadStyle =
        asset.averageSpread <= 0.08 ? "tight-spread" : asset.averageSpread <= 0.15 ? "medium-spread" : "wide-spread";
      return [
        `Contract settles to the hidden final estimate for: ${asset.name}.`,
        asset.initialClue,
        asset.benchmarkText,
        `This is a ${spreadStyle}, ${asset.flowTone} contract with a plausible range of ${asset.valueRange.low} to ${asset.valueRange.high}.`,
        `The public reference path moved ${format(recentMove)} across the last ${asset.recentPath.length} observations.`,
        asset.strategyNote,
      ];
    }

    settlementValue() {
      return roundTick(this.asset.turnMarks[this.asset.turnMarks.length - 1]);
    }

    start() {
      if (this.mode === "quote") {
        return this.snapshot();
      }
      this.mode = "quote";
      this.turn = 0;
      this.player = { cash: 0, inventory: 0 };
      this.script = { inventory: 0, lastDecisionAt: null };
      this.referencePrice = roundTick(this.asset.turnMarks[0]);
      this.previousClose = roundTick(this.asset.recentPath[this.asset.recentPath.length - 1]);
      this.lastMark = this.referencePrice;
      this.lastQuote = null;
      this.lastResponse = {
        action: "Round started.",
        reason: `Make a bid and ask in ${this.asset.exchange}. The interviewer will buy your ask, sell your bid, or pass once this turn.`,
        markAfter: this.lastMark,
      };
      this.missedTurns = 0;
      this.history = [];
      this.recentMarks = this.asset.recentPath.slice(-4).map((value) => roundTick(value)).concat([this.referencePrice]);
      this.clues = this.buildClues(this.asset);
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
      const pathIndex = Math.min(this.turn - 1, this.asset.turnMarks.length - 2);
      const pathNow = roundTick(this.asset.turnMarks[pathIndex]);
      const pathNext = roundTick(this.asset.turnMarks[pathIndex + 1]);
      const momentum = roundTick(pathNow - this.previousClose);
      const realizedVol = clamp(this.asset.realizedVol, 0.12, 0.8);
      const volatility = clamp(
        realizedVol * 0.65 + Math.abs(momentum) * 0.18 + Math.abs(signedNormalish(this.rng)) * 0.08,
        0.12,
        0.75
      );
      const flowBiasBase =
        this.asset.flowTone === "buyer-led" ? 0.22 : this.asset.flowTone === "seller-led" ? -0.22 : 0.0;
      const flowBias = flowBiasBase + signedNormalish(this.rng) * 0.12;
      const pressure = signedNormalish(this.rng) * 0.12 + (pathNext - pathNow) * 0.08;

      this.previousClose = this.lastMark;
      this.referencePrice = pathNow;

      const hiddenFair = roundTick(pathNext + flowBias * 0.15);

      const baseHalfWidth = roundTick(
        Math.max(this.asset.averageSpread / 2, 0.12 + volatility * 0.3 + Math.abs(this.player.inventory) * 0.01)
      );

      this.currentTurn = {
        referencePrice: this.referencePrice,
        volatility,
        momentum,
        flowBias,
        pressure,
        hiddenFair,
        clue: this.clues[Math.min(this.turn - 1, this.clues.length - 1)],
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
        reason: `${decision.reason} The contract remains in a ${this.asset.flowTone} setup and settles to the hidden final estimate.`,
        markAfter: this.lastMark,
      };

      this.history.unshift({
        turn: this.turn,
        kind: decision.kind,
        text: `Turn ${this.turn}. ${this.currentTurn.clue} You made ${format(bid)} bid and ${format(ask)} ask for ${size}. ${decision.headline} Mark moved to ${format(this.lastMark)} and your inventory is now ${this.player.inventory}.`,
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
        reason: "No market was submitted before the 30-second shot clock expired, so the turn was forfeited.",
        markAfter: this.lastMark,
      };

      this.history.unshift({
        turn: this.turn,
        kind: "timeout",
        text: `Turn ${this.turn}. No quote was submitted before the 30-second shot clock expired, so the turn was forfeited and the mark drifted to ${format(this.lastMark)}.`,
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
        reason: `Settlement revealed at ${format(this.settlementValue())} ${this.asset.exchange}. Final score equals cash plus inventory times settlement, minus penalties.`,
        markAfter: this.settlementValue(),
      };
    }

    rawMtm() {
      const mark = this.mode === "finished" ? this.settlementValue() : this.lastMark;
      return this.player.cash + this.player.inventory * mark;
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
        asset: this.asset,
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
        currentClue: this.currentTurn ? this.currentTurn.clue : this.clues[0],
        revealedClues: this.clues.slice(0, Math.max(1, this.turn)),
        settlementValue: this.mode === "finished" ? this.settlementValue() : null,
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
    flowToneCard: document.getElementById("flow-tone-card"),
    lastMark: document.getElementById("last-mark"),
    volBand: document.getElementById("vol-band"),
    spreadBand: document.getElementById("spread-band"),
    scriptStyleBrief: document.getElementById("script-style-brief"),
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
    assetTag: document.getElementById("asset-tag"),
    assetTicker: document.getElementById("asset-ticker"),
    assetName: document.getElementById("asset-name"),
    assetSector: document.getElementById("asset-sector"),
    assetExchange: document.getElementById("asset-exchange"),
    assetSession: document.getElementById("asset-session"),
    assetRange: document.getElementById("asset-range"),
    assetDescription: document.getElementById("asset-description"),
    benchmarkText: document.getElementById("benchmark-text"),
    strategyNote: document.getElementById("strategy-note"),
    settlementRule: document.getElementById("settlement-rule"),
    currentClue: document.getElementById("current-clue"),
    settlementValue: document.getElementById("settlement-value"),
    clueCount: document.getElementById("clue-count"),
    revealedClues: document.getElementById("revealed-clues"),
    rangeBrief: document.getElementById("range-brief"),
    taskPrompt: document.getElementById("task-prompt"),
  };

  let game = new InterviewGame(parseSeedFromUrl() || randomSeed());
  let renderedTurn = -1;

  function renderHistory(items) {
    elements.historyList.innerHTML = "";
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No turns yet. Start the round, quote a market, and the tape will explain what happened.";
      elements.historyList.appendChild(li);
      return;
    }
    items.forEach((item) => {
      const li = document.createElement("li");
      li.className = item.kind;
      li.textContent = item.text;
      elements.historyList.appendChild(li);
    });
  }

  function renderClues(items) {
    elements.revealedClues.innerHTML = "";
    items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      elements.revealedClues.appendChild(li);
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
    elements.assetTag.textContent = `${snapshot.asset.scenario} · ${snapshot.asset.sessionDate}`;
    elements.assetTicker.textContent = snapshot.asset.ticker;
    elements.assetName.textContent = snapshot.asset.name;
    elements.assetSector.textContent = snapshot.asset.sector;
    elements.assetExchange.textContent = snapshot.asset.exchange;
    elements.assetRange.textContent = `${format(snapshot.asset.valueRange.low)} to ${format(snapshot.asset.valueRange.high)}`;
    elements.assetSession.textContent = snapshot.asset.sessionDate;
    elements.assetDescription.textContent = snapshot.asset.description;
    elements.benchmarkText.textContent = snapshot.asset.benchmarkText;
    elements.strategyNote.textContent = snapshot.asset.strategyNote;
    elements.settlementRule.textContent = snapshot.asset.exchange;
    elements.currentClue.textContent = snapshot.currentClue;
    elements.settlementValue.textContent = snapshot.settlementValue === null ? "hidden" : format(snapshot.settlementValue);
    elements.clueCount.textContent = String(snapshot.revealedClues.length);
    elements.adjustedScore.textContent = format(snapshot.adjustedScore);
    elements.rawMtm.textContent = format(snapshot.rawMtm);
    elements.bestScore.textContent = format(snapshot.bestScore);
    elements.roundStatus.textContent = `${snapshot.turn} / ${snapshot.maxTurns}`;
    elements.shotClock.textContent = `${snapshot.shotClock}s`;
    elements.stateLabel.textContent = capWords(snapshot.mode);
    elements.inventory.textContent = String(snapshot.player.inventory);
    elements.cash.textContent = format(snapshot.player.cash);
    elements.refPrice.textContent = format(snapshot.referencePrice);
    elements.flowToneCard.textContent = capWords(snapshot.asset.flowTone);
    elements.lastMark.textContent = format(snapshot.lastMark);
    elements.volBand.textContent = capWords(volBand(snapshot.asset.realizedVol));
    elements.spreadBand.textContent = capWords(spreadBand(snapshot.asset.averageSpread));
    elements.rangeBrief.textContent = `${format(snapshot.asset.valueRange.low)} / ${format(snapshot.asset.valueRange.high)}`;
    elements.scriptStyleBrief.textContent = capWords(snapshot.profile);
    elements.suggestedBid.textContent = format(snapshot.suggestedBid);
    elements.suggestedAsk.textContent = format(snapshot.suggestedAsk);
    elements.lastQuoteBid.textContent = snapshot.lastQuote ? format(snapshot.lastQuote.bid) : "-";
    elements.lastQuoteAsk.textContent = snapshot.lastQuote ? format(snapshot.lastQuote.ask) : "-";
    elements.scriptAction.textContent = snapshot.lastResponse.action;
    elements.scriptReason.textContent = snapshot.lastResponse.reason;
    elements.botProfile.textContent = capWords(snapshot.profile);
    elements.markAfter.textContent = format(snapshot.lastResponse.markAfter);
    elements.missedTurns.textContent = String(snapshot.missedTurns);
    elements.inventoryPenalty.textContent = format(snapshot.inventoryPenalty);
    elements.startButton.textContent = snapshot.mode === "ready" ? "Start Interview" : "Restart Interview";
    elements.submitQuote.disabled = snapshot.mode !== "quote";
    elements.skipTurn.disabled = snapshot.mode !== "quote";
    elements.taskPrompt.textContent =
      snapshot.mode === "ready"
        ? "Review the contract, decide on a plausible fair range, then press Start Interview when you are ready to quote."
        : snapshot.mode === "finished"
          ? `The round is over. Settlement was ${format(snapshot.settlementValue)} ${snapshot.asset.exchange}. Restart to try a new contract.`
          : `You are on turn ${snapshot.turn} of ${snapshot.maxTurns}. Enter the price where you would buy, the price where you would sell, and the size you are willing to show.`;

    renderHistory(snapshot.history);
    renderClues(snapshot.revealedClues);
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
