import test from "node:test";
import assert from "node:assert/strict";

import {
  addCardBotsToRoom,
  CARD_BOT_DELAY_RANGES,
  markCardBotForRemoval,
  pruneCardBotsPendingRemoval,
  resolveCardBotDelayMs,
} from "../src/card-bot-manager.js";
import { advanceCardBots } from "../src/card-bot-runtime.js";
import { buildCardPlayerView, prepareNextCardGame, startCardGame, submitCardQuote, takeCardAction } from "../src/card-engine.js";
import { resetRuntimeCardRlPolicyCache } from "../src/card-rl-policy-loader.js";
import { createRoomState } from "../src/game-engine.js";

function createLobbyRoom() {
  const room = createRoomState("BOT1", "Host", {
    gameType: "card_market",
    maxPlayers: 10,
    roomVisibility: "private_room",
  });
  prepareNextCardGame(room, { incrementGameNumber: true });
  return room;
}

test("card room view exposes bot metadata and connected status", () => {
  const room = createLobbyRoom();
  const [bot] = addCardBotsToRoom(room, 1, "policy-v1", 1_000);

  const view = buildCardPlayerView(room, room.hostId, new Set(), 1_000);
  const botEntry = view.players.find((entry) => entry.id === bot.id);

  assert.ok(botEntry);
  assert.equal(botEntry.isBot, true);
  assert.equal(botEntry.connected, true);
  assert.equal(botEntry.botKind, "card_rl");
  assert.equal(botEntry.botPolicyVersion, "policy-v1");
});

test("card room view exposes host status for the current viewer", () => {
  const room = createLobbyRoom();
  const [bot] = addCardBotsToRoom(room, 1, "policy-v1", 1_000);

  const hostView = buildCardPlayerView(room, room.hostId, new Set(), 1_000);
  const botView = buildCardPlayerView(room, bot.id, new Set(), 1_000);

  assert.equal(hostView.isHost, true);
  assert.equal(botView.isHost, false);
});

test("card bots get distinct generated names", () => {
  const room = createLobbyRoom();
  const added = addCardBotsToRoom(room, 3, "policy-v1", 1_000);
  const names = added.map((player) => player.name);

  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((name) => name.startsWith("RL ")));
});

test("active card bot removal is deferred until the round ends", () => {
  const room = createLobbyRoom();
  const [bot] = addCardBotsToRoom(room, 1, "policy-v1", 1_000);

  startCardGame(room, [room.hostId, bot.id], 2_000);

  const outcome = markCardBotForRemoval(room, bot.id);
  assert.deepEqual(outcome, { deferred: true, removed: false });
  assert.equal(room.players.find((entry) => entry.id === bot.id)?.pendingRemoval, true);

  room.status = "lobby";
  room.game.activeSeatIds = [];
  const removedCount = pruneCardBotsPendingRemoval(room);

  assert.equal(removedCount, 1);
  assert.equal(room.players.some((entry) => entry.id === bot.id), false);
});

test("card bots fall back to heuristic actions when no deployed policy is present", async () => {
  const room = createLobbyRoom();
  const [bot] = addCardBotsToRoom(room, 1, "heuristic", 1_000);

  startCardGame(room, [room.hostId, bot.id], 2_000);
  bot.botNextActionAt = 2_000;

  const changed = await advanceCardBots(room, {}, 2_000);

  assert.equal(changed, true);
  assert.ok(room.game.liveQuotes[bot.id] || room.game.revealVotes[bot.id]);
});

test("humans can trade against RL bot quotes", () => {
  const room = createLobbyRoom();
  const [bot] = addCardBotsToRoom(room, 1, "policy-v1", 1_000);

  startCardGame(room, [room.hostId, bot.id], 2_000);
  submitCardQuote(room, bot.id, { bid: 1, ask: 2, size: 1 });

  const view = buildCardPlayerView(room, room.hostId, new Set(), 2_500);
  assert.equal(view.game.liveQuotes.length, 1);
  assert.equal(view.game.liveQuotes[0].playerId, bot.id);
  assert.equal(view.game.liveQuotes[0].canTrade, true);

  takeCardAction(room, room.hostId, { targetPlayerId: bot.id, action: "buy" });
  assert.equal(room.game.positions[room.hostId].inventory, 1);
  assert.equal(room.game.positions[bot.id].inventory, -1);
});

test("card bots can trade with each other using the deployed policy runtime", async () => {
  resetRuntimeCardRlPolicyCache();
  const room = createLobbyRoom();
  const added = addCardBotsToRoom(room, 2, "policy-v1", 1_000);
  const [botA, botB] = added;

  startCardGame(room, [room.hostId, botA.id, botB.id], 2_000);
  botA.botNextActionAt = 2_500;
  botB.botNextActionAt = 4_000;

  const env = {
    CARD_RL_POLICY_KV: {
      async get(key) {
        if (key === "card-policy:metadata") {
          return { version: "test-v1", compatibilityVersion: 1 };
        }
        if (key === "card-policy:model") {
          return {
            quoteTemplates: [{ id: "mid_1", reservationOffset: 0, spreadScale: 1, size: 1 }],
            quoteHead: { weights: [[]], bias: [1] },
            takeHead: { candidateWeights: [], candidateBias: 5, passWeights: [], passBias: -5 },
            revealHead: { weights: [], bias: -5 },
          };
        }
        return null;
      },
    },
  };

  const quoted = await advanceCardBots(room, env, 2_500);
  assert.equal(quoted, true);
  assert.ok(room.game.liveQuotes[botA.id]);

  const traded = await advanceCardBots(room, env, 4_000);
  assert.equal(traded, true);
  const botInventories = [room.game.positions[botA.id].inventory, room.game.positions[botB.id].inventory];
  assert.ok(botInventories.some((value) => value !== 0));
  assert.ok(botInventories.includes(1) || botInventories.includes(-1));
});

test("acting card bots receive a longer stochastic cooldown", async () => {
  resetRuntimeCardRlPolicyCache();
  const room = createLobbyRoom();
  const [bot] = addCardBotsToRoom(room, 1, "policy-v1", 1_000);

  startCardGame(room, [room.hostId, bot.id], 2_000);
  bot.botNextActionAt = 2_500;

  const env = {
    CARD_RL_POLICY_KV: {
      async get(key) {
        if (key === "card-policy:metadata") {
          return { version: "test-v1", compatibilityVersion: 1 };
        }
        if (key === "card-policy:model") {
          return {
            quoteTemplates: [{ id: "mid_1", reservationOffset: 0, spreadScale: 1, size: 1 }],
            quoteHead: { weights: [[]], bias: [1] },
            takeHead: { candidateWeights: [], candidateBias: -5, passWeights: [], passBias: 0 },
            revealHead: { weights: [], bias: -5 },
          };
        }
        return null;
      },
    },
  };

  await advanceCardBots(room, env, 2_500);

  const delay = Number(bot.botNextActionAt) - 2_500;
  assert.ok(delay >= CARD_BOT_DELAY_RANGES.postAction.minMs);
  assert.ok(delay < CARD_BOT_DELAY_RANGES.postAction.minMs + CARD_BOT_DELAY_RANGES.postAction.jitterMs);
});

test("card bot reaction delay partially follows the table pace", () => {
  const fastRoom = createLobbyRoom();
  const slowRoom = createLobbyRoom();
  const now = 10_000;

  fastRoom.game.recentActionMoments = [now - 1_400, now - 1_050, now - 700, now - 350];
  slowRoom.game.recentActionMoments = [now - 12_000, now - 8_000, now - 4_000, now - 500];

  const random = Math.random;
  Math.random = () => 0.5;
  try {
    const fastDelay = resolveCardBotDelayMs(fastRoom, "responsive", now);
    const slowDelay = resolveCardBotDelayMs(slowRoom, "responsive", now);

    assert.ok(fastDelay < slowDelay);
    assert.ok(fastDelay >= Math.floor(CARD_BOT_DELAY_RANGES.responsive.minMs * 0.78));
    assert.ok(slowDelay <= Math.ceil((CARD_BOT_DELAY_RANGES.responsive.minMs + CARD_BOT_DELAY_RANGES.responsive.jitterMs) * 1.22));
  } finally {
    Math.random = random;
  }
});
