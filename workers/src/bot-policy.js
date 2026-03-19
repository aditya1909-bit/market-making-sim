import { GAME_ROLE } from "./protocol.js";
import {
  MAKER_ACTIONS,
  fallbackAction,
  pickActionFromPolicy,
  quoteFromMakerAction,
  roleStateKey,
} from "./rl-core.js";
import { RL_POLICY } from "./rl-policy-data.js";

function botRole(room, botPlayerId) {
  return room.makerId === botPlayerId ? GAME_ROLE.MAKER : GAME_ROLE.TAKER;
}

export function refreshBotEstimate(room) {
  if (!room.bot?.enabled || !room.game.contract) {
    return;
  }
  const width = Math.max(1, room.game.contract.rangeHigh - room.game.contract.rangeLow);
  const noise = (Math.random() * 2 - 1) * width * 0.14;
  room.bot.privateEstimate = room.game.contract.hiddenValue + noise;
}

export function botDecision(room, botPlayerId) {
  const role = botRole(room, botPlayerId);
  const estimate = room.bot?.privateEstimate ?? room.game.contract.hiddenValue;
  const stateKey = roleStateKey(room, role, estimate);
  const policyTable = role === GAME_ROLE.MAKER ? RL_POLICY.maker : RL_POLICY.taker;
  const fallbackValue = fallbackAction(room, role, estimate);
  const picked = pickActionFromPolicy(policyTable, stateKey, fallbackValue);

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

  return {
    type: "taker_action",
    payload: {
      action: typeof picked === "string" ? picked : fallbackValue,
    },
    debug: {
      role,
      stateKey,
      actionId: typeof picked === "string" ? picked : fallbackValue,
    },
  };
}
