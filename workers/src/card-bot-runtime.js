import { cardTradingOpen, requestCardRevealVote, submitCardQuote, takeCardAction } from "./card-engine.js";
import { chooseCardBotDecision, policyVersionLabel } from "./card-rl-core.js";
import { getRuntimeCardRlPolicyRegistry } from "./card-rl-policy-loader.js";
import {
  cardBotPlayers,
  nudgeMarketResponsiveCardBots,
  nudgeResponsiveCardBots,
  nextCardBotAlarmAt,
  pruneCardBotsPendingRemoval,
  reseedCardBotWakeups,
  scheduleCardBotPostAction,
  scheduleCardBotWaitAction,
} from "./card-bot-manager.js";

function isDue(player, now) {
  return !Number.isFinite(player.botNextActionAt) || Number(player.botNextActionAt) <= now;
}

function pickRandom(items) {
  if (!items.length) {
    return null;
  }
  return items[Math.floor(Math.random() * items.length)] || null;
}

function withProfile(assignment, profile = "balanced") {
  return {
    ...assignment,
    profile: String(profile || "balanced").trim() || "balanced",
  };
}

function resolveDefaultAssignments(registry, count, profile = "balanced") {
  const linearId = registry?.metadata?.defaultPolicyIds?.linear || null;
  const neuralId = registry?.metadata?.defaultPolicyIds?.neural || null;
  const choices = [linearId, neuralId].filter(Boolean);
  if (!choices.length) {
    return Array.from({ length: count }, () => withProfile({ version: "heuristic", family: "heuristic" }, profile));
  }
  return Array.from({ length: count }, () => {
    const selectedId = pickRandom(choices);
    const family = registry?.policies?.[selectedId]?.family || "linear";
    return withProfile({ version: selectedId, family }, profile);
  });
}

export function nextCardBotWakeAt(room) {
  return nextCardBotAlarmAt(room);
}

export async function resolveCardPolicyAssignments(env, requestedVersion = null, count = 1, profile = "balanced") {
  const registry = await getRuntimeCardRlPolicyRegistry(env);
  if (requestedVersion) {
    const policy = registry?.policies?.[requestedVersion];
    if (!policy) {
      throw new Error(`Requested card policy version ${requestedVersion} is not loaded.`);
    }
    return Array.from({ length: count }, () => withProfile({ version: policy.id, family: policy.family || null }, profile));
  }
  return resolveDefaultAssignments(registry, count, profile);
}

export async function resolveCardPolicyVersion(env, requestedVersion = null) {
  const [assignment] = await resolveCardPolicyAssignments(env, requestedVersion, 1);
  return assignment?.version || "heuristic";
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

  if (!cardTradingOpen(room, now)) {
    const tradingStartsAt = Number(room.game.tradingStartsAt || now);
    cardBotPlayers(room)
      .filter((player) => !player.pendingRemoval && Number.isFinite(player.botNextActionAt) && player.botNextActionAt < tradingStartsAt)
      .forEach((player) => {
        player.botNextActionAt = tradingStartsAt;
      });
    return changed;
  }

  const registry = await getRuntimeCardRlPolicyRegistry(env);
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
      const policy = registry?.policies?.[bot.botPolicyVersion] || null;
      const decision = chooseCardBotDecision(room, bot.id, policy, now);
      let actionTaken = false;
      if (decision.type === "submit_quote" && decision.payload) {
        submitCardQuote(room, bot.id, decision.payload);
        actionTaken = true;
        nudgeMarketResponsiveCardBots(room, now, bot.id);
      } else if (decision.type === "taker_action" && decision.payload?.targetPlayerId) {
        takeCardAction(room, bot.id, decision.payload);
        actionTaken = true;
        nudgeMarketResponsiveCardBots(room, now, bot.id);
      } else if (decision.type === "request_next_reveal") {
        requestCardRevealVote(room, bot.id, now);
        actionTaken = true;
      }

      bot.botPolicyVersion = bot.botPolicyVersion || policyVersionLabel(policy);
      bot.botPolicyFamily = bot.botPolicyFamily || policy?.family || "heuristic";
      if (actionTaken) {
        scheduleCardBotPostAction(room, bot, now);
        changed = true;
        acted = true;
        nudgeResponsiveCardBots(room, now, bot.id);
      } else {
        scheduleCardBotWaitAction(room, bot, now);
        changed = true;
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
