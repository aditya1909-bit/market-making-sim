import { GAME_ROLE, TAKER_ACTION } from "./protocol.js";

export const MAKER_ACTIONS = [
  { id: "micro_1", halfSpread: 0.008, skew: 0, size: 1 },
  { id: "tight_1", halfSpread: 0.014, skew: 0, size: 1 },
  { id: "normal_1", halfSpread: 0.022, skew: 0, size: 1 },
  { id: "wide_1", halfSpread: 0.035, skew: 0, size: 1 },
  { id: "skew_bid_1", halfSpread: 0.018, skew: -0.2, size: 1 },
  { id: "skew_ask_1", halfSpread: 0.018, skew: 0.2, size: 1 },
  { id: "tight_2", halfSpread: 0.016, skew: 0, size: 2 },
  { id: "normal_2", halfSpread: 0.024, skew: 0, size: 2 },
  { id: "inventory_buy", halfSpread: 0.022, skew: -0.35, size: 2 },
  { id: "inventory_sell", halfSpread: 0.022, skew: 0.35, size: 2 },
  { id: "panic_wide", halfSpread: 0.05, skew: 0, size: 1 },
];

export const TAKER_ACTIONS = [TAKER_ACTION.BUY, TAKER_ACTION.SELL, TAKER_ACTION.PASS];

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
  return `m|f${family}|b${estimateBias}|i${inventory}|t${turn}|l${lastAction}|m${markBias}|p${prevBias}|w${prevSpread}|z${prevSize}`;
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
  const edge = bucket((estimate - currentQuote.mid) / width, [-0.18, -0.08, -0.03, -0.01, 0.01, 0.03, 0.08, 0.18]);
  const spread = bucket(currentQuote.halfSpread / width, [0.006, 0.012, 0.02, 0.03, 0.045]);
  const inventory = inventoryBucket(room.game.taker.inventory);
  const turn = turnBucket(room.game.turn, room.game.maxTurns);
  const quoteBias = bucket(currentQuote.bias, [-0.2, -0.06, -0.015, 0.015, 0.06, 0.2]);
  const sizeBucket = bucket(currentQuote.size, [1, 2]);
  const drift = bucket((currentQuote.mid - previousQuote.mid) / width, [-0.14, -0.05, -0.015, 0.015, 0.05, 0.14]);
  const spreadShift = bucket((currentQuote.halfSpread - previousQuote.halfSpread) / width, [-0.02, -0.008, -0.002, 0.002, 0.008, 0.02]);
  const lastAction = room.game.lastResolution?.action || "start";
  return `t|f${family}|e${edge}|s${spread}|i${inventory}|t${turn}|q${quoteBias}|z${sizeBucket}|d${drift}|r${spreadShift}|l${lastAction}`;
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

export function updateEstimateFromQuote(room, role, estimate) {
  if (role !== GAME_ROLE.TAKER || !room.game.currentQuote) {
    return estimate;
  }
  const { contract, width, midpoint } = rangeContext(room);
  const current = quoteSnapshot(room.game.currentQuote, width, midpoint);
  const credibility = clamp(0.24 - current.halfSpread / width, 0.04, 0.2);
  const sizeBoost = Math.min(0.04, (current.size - 1) * 0.015);
  const makerInventoryPenalty = Math.min(0.1, Math.abs(room.game.maker.inventory) * 0.015);
  const weight = clamp(credibility + sizeBoost - makerInventoryPenalty, 0.03, 0.22);
  const shifted = estimate + (current.mid - estimate) * weight;
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
