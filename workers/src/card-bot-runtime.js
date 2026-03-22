import { requestCardRevealVote, submitCardQuote, takeCardAction } from "./card-engine.js";
import { chooseCardBotDecision, policyVersionLabel } from "./card-rl-core.js";
import { getRuntimeCardRlPolicy } from "./card-rl-policy-loader.js";
import {
  cardBotPlayers,
  nudgeResponsiveCardBots,
  nextCardBotAlarmAt,
  pruneCardBotsPendingRemoval,
  reseedCardBotWakeups,
} from "./card-bot-manager.js";

function isDue(player, now) {
  return !Number.isFinite(player.botNextActionAt) || Number(player.botNextActionAt) <= now;
}

export function nextCardBotWakeAt(room) {
  return nextCardBotAlarmAt(room);
}

export async function resolveCardPolicyVersion(env, requestedVersion = null) {
  const policy = await getRuntimeCardRlPolicy(env);
  const actualVersion = policyVersionLabel(policy);
  if (requestedVersion && String(requestedVersion) !== String(actualVersion)) {
    throw new Error(`Requested card policy version ${requestedVersion} is not loaded. Active version is ${actualVersion}.`);
  }
  return actualVersion;
}

export async function advanceCardBots(room, env, now = Date.now()) {
  if (room?.gameType !== "card_market") {
    return false;
  }

  let changed = false;
  const removedCount = pruneCardBotsPendingRemoval(room);
  if (removedCount > 0) {
    changed = true;
  }

  if (room.status !== "live") {
    return changed;
  }

  const policy = await getRuntimeCardRlPolicy(env);
  const activeSeatIds = new Set(room.game.activeSeatIds || []);

  for (let passes = 0; passes < 24; passes += 1) {
    const dueBots = cardBotPlayers(room)
      .filter((player) => !player.pendingRemoval && activeSeatIds.has(player.id) && isDue(player, now))
      .sort((a, b) => Number(a.botNextActionAt || 0) - Number(b.botNextActionAt || 0) || a.id.localeCompare(b.id));

    if (!dueBots.length) {
      break;
    }

    let acted = false;
    for (const bot of dueBots) {
      const decision = chooseCardBotDecision(room, bot.id, policy, now);
      if (decision.type === "submit_quote" && decision.payload) {
        submitCardQuote(room, bot.id, decision.payload);
        acted = true;
      } else if (decision.type === "taker_action" && decision.payload?.targetPlayerId) {
        takeCardAction(room, bot.id, decision.payload);
        acted = true;
      } else if (decision.type === "request_next_reveal") {
        requestCardRevealVote(room, bot.id, now);
        acted = true;
      }

      bot.botPolicyVersion = bot.botPolicyVersion || policyVersionLabel(policy);
      bot.botNextActionAt = now + 700 + Math.floor(Math.random() * 800);

      if (acted) {
        changed = true;
        nudgeResponsiveCardBots(room, now, bot.id);
      }
    }

    if (!acted) {
      break;
    }
  }

  return changed;
}

export function reseedLiveCardBots(room, now = Date.now(), specificPlayerIds = null) {
  reseedCardBotWakeups(room, now, specificPlayerIds);
}
