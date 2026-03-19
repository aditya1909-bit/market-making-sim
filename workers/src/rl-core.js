import { GAME_ROLE, TAKER_ACTION } from "./protocol.js";

export const MAKER_ACTIONS = [
  { id: "tight_1", halfSpread: 0.035, skew: 0, size: 1 },
  { id: "normal_1", halfSpread: 0.055, skew: 0, size: 1 },
  { id: "wide_1", halfSpread: 0.08, skew: 0, size: 1 },
  { id: "skew_bid_1", halfSpread: 0.055, skew: -0.025, size: 1 },
  { id: "skew_ask_1", halfSpread: 0.055, skew: 0.025, size: 1 },
  { id: "tight_2", halfSpread: 0.04, skew: 0, size: 2 },
  { id: "wide_2", halfSpread: 0.09, skew: 0, size: 2 },
  { id: "inventory_buy", halfSpread: 0.06, skew: -0.04, size: 2 },
  { id: "inventory_sell", halfSpread: 0.06, skew: 0.04, size: 2 },
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

export function actionNamesForRole(role) {
  return role === GAME_ROLE.MAKER ? MAKER_ACTIONS.map((entry) => entry.id) : [...TAKER_ACTIONS];
}

export function makerStateKey(room, estimate) {
  const { width, midpoint } = rangeContext(room);
  const estimateBias = bucket((estimate - midpoint) / width, [-0.28, -0.12, -0.03, 0.03, 0.12, 0.28]);
  const inventory = inventoryBucket(room.game.maker.inventory);
  const turn = turnBucket(room.game.turn, room.game.maxTurns);
  const lastType = room.game.lastResolution?.type || "start";
  const lastAction =
    lastType === "turn_resolved" ? room.game.lastResolution.action : lastType === "game_started" ? "start" : "other";
  return `m|b${estimateBias}|i${inventory}|t${turn}|l${lastAction}`;
}

export function takerStateKey(room, estimate) {
  const { width } = rangeContext(room);
  const quote = room.game.currentQuote;
  if (!quote) {
    return "t|missing";
  }
  const mid = (quote.bid + quote.ask) / 2;
  const halfSpread = (quote.ask - quote.bid) / 2;
  const edge = bucket((estimate - mid) / width, [-0.25, -0.08, -0.02, 0.02, 0.08, 0.25]);
  const spread = bucket(halfSpread / width, [0.015, 0.03, 0.05, 0.08]);
  const inventory = inventoryBucket(room.game.taker.inventory);
  const turn = turnBucket(room.game.turn, room.game.maxTurns);
  return `t|e${edge}|s${spread}|i${inventory}|t${turn}`;
}

export function quoteFromMakerAction(room, estimate, actionIndex) {
  const { contract, width } = rangeContext(room);
  const action = MAKER_ACTIONS[actionIndex] || MAKER_ACTIONS[1];
  const step = Math.max(1, width * 0.12);
  const reservation = estimate + action.skew * step;
  const halfSpread = Math.max(1, action.halfSpread * width);
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
  if (inventory >= 3) {
    return 8;
  }
  if (inventory <= -3) {
    return 7;
  }
  const { midpoint, width } = rangeContext(room);
  const bias = (estimate - midpoint) / width;
  if (bias > 0.16) {
    return 4;
  }
  if (bias < -0.16) {
    return 3;
  }
  return room.game.turn >= room.game.maxTurns - 1 ? 2 : 1;
}

export function fallbackTakerAction(room, estimate) {
  const quote = room.game.currentQuote;
  if (!quote) {
    return TAKER_ACTION.PASS;
  }
  const { width } = rangeContext(room);
  const buyScore = (estimate - quote.ask) / width;
  const sellScore = (quote.bid - estimate) / width;
  const threshold = room.game.turn >= room.game.maxTurns - 1 ? 0.0 : 0.015;

  if (buyScore > Math.max(sellScore, threshold)) {
    return TAKER_ACTION.BUY;
  }
  if (sellScore > Math.max(buyScore, threshold)) {
    return TAKER_ACTION.SELL;
  }
  return TAKER_ACTION.PASS;
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

export function pickActionFromPolicy(policyTable, stateKey, fallbackValue, epsilon = 0) {
  if (epsilon > 0 && Math.random() < epsilon) {
    return null;
  }
  const values = policyTable?.[stateKey];
  if (!values || !values.length) {
    return fallbackValue;
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
