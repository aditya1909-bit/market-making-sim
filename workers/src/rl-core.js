import { GAME_ROLE, TAKER_ACTION } from "./protocol.js";

export const MAKER_ACTIONS = [
  { id: "micro_1", halfSpread: 0.007, skew: 0, size: 1 },
  { id: "tight_1", halfSpread: 0.012, skew: 0, size: 1 },
  { id: "normal_1", halfSpread: 0.018, skew: 0, size: 1 },
  { id: "wide_1", halfSpread: 0.028, skew: 0, size: 1 },
  { id: "skew_bid_1", halfSpread: 0.015, skew: -0.2, size: 1 },
  { id: "skew_ask_1", halfSpread: 0.015, skew: 0.2, size: 1 },
  { id: "tight_2", halfSpread: 0.014, skew: 0, size: 2 },
  { id: "normal_2", halfSpread: 0.02, skew: 0, size: 2 },
  { id: "inventory_buy", halfSpread: 0.02, skew: -0.35, size: 2 },
  { id: "inventory_sell", halfSpread: 0.02, skew: 0.35, size: 2 },
  { id: "panic_wide", halfSpread: 0.04, skew: 0, size: 1 },
];

export const TAKER_ACTIONS = [TAKER_ACTION.BUY, TAKER_ACTION.SELL, TAKER_ACTION.PASS];
export const TAKER_DIRECTIONAL_ACTIONS = [TAKER_ACTION.BUY, TAKER_ACTION.SELL];
export const TAKER_MODES = ["take", "pass", "probe"];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function bucket(value, edges) {
  let index = 0;
  while (index < edges.length && value > edges[index]) {
    index += 1;
  }
  return index;
}

function inventoryBucket(value) {
  return bucket(value, [-5, -2, -1, 0, 1, 2, 5]);
}

function turnBucket(turn, maxTurns) {
  if (!maxTurns || turn <= 1) {
    return 0;
  }
  const ratio = turn / maxTurns;
  return bucket(ratio, [0.25, 0.5, 0.75]);
}

function rangeContext(room) {
  const contract = room.game.contract;
  const width = Math.max(1, contract.rangeHigh - contract.rangeLow);
  const midpoint = (contract.rangeLow + contract.rangeHigh) / 2;
  return { contract, width, midpoint };
}

function quoteSnapshot(quote, width, midpoint) {
  if (!quote) {
    return {
      mid: midpoint,
      halfSpread: width * 0.02,
      size: 1,
      bias: 0,
    };
  }

  const mid = (quote.bid + quote.ask) / 2;
  const halfSpread = Math.max(0.005, (quote.ask - quote.bid) / 2);
  const size = Math.max(1, Number(quote.size) || 1);
  const bias = (mid - midpoint) / width;
  return { mid, halfSpread, size, bias };
}

function quoteHistory(room, width, midpoint) {
  const history = Array.isArray(room?.game?.quoteHistory) ? room.game.quoteHistory : [];
  if (history.length) {
    return history.map((quote) => quoteSnapshot(quote, width, midpoint));
  }
  if (room?.game?.previousQuote) {
    return [quoteSnapshot(room.game.previousQuote, width, midpoint)];
  }
  return [];
}

function actionHistory(room) {
  return Array.isArray(room?.game?.actionHistory) ? room.game.actionHistory : [];
}

function actionFeatures(room) {
  const history = actionHistory(room);
  if (!history.length) {
    return {
      passStreak: 0,
      recentPassRate: 0,
      signedFlow: 0,
      lastNonPass: "start",
    };
  }

  let passStreak = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index] === TAKER_ACTION.PASS) {
      passStreak += 1;
      continue;
    }
    break;
  }

  let recentPasses = 0;
  let signedFlow = 0;
  let lastNonPass = "start";
  history.forEach((action) => {
    if (action === TAKER_ACTION.PASS) {
      recentPasses += 1;
    } else if (action === TAKER_ACTION.BUY) {
      signedFlow += 1;
      lastNonPass = action;
    } else if (action === TAKER_ACTION.SELL) {
      signedFlow -= 1;
      lastNonPass = action;
    }
  });

  return {
    passStreak,
    recentPassRate: recentPasses / history.length,
    signedFlow,
    lastNonPass,
  };
}

function sequenceFeatures(room, width, midpoint) {
  const history = quoteHistory(room, width, midpoint);
  if (!history.length) {
    return {
      historyLength: 0,
      averageMid: midpoint,
      averageSpread: width * 0.02,
      recentDrift: 0,
      multiDrift: 0,
      biasPersistence: 0,
      widenTrend: 0,
    };
  }

  const mids = history.map((entry) => entry.mid);
  const spreads = history.map((entry) => entry.halfSpread * 2);
  const last = history[history.length - 1];
  const prev = history.length > 1 ? history[history.length - 2] : history[0];
  const averageMid = mids.reduce((sum, value) => sum + value, 0) / mids.length;
  const averageSpread = spreads.reduce((sum, value) => sum + value, 0) / spreads.length;
  const recentDrift = (last.mid - prev.mid) / width;
  const multiDrift = (last.mid - history[0].mid) / width;
  const biasPersistence = history.reduce((score, entry) => score + Math.sign(entry.bias || 0), 0);
  const widenTrend = spreads.length > 1 ? (spreads[spreads.length - 1] - spreads[0]) / width : 0;

  return {
    historyLength: history.length,
    averageMid,
    averageSpread,
    recentDrift,
    multiDrift,
    biasPersistence,
    widenTrend,
  };
}

function scenarioFamilyBucket(contract) {
  const text = String(contract?.templateId || contract?.prompt || "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 17;
  }
  return hash % 6;
}

export function actionNamesForRole(role) {
  return role === GAME_ROLE.MAKER ? MAKER_ACTIONS.map((entry) => entry.id) : [...TAKER_ACTIONS];
}

export function makerStateKey(room, estimate) {
  const { contract, width, midpoint } = rangeContext(room);
  const actions = actionFeatures(room);
  const estimateBias = bucket((estimate - midpoint) / width, [-0.22, -0.08, -0.02, 0.02, 0.08, 0.22]);
  const inventory = inventoryBucket(room.game.maker.inventory);
  const turn = turnBucket(room.game.turn, room.game.maxTurns);
  const lastType = room.game.lastResolution?.type || "start";
  const lastAction =
    lastType === "turn_resolved" ? room.game.lastResolution.action : lastType === "game_started" ? "start" : "other";
  const lastMark = room.game.lastResolution?.mark;
  const markBias = lastMark === undefined || lastMark === null ? 0 : bucket((lastMark - midpoint) / width, [-0.08, -0.02, 0.02, 0.08]);
  const family = scenarioFamilyBucket(contract);
  const previousQuote = quoteSnapshot(room.game.previousQuote, width, midpoint);
  const prevBias = bucket(previousQuote.bias, [-0.1, -0.025, 0.025, 0.1]);
  const prevSpread = bucket(previousQuote.halfSpread / width, [0.01, 0.02, 0.035]);
  const prevSize = previousQuote.size > 1 ? 1 : 0;
  const passStreak = bucket(actions.passStreak, [0, 1, 2, 3]);
  const flow = bucket(actions.signedFlow, [-2, -1, 0, 1, 2]);
  return `m|f${family}|b${estimateBias}|i${inventory}|t${turn}|l${lastAction}|m${markBias}|p${prevBias}|w${prevSpread}|z${prevSize}|x${passStreak}|f${flow}`;
}

export function takerStateKey(room, estimate) {
  const { width, midpoint } = rangeContext(room);
  const family = scenarioFamilyBucket(room.game.contract);
  const quote = room.game.currentQuote;
  if (!quote) {
    return "t|missing";
  }
  const currentQuote = quoteSnapshot(quote, width, midpoint);
  const previousQuote = quoteSnapshot(room.game.previousQuote, width, midpoint);
  const sequence = sequenceFeatures(room, width, midpoint);
  const edge = bucket((estimate - currentQuote.mid) / width, [-0.18, -0.08, -0.03, -0.01, 0.01, 0.03, 0.08, 0.18]);
  const spread = bucket(currentQuote.halfSpread / width, [0.006, 0.012, 0.02, 0.03, 0.045]);
  const inventory = inventoryBucket(room.game.taker.inventory);
  const turn = turnBucket(room.game.turn, room.game.maxTurns);
  const quoteBias = bucket(currentQuote.bias, [-0.2, -0.06, -0.015, 0.015, 0.06, 0.2]);
  const sizeBucket = bucket(currentQuote.size, [1, 2]);
  const drift = bucket((currentQuote.mid - previousQuote.mid) / width, [-0.14, -0.05, -0.015, 0.015, 0.05, 0.14]);
  const spreadShift = bucket((currentQuote.halfSpread - previousQuote.halfSpread) / width, [-0.02, -0.008, -0.002, 0.002, 0.008, 0.02]);
  const memoryDrift = bucket(sequence.multiDrift, [-0.16, -0.06, -0.02, 0.02, 0.06, 0.16]);
  const memoryBias = bucket(sequence.biasPersistence, [-2, -1, 0, 1, 2]);
  const widenTrend = bucket(sequence.widenTrend, [-0.02, -0.008, -0.002, 0.002, 0.008, 0.02]);
  const lastAction = room.game.lastResolution?.action || "start";
  return `t|f${family}|e${edge}|s${spread}|i${inventory}|t${turn}|q${quoteBias}|z${sizeBucket}|d${drift}|r${spreadShift}|h${memoryDrift}|b${memoryBias}|w${widenTrend}|l${lastAction}`;
}

export function takerModeStateKey(room, estimate) {
  const { width, midpoint } = rangeContext(room);
  const quote = room.game.currentQuote;
  if (!quote) {
    return "tm|missing";
  }
  const current = quoteSnapshot(quote, width, midpoint);
  const sequence = sequenceFeatures(room, width, midpoint);
  const actions = actionFeatures(room);
  const inventory = inventoryBucket(room.game.taker.inventory);
  const turn = turnBucket(room.game.turn, room.game.maxTurns);
  const edge = bucket((estimate - current.mid) / width, [-0.12, -0.04, -0.012, 0.012, 0.04, 0.12]);
  const spread = bucket(current.halfSpread / width, [0.01, 0.02, 0.035]);
  const drift = bucket(sequence.recentDrift, [-0.08, -0.025, -0.008, 0.008, 0.025, 0.08]);
  const memoryDrift = bucket(sequence.multiDrift, [-0.1, -0.03, -0.01, 0.01, 0.03, 0.1]);
  const widen = bucket(sequence.widenTrend, [-0.015, -0.004, 0.004, 0.015]);
  const persistence = bucket(sequence.biasPersistence, [-2, -1, 0, 1, 2]);
  const passStreak = bucket(actions.passStreak, [0, 1, 2, 3]);
  const flow = bucket(actions.signedFlow, [-2, -1, 0, 1, 2]);
  const lastTrade = actions.lastNonPass;
  return `tm|e${edge}|s${spread}|i${inventory}|t${turn}|d${drift}|m${memoryDrift}|w${widen}|p${persistence}|x${passStreak}|f${flow}|l${lastTrade}`;
}

export function takerActionStateKey(room, estimate, mode) {
  const { width, midpoint } = rangeContext(room);
  const quote = room.game.currentQuote;
  if (!quote) {
    return `ta|mode:${mode}|missing`;
  }
  const current = quoteSnapshot(quote, width, midpoint);
  const sequence = sequenceFeatures(room, width, midpoint);
  const actions = actionFeatures(room);
  const edge = bucket((estimate - current.mid) / width, [-0.08, -0.02, 0.02, 0.08]);
  const spread = bucket(current.halfSpread / width, [0.012, 0.028]);
  const inventory = inventoryBucket(room.game.taker.inventory);
  const turn = turnBucket(room.game.turn, room.game.maxTurns);
  const drift = bucket(sequence.recentDrift, [-0.03, -0.008, 0.008, 0.03]);
  const memory = bucket(sequence.multiDrift, [-0.04, -0.012, 0.012, 0.04]);
  const quoteBias = bucket(current.bias, [-0.08, -0.02, 0.02, 0.08]);
  const passStreak = bucket(actions.passStreak, [0, 1, 2, 3]);
  const flow = bucket(actions.signedFlow, [-2, -1, 0, 1, 2]);
  return `ta|mode:${mode}|e${edge}|s${spread}|i${inventory}|t${turn}|d${drift}|m${memory}|q${quoteBias}|x${passStreak}|f${flow}`;
}

export function fallbackTakerMode(room, estimate) {
  const quote = room.game.currentQuote;
  if (!quote) {
    return "pass";
  }
  const { width, midpoint } = rangeContext(room);
  const current = quoteSnapshot(quote, width, midpoint);
  const sequence = sequenceFeatures(room, width, midpoint);
  const actions = actionFeatures(room);
  const buyEdge = (estimate - quote.ask) / width;
  const sellEdge = (quote.bid - estimate) / width;
  const bestEdge = Math.max(buyEdge, sellEdge);
  const spread = (quote.ask - quote.bid) / width;

  if (bestEdge > 0.02 || room.game.turn >= room.game.maxTurns - 1) {
    return "take";
  }
  if (spread > 0.038 && bestEdge < 0.008) {
    return "pass";
  }
  if (actions.passStreak >= 2 && bestEdge > 0.004 && spread < 0.03) {
    return "probe";
  }
  if (Math.abs(sequence.recentDrift) > 0.02 && Math.abs(sequence.widenTrend) < 0.01) {
    return "probe";
  }
  if (Math.abs(current.mid - midpoint) / width > 0.08 && bestEdge < 0.018) {
    return "probe";
  }
  return bestEdge > 0.01 ? "take" : "pass";
}

export function quoteFromMakerAction(room, estimate, actionIndex) {
  const { contract, width } = rangeContext(room);
  const action = MAKER_ACTIONS[actionIndex] || MAKER_ACTIONS[1];
  const step = Math.max(1, width * 0.06);
  const reservation = estimate + action.skew * step;
  const halfSpread = Math.max(0.5, action.halfSpread * width);
  const bid = clamp(round2(reservation - halfSpread), contract.rangeLow, contract.rangeHigh - 1);
  const ask = clamp(round2(reservation + halfSpread), bid + 0.01, contract.rangeHigh);
  return {
    bid,
    ask,
    size: action.size,
  };
}

export function fallbackMakerActionIndex(room, estimate) {
  const inventory = room.game.maker.inventory;
  const lastAction = room.game.lastResolution?.action || null;
  const actions = actionFeatures(room);
  if (inventory >= 3) {
    return 9;
  }
  if (inventory <= -3) {
    return 8;
  }
  const { midpoint, width } = rangeContext(room);
  const bias = (estimate - midpoint) / width;
  if (bias > 0.16) {
    return 5;
  }
  if (bias < -0.16) {
    return 4;
  }
  if (actions.passStreak >= 2) {
    return room.game.turn <= 2 ? 0 : 1;
  }
  if (actions.signedFlow >= 2) {
    return 5;
  }
  if (actions.signedFlow <= -2) {
    return 4;
  }
  if (lastAction === TAKER_ACTION.BUY) {
    return 3;
  }
  if (lastAction === TAKER_ACTION.SELL) {
    return 3;
  }
  if (room.game.turn === 1) {
    return 1;
  }
  return room.game.turn >= room.game.maxTurns - 1 ? 3 : 2;
}

export function fallbackTakerAction(room, estimate) {
  const quote = room.game.currentQuote;
  if (!quote) {
    return TAKER_ACTION.PASS;
  }
  const { width } = rangeContext(room);
  const buyScore = (estimate - quote.ask) / width;
  const sellScore = (quote.bid - estimate) / width;
  const previous = room.game.previousQuote;
  const previousMid = previous ? (previous.bid + previous.ask) / 2 : (quote.bid + quote.ask) / 2;
  const drift = ((quote.bid + quote.ask) / 2 - previousMid) / width;
  const momentumBias = drift > 0.015 ? 0.002 : drift < -0.015 ? -0.002 : 0;
  const threshold = room.game.turn >= room.game.maxTurns - 1 ? 0.0 : 0.003;

  if (buyScore - momentumBias > Math.max(sellScore + momentumBias, threshold)) {
    return TAKER_ACTION.BUY;
  }
  if (sellScore + momentumBias > Math.max(buyScore - momentumBias, threshold)) {
    return TAKER_ACTION.SELL;
  }
  return TAKER_ACTION.PASS;
}

export function blendTakerAction(room, estimate, preferredAction, fallbackValue) {
  const quote = room.game.currentQuote;
  if (!quote) {
    return TAKER_ACTION.PASS;
  }
  const { width } = rangeContext(room);
  const buyEdge = (estimate - quote.ask) / width;
  const sellEdge = (quote.bid - estimate) / width;
  const bestAction = buyEdge >= sellEdge ? TAKER_ACTION.BUY : TAKER_ACTION.SELL;
  const bestEdge = Math.max(buyEdge, sellEdge);
  const strongEdge = bestEdge > 0.012;
  const clearEdge = bestEdge > 0.028;

  if (preferredAction === TAKER_ACTION.PASS && fallbackValue !== TAKER_ACTION.PASS && strongEdge) {
    return fallbackValue;
  }
  if (
    preferredAction !== TAKER_ACTION.PASS &&
    fallbackValue !== TAKER_ACTION.PASS &&
    preferredAction !== fallbackValue &&
    clearEdge
  ) {
    return bestAction;
  }
  return preferredAction;
}

export function probeTakerAction(room, estimate, fallbackValue) {
  const quote = room.game.currentQuote;
  if (!quote) {
    return TAKER_ACTION.PASS;
  }
  const { width, midpoint } = rangeContext(room);
  const current = quoteSnapshot(quote, width, midpoint);
  const sequence = sequenceFeatures(room, width, midpoint);
  const buyEdge = (estimate - quote.ask) / width;
  const sellEdge = (quote.bid - estimate) / width;
  const directionalBias = current.mid - midpoint;

  if (sequence.recentDrift > 0.015 || directionalBias > width * 0.06) {
    return buyEdge > -0.012 ? TAKER_ACTION.BUY : fallbackValue;
  }
  if (sequence.recentDrift < -0.015 || directionalBias < -width * 0.06) {
    return sellEdge > -0.012 ? TAKER_ACTION.SELL : fallbackValue;
  }
  if (buyEdge > sellEdge && buyEdge > -0.006) {
    return TAKER_ACTION.BUY;
  }
  if (sellEdge >= buyEdge && sellEdge > -0.006) {
    return TAKER_ACTION.SELL;
  }
  return TAKER_ACTION.PASS;
}

export function takerActionForMode(room, estimate, mode, preferredAction, fallbackValue) {
  if (mode === "pass") {
    return TAKER_ACTION.PASS;
  }
  if (mode === "probe") {
    const directionalFallback = fallbackValue === TAKER_ACTION.PASS ? probeTakerAction(room, estimate, fallbackValue) : fallbackValue;
    const preferred = preferredAction === TAKER_ACTION.PASS ? directionalFallback : preferredAction;
    return probeTakerAction(room, estimate, preferred);
  }
  const directionalFallback = fallbackValue === TAKER_ACTION.PASS ? probeTakerAction(room, estimate, fallbackValue) : fallbackValue;
  const preferred = preferredAction === TAKER_ACTION.PASS ? directionalFallback : preferredAction;
  return blendTakerAction(room, estimate, preferred, directionalFallback);
}

export function updateEstimateFromQuote(room, role, estimate) {
  if (role !== GAME_ROLE.TAKER || !room.game.currentQuote) {
    return estimate;
  }
  const { contract, width, midpoint } = rangeContext(room);
  const current = quoteSnapshot(room.game.currentQuote, width, midpoint);
  const sequence = sequenceFeatures(room, width, midpoint);
  const actions = actionFeatures(room);
  const credibility = clamp(0.16 - current.halfSpread / width, 0.025, 0.11);
  const sizeBoost = Math.min(0.02, (current.size - 1) * 0.008);
  const makerInventoryPenalty = Math.min(0.05, Math.abs(room.game.maker.inventory) * 0.01);
  const coherenceBoost =
    Math.sign(current.bias || 0) !== 0 && Math.sign(current.bias || 0) === Math.sign(sequence.recentDrift || 0) ? 0.012 : 0;
  const tighteningBoost = sequence.widenTrend < -0.004 && actions.passStreak === 0 ? 0.01 : 0;
  const weight = clamp(credibility + sizeBoost + coherenceBoost + tighteningBoost - makerInventoryPenalty, 0.02, 0.16);
  const directionalNudge = clamp(
    sequence.multiDrift * width * 0.12 + sequence.recentDrift * width * 0.08,
    -width * 0.035,
    width * 0.035
  );
  const shifted = estimate + (current.mid - estimate) * weight + directionalNudge;
  return clamp(shifted, contract.rangeLow, contract.rangeHigh);
}

export function updateEstimateFromResolution(room, role, estimate) {
  const resolution = room.game.lastResolution;
  if (role !== GAME_ROLE.MAKER || resolution?.type !== "turn_resolved") {
    return estimate;
  }
  const { contract, width } = rangeContext(room);
  const previous = room.game.previousQuote;
  const halfSpread = previous ? Math.max(0.005, (previous.ask - previous.bid) / 2) : width * 0.02;
  const signal = clamp(0.018 + halfSpread / width * 0.6, 0.025, 0.085) * width;

  let shifted = estimate;
  if (resolution.action === TAKER_ACTION.BUY) {
    shifted += signal;
  } else if (resolution.action === TAKER_ACTION.SELL) {
    shifted -= signal;
  } else if (resolution.mark !== undefined && resolution.mark !== null) {
    shifted += (resolution.mark - estimate) * 0.04;
  }

  return clamp(shifted, contract.rangeLow, contract.rangeHigh);
}

export function roleStateKey(room, role, estimate) {
  return role === GAME_ROLE.MAKER ? makerStateKey(room, estimate) : takerStateKey(room, estimate);
}

export function fallbackAction(room, role, estimate) {
  if (role === GAME_ROLE.MAKER) {
    return fallbackMakerActionIndex(room, estimate);
  }
  return fallbackTakerAction(room, estimate);
}

export function pickActionFromPolicy(policyTable, stateKey, fallbackValue, epsilon = 0, countTable = null, minSamples = 0) {
  if (epsilon > 0 && Math.random() < epsilon) {
    return null;
  }
  const values = policyTable?.[stateKey];
  if (values === undefined || values === null || (Array.isArray(values) && !values.length)) {
    return fallbackValue;
  }
  const counts = countTable?.[stateKey];
  if (counts && minSamples > 0) {
    const support = Array.isArray(counts) ? counts.reduce((sum, value) => sum + value, 0) : Number(counts);
    if (support < minSamples) {
      return fallbackValue;
    }
  }
  if (typeof values === "number" || typeof values === "string") {
    return values;
  }
  let bestIndex = 0;
  let bestValue = values[0];
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > bestValue) {
      bestValue = values[index];
      bestIndex = index;
    }
  }
  return bestIndex;
}
