import { createPlayer, playerFor, removePlayerFromRoom } from "./game-engine.js";

export const CARD_BOT_KIND = "card_rl";
export const CARD_BOT_DELAY_RANGES = {
  initial: { minMs: 1_400, jitterMs: 2_400 },
  responsive: { minMs: 1_100, jitterMs: 2_100 },
  postAction: { minMs: 1_800, jitterMs: 3_200 },
};

const CARD_BOT_NAMES = [
  "Rook",
  "Bishop",
  "Knight",
  "Atlas",
  "Nova",
  "Echo",
  "Orion",
  "Jade",
  "Mako",
  "Talon",
  "Vega",
  "Sable",
  "Iris",
  "Comet",
  "Onyx",
];

function roomPaceMultiplier(room, now = Date.now()) {
  const moments = (room?.game?.recentActionMoments || [])
    .filter((value) => Number.isFinite(value) && now - value <= 20_000)
    .sort((a, b) => a - b);
  if (moments.length < 2) {
    return 1;
  }

  const intervals = [];
  for (let index = 1; index < moments.length; index += 1) {
    intervals.push(Math.max(150, moments[index] - moments[index - 1]));
  }
  if (!intervals.length) {
    return 1;
  }

  const averageInterval = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  return Math.min(1.22, Math.max(0.78, averageInterval / 2_500));
}

export function resolveCardBotDelayMs(room, kind = "responsive", now = Date.now()) {
  const profile = CARD_BOT_DELAY_RANGES[kind] || CARD_BOT_DELAY_RANGES.responsive;
  const pacedMin = Math.round(profile.minMs * roomPaceMultiplier(room, now));
  const pacedJitter = Math.max(150, Math.round(profile.jitterMs * roomPaceMultiplier(room, now)));
  return pacedMin + Math.floor(Math.random() * pacedJitter);
}

function scheduleBotWake(room, player, now = Date.now(), kind = "responsive") {
  player.botNextActionAt = now + resolveCardBotDelayMs(room, kind, now);
  return player.botNextActionAt;
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

function nextCardBotName(room) {
  const usedNames = new Set(room.players.map((player) => String(player.name || "")));
  for (const base of CARD_BOT_NAMES) {
    const candidate = `RL ${base}`;
    if (!usedNames.has(candidate)) {
      return candidate;
    }
  }
  let suffix = 2;
  while (usedNames.has(`RL Bot ${suffix}`)) {
    suffix += 1;
  }
  return `RL Bot ${suffix}`;
}

export function cardBotConnectedIds(room) {
  return new Set(cardBotPlayers(room).filter((player) => !player.pendingRemoval).map((player) => player.id));
}

export function createCardBotPlayer(room, policyVersion = "heuristic", now = Date.now()) {
  const player = createPlayer(nextCardBotName(room), {
    ready: true,
    isBot: true,
    lastActiveAt: now,
  });
  player.botKind = CARD_BOT_KIND;
  player.botPolicyVersion = policyVersion;
  scheduleBotWake(room, player, now, "initial");
  player.pendingRemoval = false;
  return player;
}

export function addCardBotsToRoom(room, count, policyVersion = "heuristic", now = Date.now()) {
  const availableSeats = Math.max(0, (room.maxPlayers || 10) - room.players.length);
  const resolvedCount = Math.max(0, Math.min(Number(count || 0), availableSeats));
  const added = [];
  for (let index = 0; index < resolvedCount; index += 1) {
    const bot = createCardBotPlayer(room, policyVersion, now);
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
    scheduleBotWake(room, player, now, "initial");
  });
}

export function scheduleCardBotPostAction(room, player, now = Date.now()) {
  return scheduleBotWake(room, player, now, "postAction");
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
    const scheduledAt = now + resolveCardBotDelayMs(room, "responsive", now);
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
