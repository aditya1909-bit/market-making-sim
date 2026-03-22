import { createPlayer, playerFor, removePlayerFromRoom } from "./game-engine.js";

export const CARD_BOT_KIND = "card_rl";

function reactionDelayMs() {
  return 350 + Math.floor(Math.random() * 900);
}

function nonRemovedPlayers(room) {
  return room.players.filter((player) => !player.pendingRemoval);
}

function waitingCardBots(room) {
  const activeSeatIds = new Set(room.game.activeSeatIds || []);
  return room.players.filter((player) => player.isBot && !player.pendingRemoval && !activeSeatIds.has(player.id));
}

export function cardBotPlayers(room) {
  if (!room) {
    return [];
  }
  return room.players.filter((player) => player.isBot && player.botKind === CARD_BOT_KIND);
}

export function cardBotConnectedIds(room) {
  return new Set(cardBotPlayers(room).filter((player) => !player.pendingRemoval).map((player) => player.id));
}

export function createCardBotPlayer(policyVersion = "heuristic", now = Date.now()) {
  const player = createPlayer("RL Card Bot", {
    ready: true,
    isBot: true,
    lastActiveAt: now,
  });
  player.botKind = CARD_BOT_KIND;
  player.botPolicyVersion = policyVersion;
  player.botNextActionAt = now + reactionDelayMs();
  player.pendingRemoval = false;
  return player;
}

export function addCardBotsToRoom(room, count, policyVersion = "heuristic", now = Date.now()) {
  const availableSeats = Math.max(0, (room.maxPlayers || 10) - room.players.length);
  const resolvedCount = Math.max(0, Math.min(Number(count || 0), availableSeats));
  const added = [];
  for (let index = 0; index < resolvedCount; index += 1) {
    const bot = createCardBotPlayer(policyVersion, now);
    room.players.push(bot);
    added.push(bot);
  }
  return added;
}

export function markCardBotForRemoval(room, botPlayerId) {
  const player = playerFor(room, botPlayerId);
  if (!player || !player.isBot || player.botKind !== CARD_BOT_KIND) {
    throw new Error("Unknown card bot.");
  }

  const activeSeatIds = new Set(room.game.activeSeatIds || []);
  if (room.status === "live" && activeSeatIds.has(botPlayerId)) {
    player.pendingRemoval = true;
    player.ready = false;
    return { deferred: true, removed: false };
  }

  removePlayerFromRoom(room, botPlayerId);
  return { deferred: false, removed: true };
}

export function pruneCardBotsPendingRemoval(room) {
  const activeSeatIds = new Set(room.game.activeSeatIds || []);
  const removable = room.players.filter((player) => player.pendingRemoval && !activeSeatIds.has(player.id));
  removable.forEach((player) => {
    removePlayerFromRoom(room, player.id);
  });
  return removable.length;
}

export function ensureCardBotsReady(room) {
  cardBotPlayers(room).forEach((player) => {
    if (!player.pendingRemoval) {
      player.ready = true;
    }
  });
}

export function reseedCardBotWakeups(room, now = Date.now(), specificPlayerIds = null) {
  const limited = specificPlayerIds ? new Set(specificPlayerIds) : null;
  cardBotPlayers(room).forEach((player) => {
    if (player.pendingRemoval) {
      return;
    }
    if (limited && !limited.has(player.id)) {
      return;
    }
    player.botNextActionAt = now + reactionDelayMs();
  });
}

export function nudgeResponsiveCardBots(room, now = Date.now(), excludePlayerId = null) {
  const waitingIds = waitingCardBots(room).map((player) => player.id);
  const activeSeatIds = new Set(room.game.activeSeatIds || []);
  room.players.forEach((player) => {
    if (!player.isBot || player.pendingRemoval || player.id === excludePlayerId) {
      return;
    }
    if (!activeSeatIds.has(player.id) && !waitingIds.includes(player.id)) {
      return;
    }
    const scheduledAt = now + reactionDelayMs();
    if (!Number.isFinite(player.botNextActionAt) || player.botNextActionAt > scheduledAt) {
      player.botNextActionAt = scheduledAt;
    }
  });
}

export function nextCardBotAlarmAt(room) {
  const deadlines = cardBotPlayers(room)
    .filter((player) => !player.pendingRemoval && Number.isFinite(player.botNextActionAt))
    .map((player) => Number(player.botNextActionAt));
  if (!deadlines.length) {
    return null;
  }
  return Math.min(...deadlines);
}

export function cardBotDebugPlayers(room) {
  return nonRemovedPlayers(room).filter((player) => player.isBot && player.botKind === CARD_BOT_KIND);
}
