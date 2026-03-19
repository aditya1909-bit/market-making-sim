import { contractFromScenarioIndex, SCENARIO_COUNT } from "../workers/src/contracts.js";
import { RL_POLICY } from "../workers/src/rl-policy-data.js";
import {
  MAKER_ACTIONS,
  TAKER_ACTIONS,
  TAKER_DIRECTIONAL_ACTIONS,
  TAKER_MODES,
  fallbackMakerActionIndex,
  fallbackTakerMode,
  fallbackTakerAction,
  makerStateKey,
  pickActionFromPolicy,
  quoteFromMakerAction,
  takerActionForMode,
  takerActionStateKey,
  takerModeStateKey,
  updateEstimateFromQuote,
  updateEstimateFromResolution,
} from "../workers/src/rl-core.js";
import { GAME_ROLE, TAKER_ACTION } from "../workers/src/protocol.js";

const MIN_POLICY_SUPPORT = {
  maker: 20,
  takerMode: 28,
  takerAction: 45,
};

function hybridTakerExecution(room, estimate, modeledAction, fallbackAction) {
  const quote = room.game.currentQuote;
  if (!quote) {
    return modeledAction;
  }

  const width = Math.max(1, room.game.contract.rangeHigh - room.game.contract.rangeLow);
  const buyEdge = (estimate - quote.ask) / width;
  const sellEdge = (quote.bid - estimate) / width;
  const bestEdge = Math.max(buyEdge, sellEdge);
  const spread = (quote.ask - quote.bid) / width;

  if (fallbackAction !== "pass" && (bestEdge > 0.012 || spread < 0.012)) {
    return fallbackAction;
  }
  if (modeledAction === "pass" && fallbackAction !== "pass" && bestEdge > 0.004) {
    return fallbackAction;
  }
  return modeledAction;
}

function parseArgs(argv) {
  const out = {
    scenarios: 2000,
    gamesPerScenario: 2,
    start: 0,
    split: "all",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--scenarios") {
      out.scenarios = Math.max(1, Number(argv[index + 1] || out.scenarios));
      index += 1;
    } else if (token === "--games-per-scenario") {
      out.gamesPerScenario = Math.max(1, Number(argv[index + 1] || out.gamesPerScenario));
      index += 1;
    } else if (token === "--start") {
      out.start = Math.max(0, Number(argv[index + 1] || out.start));
      index += 1;
    } else if (token === "--split") {
      out.split = String(argv[index + 1] || out.split);
      index += 1;
    }
  }

  return out;
}

function includeScenario(index, split) {
  if (split === "holdout") {
    return index % 5 === 0;
  }
  if (split === "train") {
    return index % 5 !== 0;
  }
  return true;
}

function deterministicNoise(scenarioIndex, variant, salt) {
  let value = (scenarioIndex + 1) * 1103515245 + (variant + 1) * 12345 + salt * 2654435761;
  value = (value >>> 0) % 1000003;
  return value / 1000003;
}

function buildContract(scenarioIndex, variant) {
  const contract = contractFromScenarioIndex(scenarioIndex);
  const width = contract.rangeHigh - contract.rangeLow;
  const centered = deterministicNoise(scenarioIndex, variant, 17) * 2 - 1;
  contract.hiddenValue = Math.max(
    contract.rangeLow,
    Math.min(contract.rangeHigh, Math.round((contract.rangeLow + contract.rangeHigh) / 2 + centered * width * 0.32))
  );
  return contract;
}

function buildRoom(contract) {
  return {
    makerId: "maker",
    takerId: "taker",
    game: {
      contract,
      turn: 1,
      maxTurns: contract.maxTurns,
      activeActor: "maker",
      currentQuote: null,
      previousQuote: null,
      quoteHistory: [],
      actionHistory: [],
      lastResolution: { type: "game_started", text: "Game started." },
      maker: { cash: 0, inventory: 0 },
      taker: { cash: 0, inventory: 0 },
    },
  };
}

function estimateFor(role, contract, scenarioIndex, variant) {
  const width = Math.max(1, contract.rangeHigh - contract.rangeLow);
  const salt = role === "maker" ? 101 : 211;
  const centered = deterministicNoise(scenarioIndex, variant, salt) * 2 - 1;
  return contract.hiddenValue + centered * width * 0.14;
}

function chooseMaker(strategy, room, estimate) {
  if (strategy === "fallback") {
    return fallbackMakerActionIndex(room, estimate);
  }
  const stateKey = makerStateKey(room, estimate);
  const fallback = fallbackMakerActionIndex(room, estimate);
  const picked = pickActionFromPolicy(
    RL_POLICY.maker,
    stateKey,
    fallback,
    0,
    RL_POLICY.counts?.maker,
    MIN_POLICY_SUPPORT.maker
  );
  return typeof picked === "number" ? picked : fallback;
}

function chooseTaker(strategy, room, estimate) {
  if (strategy === "fallback") {
    return fallbackTakerAction(room, estimate);
  }
  const modeStateKey = takerModeStateKey(room, estimate);
  const fallbackMode = fallbackTakerMode(room, estimate);
  const pickedMode = pickActionFromPolicy(
    RL_POLICY.takerModes,
    modeStateKey,
    fallbackMode,
    0,
    RL_POLICY.counts?.takerModes,
    MIN_POLICY_SUPPORT.takerMode
  );
  const mode = typeof pickedMode === "number" ? TAKER_MODES[pickedMode] || fallbackMode : pickedMode;
  const fallback = fallbackTakerAction(room, estimate);
  const actionStateKey = takerActionStateKey(room, estimate, mode);
  const pickedAction = pickActionFromPolicy(
    RL_POLICY.taker,
    actionStateKey,
    fallback,
    0,
    RL_POLICY.counts?.taker,
    MIN_POLICY_SUPPORT.takerAction
  );
  const preferred = typeof pickedAction === "number" ? TAKER_DIRECTIONAL_ACTIONS[pickedAction] || fallback : pickedAction;
  const modeledAction = takerActionForMode(room, estimate, mode, preferred, fallback);
  return hybridTakerExecution(room, estimate, modeledAction, fallback);
}

function applyTrade(room, action) {
  const quote = room.game.currentQuote;
  const qty = quote.size;

  if (action === TAKER_ACTION.BUY) {
    room.game.maker.cash += quote.ask * qty;
    room.game.maker.inventory -= qty;
    room.game.taker.cash -= quote.ask * qty;
    room.game.taker.inventory += qty;
    room.game.lastResolution = { type: "turn_resolved", action: "buy", mark: quote.ask };
  } else if (action === TAKER_ACTION.SELL) {
    room.game.maker.cash -= quote.bid * qty;
    room.game.maker.inventory += qty;
    room.game.taker.cash += quote.bid * qty;
    room.game.taker.inventory -= qty;
    room.game.lastResolution = { type: "turn_resolved", action: "sell", mark: quote.bid };
  } else {
    room.game.lastResolution = {
      type: "turn_resolved",
      action: "pass",
      mark: (quote.bid + quote.ask) / 2,
    };
  }

  room.game.previousQuote = quote;
  room.game.actionHistory = [...(room.game.actionHistory || []), action].slice(-6);
}

function settle(room) {
  const settlePrice = room.game.contract.hiddenValue;
  return {
    makerPnl: room.game.maker.cash + room.game.maker.inventory * settlePrice,
    takerPnl: room.game.taker.cash + room.game.taker.inventory * settlePrice,
  };
}

function simulateGame(makerStrategy, takerStrategy, scenarioIndex, variant) {
  const contract = buildContract(scenarioIndex, variant);
  const room = buildRoom(contract);
  let makerEstimate = estimateFor("maker", contract, scenarioIndex, variant);
  let takerEstimate = estimateFor("taker", contract, scenarioIndex, variant);

  let spreads = 0;
  let quotes = 0;
  let buys = 0;
  let sells = 0;
  let passes = 0;

  for (let turn = 1; turn <= contract.maxTurns; turn += 1) {
    room.game.turn = turn;
    const makerAction = chooseMaker(makerStrategy, room, makerEstimate);
    const quote = quoteFromMakerAction(room, makerEstimate, makerAction);
    room.game.currentQuote = quote;
    room.game.quoteHistory = [...(room.game.quoteHistory || []), quote].slice(-4);
    room.game.lastResolution = { type: "quote_submitted", text: "maker quote" };
    spreads += quote.ask - quote.bid;
    quotes += 1;

    takerEstimate = updateEstimateFromQuote(room, GAME_ROLE.TAKER, takerEstimate);
    const takerAction = chooseTaker(takerStrategy, room, takerEstimate);
    if (takerAction === TAKER_ACTION.BUY) {
      buys += 1;
    } else if (takerAction === TAKER_ACTION.SELL) {
      sells += 1;
    } else {
      passes += 1;
    }
    applyTrade(room, takerAction);
    makerEstimate = updateEstimateFromResolution(room, GAME_ROLE.MAKER, makerEstimate);
    room.game.currentQuote = null;
  }

  const { makerPnl, takerPnl } = settle(room);
  return {
    makerPnl,
    takerPnl,
    avgSpread: quotes ? spreads / quotes : 0,
    buys,
    sells,
    passes,
  };
}

function makeAccumulator() {
  return {
    games: 0,
    makerPnl: 0,
    takerPnl: 0,
    makerWins: 0,
    takerWins: 0,
    draws: 0,
    avgSpread: 0,
    buys: 0,
    sells: 0,
    passes: 0,
  };
}

function addResult(acc, result) {
  acc.games += 1;
  acc.makerPnl += result.makerPnl;
  acc.takerPnl += result.takerPnl;
  acc.avgSpread += result.avgSpread;
  acc.buys += result.buys;
  acc.sells += result.sells;
  acc.passes += result.passes;

  if (result.makerPnl > result.takerPnl) {
    acc.makerWins += 1;
  } else if (result.takerPnl > result.makerPnl) {
    acc.takerWins += 1;
  } else {
    acc.draws += 1;
  }
}

function summarize(acc) {
  const games = Math.max(1, acc.games);
  return {
    games: acc.games,
    makerPnlPerGame: acc.makerPnl / games,
    takerPnlPerGame: acc.takerPnl / games,
    makerWinRate: acc.makerWins / games,
    takerWinRate: acc.takerWins / games,
    drawRate: acc.draws / games,
    avgSpread: acc.avgSpread / games,
    buysPerGame: acc.buys / games,
    sellsPerGame: acc.sells / games,
    passesPerGame: acc.passes / games,
  };
}

function evaluateMatchup(makerStrategy, takerStrategy, config) {
  const acc = makeAccumulator();
  let accepted = 0;
  let cursor = 0;
  while (accepted < config.scenarios && cursor < SCENARIO_COUNT * 3) {
    const scenarioIndex = (config.start + cursor) % SCENARIO_COUNT;
    cursor += 1;
    if (!includeScenario(scenarioIndex, config.split)) {
      continue;
    }
    accepted += 1;
    for (let variant = 0; variant < config.gamesPerScenario; variant += 1) {
      addResult(acc, simulateGame(makerStrategy, takerStrategy, scenarioIndex, variant));
    }
  }
  return summarize(acc);
}

function printSummary(label, summary) {
  console.log(`\n${label}`);
  console.log(`  games: ${summary.games}`);
  console.log(`  maker pnl/game: ${summary.makerPnlPerGame.toFixed(3)}`);
  console.log(`  taker pnl/game: ${summary.takerPnlPerGame.toFixed(3)}`);
  console.log(`  maker win rate: ${(summary.makerWinRate * 100).toFixed(1)}%`);
  console.log(`  taker win rate: ${(summary.takerWinRate * 100).toFixed(1)}%`);
  console.log(`  draw rate: ${(summary.drawRate * 100).toFixed(1)}%`);
  console.log(`  avg spread: ${summary.avgSpread.toFixed(3)}`);
  console.log(`  buys/game: ${summary.buysPerGame.toFixed(2)}`);
  console.log(`  sells/game: ${summary.sellsPerGame.toFixed(2)}`);
  console.log(`  passes/game: ${summary.passesPerGame.toFixed(2)}`);
}

function main() {
  const config = parseArgs(process.argv.slice(2));
  console.log(
    `Evaluating ${config.split} split over ${config.scenarios} scenarios x ${config.gamesPerScenario} variants from pool ${SCENARIO_COUNT}`
  );

  const fallbackVsFallback = evaluateMatchup("fallback", "fallback", config);
  const rlMakerVsFallback = evaluateMatchup("rl", "fallback", config);
  const fallbackVsRlTaker = evaluateMatchup("fallback", "rl", config);
  const rlVsRl = evaluateMatchup("rl", "rl", config);

  printSummary("Fallback maker vs fallback taker", fallbackVsFallback);
  printSummary("RL maker vs fallback taker", rlMakerVsFallback);
  printSummary("Fallback maker vs RL taker", fallbackVsRlTaker);
  printSummary("RL maker vs RL taker", rlVsRl);

  console.log("\nEdge versus fallback baseline");
  console.log(`  maker uplift: ${(rlMakerVsFallback.makerPnlPerGame - fallbackVsFallback.makerPnlPerGame).toFixed(3)}`);
  console.log(`  taker uplift: ${(fallbackVsRlTaker.takerPnlPerGame - fallbackVsFallback.takerPnlPerGame).toFixed(3)}`);
}

main();
