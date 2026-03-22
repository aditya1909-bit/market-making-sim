import test from "node:test";
import assert from "node:assert/strict";

import { addCardBotsToRoom, markCardBotForRemoval, pruneCardBotsPendingRemoval } from "../src/card-bot-manager.js";
import { advanceCardBots } from "../src/card-bot-runtime.js";
import { buildCardPlayerView, prepareNextCardGame, startCardGame } from "../src/card-engine.js";
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
