import { GAME_ROLE } from "./protocol.js";
import {
  MAKER_ACTIONS,
  TAKER_ACTIONS,
  TAKER_DIRECTIONAL_ACTIONS,
  TAKER_MODES,
  fallbackAction,
  fallbackTakerAction,
  fallbackTakerMode,
  pickActionFromPolicy,
  quoteFromMakerAction,
  roleStateKey,
  takerActionForMode,
  takerActionStateKey,
  takerModeStateKey,
  updateEstimateFromQuote,
  updateEstimateFromResolution,
} from "./rl-core.js";
import { getRuntimeRlPolicy } from "./rl-policy-loader.js";

function botRole(room, botPlayerId) {
  return room.makerId === botPlayerId ? GAME_ROLE.MAKER : GAME_ROLE.TAKER;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function botProfile(room) {
  return room.bot?.profile || "balanced";
}

function actionHistory(room) {
  return Array.isArray(room?.game?.actionHistory) ? room.game.actionHistory : [];
}

function recentPassStreak(room) {
  const history = actionHistory(room);
  let streak = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index] !== "pass") {
      break;
    }
    streak += 1;
  }
  return streak;
}

function sanitizeMakerQuote(room, quote) {
  if (botProfile(room) !== "balanced" || !quote || !room.game.contract) {
    return quote;
  }

  const contract = room.game.contract;
  const width = Math.max(1, contract.rangeHigh - contract.rangeLow);
  const mid = (Number(quote.bid) + Number(quote.ask)) / 2;
  const passStreak = recentPassStreak(room);
  const maxSpread = width * (passStreak >= 2 ? 0.045 : 0.07);
  const minSpread = width * 0.018;
  const rawSpread = Math.max(minSpread, Math.min(maxSpread, Number(quote.ask) - Number(quote.bid)));
  const halfSpread = rawSpread / 2;
  const bid = clamp(round2(mid - halfSpread), contract.rangeLow, contract.rangeHigh - 0.01);
  const ask = clamp(round2(Math.max(mid + halfSpread, bid + 0.01)), bid + 0.01, contract.rangeHigh);

  return {
    bid,
    ask,
    size: clamp(Number(quote.size || 1), 1, passStreak >= 2 ? 1 : 2),
  };
}

function guardrailTakerAction(room, estimate, action, fallbackAction) {
  if (botProfile(room) !== "balanced" || !room.game.currentQuote || !room.game.contract) {
    return action;
  }
  const quote = room.game.currentQuote;
  const width = Math.max(1, room.game.contract.rangeHigh - room.game.contract.rangeLow);
  const buyEdge = (estimate - quote.ask) / width;
  const sellEdge = (quote.bid - estimate) / width;
  const bestEdge = Math.max(buyEdge, sellEdge);
  const passStreak = recentPassStreak(room);
  const spread = (quote.ask - quote.bid) / width;

  if (action === "pass" && fallbackAction !== "pass" && passStreak >= 2 && bestEdge > -0.002 && spread < 0.055) {
    return fallbackAction;
  }
  if (action !== "pass" && bestEdge < -0.03 && room.game.turn < room.game.maxTurns) {
    return "pass";
  }
  return action;
}

function takerQuoteOverride(room, estimate, currentAction) {
  const quote = room.game.currentQuote;
  if (!quote) {
    return currentAction;
  }

  const width = Math.max(1, room.game.contract.rangeHigh - room.game.contract.rangeLow);
  const previous = room.game.previousQuote;
  const buyEdge = (estimate - quote.ask) / width;
  const sellEdge = (quote.bid - estimate) / width;
  const spread = (quote.ask - quote.bid) / width;
  const prevSpread = previous ? (previous.ask - previous.bid) / width : spread;
  const askMove = previous ? (quote.ask - previous.ask) / width : 0;
  const bidMove = previous ? (quote.bid - previous.bid) / width : 0;
  const makerInventory = room.game.maker.inventory;

  if (spread < 0.012 && buyEdge > 0.004) {
    return "buy";
  }
  if (spread < 0.012 && sellEdge > 0.004) {
    return "sell";
  }
  if (makerInventory >= 2 && askMove < -0.01 && buyEdge > -0.002) {
    return "buy";
  }
  if (makerInventory <= -2 && bidMove > 0.01 && sellEdge > -0.002) {
    return "sell";
  }
  if (previous && spread > prevSpread * 1.35 && Math.max(buyEdge, sellEdge) < 0.008) {
    return "pass";
  }

  return currentAction;
}

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

export function refreshBotEstimate(room) {
  if (!room.bot?.enabled || !room.game.contract) {
    return;
  }
  const width = Math.max(1, room.game.contract.rangeHigh - room.game.contract.rangeLow);
  const noiseScale = botProfile(room) === "balanced" ? 0.18 : 0.14;
  const noise = (Math.random() * 2 - 1) * width * noiseScale;
  room.bot.privateEstimate = room.game.contract.hiddenValue + noise;
}

export function observeBotQuote(room, botPlayerId) {
  if (!room.bot?.enabled || room.bot.playerId !== botPlayerId || room.bot.privateEstimate === null) {
    return;
  }
  const role = botRole(room, botPlayerId);
  room.bot.privateEstimate = updateEstimateFromQuote(room, role, room.bot.privateEstimate);
}

export function observeBotResolution(room, botPlayerId) {
  if (!room.bot?.enabled || room.bot.playerId !== botPlayerId || room.bot.privateEstimate === null) {
    return;
  }
  const role = botRole(room, botPlayerId);
  room.bot.privateEstimate = updateEstimateFromResolution(room, role, room.bot.privateEstimate);
}

export async function botDecision(room, botPlayerId, env) {
  const role = botRole(room, botPlayerId);
  const estimate = room.bot?.privateEstimate ?? room.game.contract.hiddenValue;
  const fallbackValue = fallbackAction(room, role, estimate);
  const policy = await getRuntimeRlPolicy(env);

  if (role === GAME_ROLE.MAKER) {
    const stateKey = roleStateKey(room, role, estimate);
    const picked = pickActionFromPolicy(policy.maker, stateKey, fallbackValue);
    const actionIndex = typeof picked === "number" ? picked : fallbackValue;
    const quote = sanitizeMakerQuote(room, quoteFromMakerAction(room, estimate, actionIndex));
    return {
      type: "submit_quote",
      payload: quote,
      debug: {
        role,
        stateKey,
        actionId: MAKER_ACTIONS[actionIndex]?.id || "fallback",
      },
    };
  }

  const modeStateKey = takerModeStateKey(room, estimate);
  const fallbackMode = fallbackTakerMode(room, estimate);
  const pickedMode = pickActionFromPolicy(policy.takerModes, modeStateKey, fallbackMode);
  const mode = typeof pickedMode === "number" ? TAKER_MODES[pickedMode] || fallbackMode : pickedMode;
  const actionStateKey = takerActionStateKey(room, estimate, mode);
  const fallbackActionValue = fallbackTakerAction(room, estimate);
  const pickedAction = pickActionFromPolicy(policy.taker, actionStateKey, fallbackActionValue);
  const preferredAction =
    typeof pickedAction === "number" ? TAKER_DIRECTIONAL_ACTIONS[pickedAction] || fallbackActionValue : pickedAction;
  const modeledAction = takerActionForMode(room, estimate, mode, preferredAction, fallbackActionValue);
  const hybridAction = hybridTakerExecution(room, estimate, modeledAction, fallbackActionValue);
  const action = guardrailTakerAction(room, estimate, takerQuoteOverride(room, estimate, hybridAction), fallbackActionValue);
  return {
    type: "taker_action",
    payload: {
      action,
    },
    debug: {
      role,
      stateKey: actionStateKey,
      mode,
      actionId: action,
    },
  };
}
