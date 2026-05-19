import test from "node:test";
import assert from "node:assert/strict";

import {
  addCardBotsToRoom,
  CARD_BOT_DELAY_RANGES,
  markCardBotForRemoval,
  pruneCardBotsPendingRemoval,
  resolveCardBotDelayMs,
} from "../src/card-bot-manager.js";
import { advanceCardBots, resolveCardPolicyAssignments } from "../src/card-bot-runtime.js";
import { buildCardPlayerView, prepareNextCardGame, startCardGame, submitCardQuote, takeCardAction } from "../src/card-engine.js";
import { chooseCardBotDecision } from "../src/card-rl-core.js";
import { resetRuntimeCardRlPolicyCache } from "../src/card-rl-policy-loader.js";
import { createRoomState } from "../src/game-engine.js";

function createLinearPolicyEntry(id = "linear-v2") {
  return {
    id,
    family: "linear",
    version: id,
    compatibilityVersion: 2,
    model: {
      modelType: "linear",
      compatibilityVersion: 2,
      quoteTemplates: [{ id: "mid_00_100_1", reservationOffset: 0, spreadScale: 1, size: 1 }],
      intentHead: { weights: [[0, 0, 0, 0, 0, 0, 5], [0], [0], [0]], bias: [0, 3, -5, -5], labels: ["take", "quote", "reveal", "wait"] },
      quoteHead: { weights: [[0]], bias: [1] },
      takeHead: { candidateWeights: [], candidateBias: 2, passWeights: [], passBias: -1 },
      revealHead: { weights: [], bias: -5 },
    },
  };
}

function createNeuralPolicyEntry(id = "neural-v1") {
  return {
    id,
    family: "neural",
    version: id,
    compatibilityVersion: 2,
    model: {
      modelType: "neural_mlp",
      compatibilityVersion: 2,
      hiddenSize: 23,
      quoteTemplates: [{ id: "mid_00_100_1", reservationOffset: 0, spreadScale: 1, size: 1 }],
      trunk: {
        weights: Array.from({ length: 23 }, (_, row) => Array.from({ length: 23 }, (_, col) => (row === col ? 1 : 0))),
        bias: Array.from({ length: 23 }, () => 0),
      },
      intentHead: { weights: [[0, 0, 0, 0, 0, 0, 5], [0], [0], [0]], bias: [0, 2, -5, -5], labels: ["take", "quote", "reveal", "wait"] },
      quoteHead: { stateWeights: [[0]], templateWeights: [[0, 0, 0]], bias: [1] },
      takeHead: { candidateStateWeights: [], candidateExtraWeights: [], candidateBias: 2, passWeights: [], passBias: -1 },
      revealHead: { weights: [], bias: -5 },
    },
  };
}

function createRegistryEnv() {
  const linear = createLinearPolicyEntry();
  const neural = createNeuralPolicyEntry();
  return {
    CARD_RL_POLICY_KV: {
      async get(key) {
        if (key === "card-policy:metadata") {
          return { compatibilityVersion: 2, defaultPolicyIds: { linear: linear.id, neural: neural.id } };
        }
        if (key === "card-policy:registry") {
          return {
            metadata: { compatibilityVersion: 2, defaultPolicyIds: { linear: linear.id, neural: neural.id } },
            policies: {
              [linear.id]: linear,
              [neural.id]: neural,
            },
          };
        }
        return null;
      },
    },
  };
}

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
  const [bot] = addCardBotsToRoom(room, 1, { version: "linear-v2", family: "linear" }, 1_000);

  const view = buildCardPlayerView(room, room.hostId, new Set(), 1_000);
  const botEntry = view.players.find((entry) => entry.id === bot.id);

  assert.ok(botEntry);
  assert.equal(botEntry.isBot, true);
  assert.equal(botEntry.connected, true);
  assert.equal(botEntry.botKind, "card_rl");
  assert.equal(botEntry.botProfile, "balanced");
  assert.equal(botEntry.botDisplayName, "Balanced Bot");
  assert.equal(botEntry.botPolicyFamily, "linear");
  assert.equal(botEntry.botPolicyVersion, "linear-v2");
});

test("card bots can be assigned distinct policy families at add time", () => {
  const room = createLobbyRoom();
  const added = addCardBotsToRoom(
    room,
    2,
    [
      { version: "linear-v2", family: "linear" },
      { version: "neural-v1", family: "neural" },
    ],
    1_000
  );

  assert.equal(added[0].botPolicyFamily, "linear");
  assert.equal(added[1].botPolicyFamily, "neural");
});

test("active card bot removal is deferred until the round ends", () => {
  const room = createLobbyRoom();
  const [bot] = addCardBotsToRoom(room, 1, { version: "linear-v2", family: "linear" }, 1_000);

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

test("card bots fall back to heuristic actions when no deployed registry is present", async () => {
  const room = createLobbyRoom();
  const [bot] = addCardBotsToRoom(room, 1, { version: "heuristic", family: "heuristic" }, 1_000);

  startCardGame(room, [room.hostId, bot.id], 2_000);
  bot.botNextActionAt = 33_000;

  const changed = await advanceCardBots(room, {}, 33_000);

  assert.equal(changed, true);
  assert.ok(room.game.liveQuotes[bot.id] || room.game.revealVotes[bot.id]);
});

test("humans can trade against RL bot quotes", () => {
  const room = createLobbyRoom();
  const [bot] = addCardBotsToRoom(room, 1, { version: "linear-v2", family: "linear" }, 1_000);

  startCardGame(room, [room.hostId, bot.id], 2_000);
  submitCardQuote(room, bot.id, { bid: 0, ask: 1, size: 1 });

  const view = buildCardPlayerView(room, room.hostId, new Set(), 35_000);
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
  const now = Date.now();
  const [botA, botB] = addCardBotsToRoom(
    room,
    2,
    [
      { version: "linear-v2", family: "linear" },
      { version: "neural-v1", family: "neural" },
    ],
    1_000
  );

  startCardGame(room, [room.hostId, botA.id, botB.id], now - 40_000);
  room.game.liveQuotes[botA.id] = { bid: -80, ask: -40, size: 1, quotedAt: now - 2_000 };
  botA.botNextActionAt = now + 25_000;
  botB.botNextActionAt = now;

  const traded = await advanceCardBots(room, createRegistryEnv(), now);
  assert.equal(traded, true);
  const botInventories = [room.game.positions[botA.id].inventory, room.game.positions[botB.id].inventory];
  assert.ok(botInventories.some((value) => value !== 0));
});

test("acting card bots receive a longer stochastic cooldown", async () => {
  resetRuntimeCardRlPolicyCache();
  const room = createLobbyRoom();
  const [bot] = addCardBotsToRoom(room, 1, { version: "linear-v2", family: "linear" }, 1_000);

  startCardGame(room, [room.hostId, bot.id], 2_000);
  bot.botNextActionAt = 33_000;

  await advanceCardBots(room, createRegistryEnv(), 33_000);

  const delay = Number(bot.botNextActionAt) - 33_000;
  assert.ok(delay >= CARD_BOT_DELAY_RANGES.postAction.minMs);
  assert.ok(delay < CARD_BOT_DELAY_RANGES.postAction.minMs + CARD_BOT_DELAY_RANGES.postAction.jitterMs);
});

test("card bot reaction delay partially follows the table pace", () => {
  const fastRoom = createLobbyRoom();
  const slowRoom = createLobbyRoom();
  const now = 10_000;

  fastRoom.game.recentActionMoments = [now - 1_400, now - 1_050, now - 700, now - 350];
  slowRoom.game.recentActionMoments = [now - 19_000, now - 9_000, now - 500];

  const random = Math.random;
  Math.random = () => 0.5;
  try {
    const fastDelay = resolveCardBotDelayMs(fastRoom, "responsive", now);
    const slowDelay = resolveCardBotDelayMs(slowRoom, "responsive", now);

    assert.ok(fastDelay < slowDelay);
    assert.ok(fastDelay >= CARD_BOT_DELAY_RANGES.responsive.minMs);
    assert.ok(slowDelay <= Math.ceil((CARD_BOT_DELAY_RANGES.responsive.minMs + CARD_BOT_DELAY_RANGES.responsive.jitterMs) * 1.18));
  } finally {
    Math.random = random;
  }
});

test("policy runtime prefers taking strong live quotes over refreshing its own quote", () => {
  const room = createLobbyRoom();
  const [botA, botB] = addCardBotsToRoom(
    room,
    2,
    [
      { version: "linear-v2", family: "linear" },
      { version: "linear-v2", family: "linear" },
    ],
    1_000
  );

  startCardGame(room, [room.hostId, botA.id, botB.id], 2_000);
  room.game.liveQuotes[botA.id] = { bid: -80, ask: -40, size: 1, quotedAt: 32_000 };

  const decision = chooseCardBotDecision(room, botB.id, createLinearPolicyEntry(), 35_000);

  assert.equal(decision.type, "taker_action");
  assert.equal(decision.payload?.targetPlayerId, botA.id);
});

test("heuristic fallback takes stale favorable quotes instead of parking", () => {
  const room = createLobbyRoom();
  const [botA, botB] = addCardBotsToRoom(
    room,
    2,
    [
      { version: "heuristic", family: "heuristic" },
      { version: "heuristic", family: "heuristic" },
    ],
    1_000
  );

  startCardGame(room, [room.hostId, botA.id, botB.id], Date.now() - 40_000);
  room.game.liveQuotes[botA.id] = { bid: -90, ask: -55, size: 1, initialSize: 1, quotedAt: Date.now() - 18_000 };

  const decision = chooseCardBotDecision(room, botB.id, null, Date.now());

  assert.equal(decision.type, "taker_action");
  assert.equal(decision.payload?.targetPlayerId, botA.id);
});

test("waiting card bots receive a short cooldown instead of staying immediately due", async () => {
  const room = createLobbyRoom();
  const [bot] = addCardBotsToRoom(room, 1, { version: "heuristic", family: "heuristic" }, 1_000);
  const now = Date.now();

  startCardGame(room, [room.hostId, bot.id], now - 40_000);
  room.game.revealedBoardCount = room.game.boardCards.length;
  room.game.liveQuotes[bot.id] = { bid: 1, ask: 2, size: 1, initialSize: 1, quotedAt: now - 1_000 };
  bot.botNextActionAt = now;

  const changed = await advanceCardBots(room, {}, now);

  assert.equal(changed, true);
  assert.ok(bot.botNextActionAt > now);
  assert.ok(bot.botNextActionAt - now < CARD_BOT_DELAY_RANGES.wait.minMs + CARD_BOT_DELAY_RANGES.wait.jitterMs + 1_000);
});

test("resolveCardPolicyAssignments picks only registered live policy ids", async () => {
  resetRuntimeCardRlPolicyCache();
  const random = Math.random;
  let picks = [0.1, 0.9, 0.2, 0.8];
  Math.random = () => picks.shift() ?? 0.1;
  try {
    const assignments = await resolveCardPolicyAssignments(createRegistryEnv(), null, 4);
    assert.deepEqual(
      assignments.map((entry) => entry.version),
      ["linear-v2", "neural-v1", "linear-v2", "neural-v1"]
    );
    assert.deepEqual(
      assignments.map((entry) => entry.family),
      ["linear", "neural", "linear", "neural"]
    );
  } finally {
    Math.random = random;
  }
});

test("resolveCardPolicyAssignments falls back to heuristic when no family passed the live gate", async () => {
  resetRuntimeCardRlPolicyCache();
  const env = {
    CARD_RL_POLICY_KV: {
      async get(key) {
        if (key === "card-policy:metadata") {
          return { compatibilityVersion: 2, defaultPolicyIds: {} };
        }
        if (key === "card-policy:registry") {
          return {
            metadata: { compatibilityVersion: 2, defaultPolicyIds: {} },
            policies: {
              "linear-v2": createLinearPolicyEntry(),
              "neural-v1": createNeuralPolicyEntry(),
            },
          };
        }
        return null;
      },
    },
  };

  const assignments = await resolveCardPolicyAssignments(env, null, 2);
  assert.deepEqual(assignments, [
    { version: "heuristic", family: "heuristic", profile: "balanced" },
    { version: "heuristic", family: "heuristic", profile: "balanced" },
  ]);
});
