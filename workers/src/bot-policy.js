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
  const noise = (Math.random() * 2 - 1) * width * 0.14;
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
    const quote = quoteFromMakerAction(room, estimate, typeof picked === "number" ? picked : fallbackValue);
    return {
      type: "submit_quote",
      payload: quote,
      debug: {
        role,
        stateKey,
        actionId: MAKER_ACTIONS[typeof picked === "number" ? picked : fallbackValue]?.id || "fallback",
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
  const action = takerQuoteOverride(room, estimate, hybridAction);
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
