import { GAME_ROLE } from "./protocol.js";
import {
  MAKER_ACTIONS,
  blendTakerAction,
  fallbackAction,
  pickActionFromPolicy,
  quoteFromMakerAction,
  roleStateKey,
  updateEstimateFromQuote,
  updateEstimateFromResolution,
} from "./rl-core.js";
import { RL_POLICY } from "./rl-policy-data.js";

const MIN_POLICY_SUPPORT = {
  maker: 20,
  taker: 20,
};

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

export function botDecision(room, botPlayerId) {
  const role = botRole(room, botPlayerId);
  const estimate = room.bot?.privateEstimate ?? room.game.contract.hiddenValue;
  const stateKey = roleStateKey(room, role, estimate);
  const policyTable = role === GAME_ROLE.MAKER ? RL_POLICY.maker : RL_POLICY.taker;
  const countTable = role === GAME_ROLE.MAKER ? RL_POLICY.counts?.maker : RL_POLICY.counts?.taker;
  const fallbackValue = fallbackAction(room, role, estimate);
  const minSupport = role === GAME_ROLE.MAKER ? MIN_POLICY_SUPPORT.maker : MIN_POLICY_SUPPORT.taker;
  const picked = pickActionFromPolicy(policyTable, stateKey, fallbackValue, 0, countTable, minSupport);

  if (role === GAME_ROLE.MAKER) {
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

  const blendedAction = blendTakerAction(room, estimate, typeof picked === "string" ? picked : fallbackValue, fallbackValue);
  const action = takerQuoteOverride(room, estimate, blendedAction);
  return {
    type: "taker_action",
    payload: {
      action,
    },
    debug: {
      role,
      stateKey,
      actionId: action,
    },
  };
}
