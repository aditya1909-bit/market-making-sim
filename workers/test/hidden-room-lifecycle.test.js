import test from "node:test";
import assert from "node:assert/strict";

import { sampleContract } from "../src/contracts.js";
import {
  addPlayerToRoom,
  buildPlayerView,
  createBotRoomState,
  createRoomState,
  finishGame,
  handleHiddenPlayerDeparture,
  inactivePlayerIds,
  markPlayerActive,
  nextInactivityDeadline,
  prepareNextGame,
  requestRematch,
  startGame,
  submitQuote,
  takeAction,
} from "../src/game-engine.js";
import { botDecision } from "../src/bot-policy.js";

function createTwoPlayerRoom() {
  const room = createRoomState("TEST1", "Alpha");
  prepareNextGame(room, sampleContract());
  const second = addPlayerToRoom(room, "Bravo");
  return { room, second };
}

function fixedContract() {
  return {
    id: "fixed-contract",
    prompt: "Fixed test contract",
    unitLabel: "points",
    family: "test_family",
    category: "test_family",
    benchmarkValue: 50,
    rangeLow: 0,
    rangeHigh: 100,
    maxTurns: 8,
    sourceLabel: "Test source",
    sourceUrl: "https://example.com/test-source",
    answerRationale: "Test source: benchmark sits near 50 points and this round settles at 50 points.",
    hiddenValue: 50,
  };
}

function createFixedContractRoom() {
  const room = createRoomState("TESTF", "Alpha");
  const second = addPlayerToRoom(room, "Bravo");
  prepareNextGame(room, fixedContract());
  room.players.forEach((player) => {
    player.ready = true;
  });
  startGame(room);
  return { room, second };
}

test("leaving a hidden-value room frees the seat and allows a replacement player", () => {
  const { room, second } = createTwoPlayerRoom();

  const outcome = handleHiddenPlayerDeparture(room, second.id, "Bravo left the room. Waiting for a new opponent.");

  assert.equal(outcome.roomEmpty, false);
  assert.equal(room.players.length, 1);
  assert.equal(room.players[0].name, "Alpha");
  assert.equal(room.makerId, null);
  assert.equal(room.takerId, null);
  assert.equal(room.status, "lobby");
  assert.equal(room.game.contract, null);
  assert.match(room.game.lastResolution.text, /Waiting for a new opponent/);

  const replacement = addPlayerToRoom(room, "Charlie");
  assert.equal(room.players.length, 2);
  assert.ok(room.makerId);
  assert.ok(room.takerId);
  assert.notEqual(room.makerId, room.takerId);
  assert.equal(replacement.name, "Charlie");

  prepareNextGame(room, sampleContract());
  assert.ok(room.game.contract);
  assert.equal(room.status, "lobby");
});

test("leaving during a live hidden-value round cancels the round and returns to lobby", () => {
  const { room, second } = createTwoPlayerRoom();
  room.players.forEach((player) => {
    player.ready = true;
  });
  startGame(room);

  handleHiddenPlayerDeparture(room, second.id, "Bravo left the room. The round was cancelled. Waiting for a new opponent.");

  assert.equal(room.players.length, 1);
  assert.equal(room.status, "lobby");
  assert.equal(room.game.contract, null);
  assert.equal(room.game.currentQuote, null);
  assert.equal(room.game.activeActor, null);
  assert.match(room.game.lastResolution.text, /round was cancelled/i);
});

test("normal rematch flow still works after a completed round", () => {
  const { room } = createTwoPlayerRoom();
  room.players.forEach((player) => {
    player.ready = true;
  });
  const makerBefore = room.makerId;
  const takerBefore = room.takerId;

  startGame(room);
  finishGame(room);

  room.players.forEach((player) => {
    requestRematch(room, player.id);
  });
  prepareNextGame(room, sampleContract(), { swap: true, autoStart: false });

  assert.equal(room.status, "lobby");
  assert.equal(room.makerId, takerBefore);
  assert.equal(room.takerId, makerBefore);
  assert.ok(room.game.contract);
});

test("accepted hidden-value trades pay maker rebate and taker fee from the shared rate schedule", () => {
  const { room } = createFixedContractRoom();

  submitQuote(room, room.makerId, { bid: 49, ask: 51, size: 2 });
  takeAction(room, room.takerId, { action: "buy" });

  assert.equal(room.game.maker.cash, 102.06);
  assert.equal(room.game.taker.cash, -102.06);
  assert.match(room.game.log[0].text, /Maker rebate 0.06/i);
  assert.match(room.game.log[0].text, /Taker fee 0.06/i);
});

test("hidden-value quotes must stay inside the displayed range and max size", () => {
  const { room } = createFixedContractRoom();

  assert.throws(() => submitQuote(room, room.makerId, { bid: -1, ask: 51, size: 1 }), /inside the contract range/i);
  assert.throws(() => submitQuote(room, room.makerId, { bid: 49, ask: 101, size: 1 }), /inside the contract range/i);
  assert.throws(() => submitQuote(room, room.makerId, { bid: 49, ask: 51, size: 6 }), /whole number between 1 and 5/i);
});

test("passing on a very tight hidden-value quote penalizes the taker at the shared rate", () => {
  const { room } = createFixedContractRoom();

  submitQuote(room, room.makerId, { bid: 49, ask: 51, size: 1 });
  takeAction(room, room.takerId, { action: "pass" });
  assert.equal(room.game.taker.cash, -0.05);
  assert.match(room.game.log[0].text, /tight-spread refusal penalty 0.05/i);

  submitQuote(room, room.makerId, { bid: 49, ask: 51, size: 1 });
  takeAction(room, room.takerId, { action: "pass" });

  assert.equal(room.game.taker.cash, -0.1);
  assert.match(room.game.log[0].text, /tight-spread refusal penalty 0.05/i);
});

test("passing on a very wide hidden-value quote penalizes the maker at the shared rate", () => {
  const { room } = createFixedContractRoom();

  submitQuote(room, room.makerId, { bid: 35, ask: 65, size: 1 });
  takeAction(room, room.takerId, { action: "pass" });
  assert.equal(room.game.maker.cash, -0.12);
  assert.match(room.game.log[0].text, /Maker wide-spread penalty 0.12/i);

  submitQuote(room, room.makerId, { bid: 35, ask: 65, size: 1 });
  takeAction(room, room.takerId, { action: "pass" });

  assert.equal(Number(room.game.maker.cash.toFixed(2)), -0.24);
  assert.match(room.game.log[0].text, /Maker wide-spread penalty 0.12/i);
});

test("hidden-value trade resets both penalty streaks", () => {
  const { room } = createFixedContractRoom();

  submitQuote(room, room.makerId, { bid: 35, ask: 65, size: 1 });
  takeAction(room, room.takerId, { action: "pass" });
  submitQuote(room, room.makerId, { bid: 49, ask: 51, size: 1 });
  takeAction(room, room.takerId, { action: "buy" });
  submitQuote(room, room.makerId, { bid: 35, ask: 65, size: 1 });
  takeAction(room, room.takerId, { action: "pass" });

  assert.equal(Number(room.game.maker.cash.toFixed(2)), 50.79);
  assert.match(room.game.log[0].text, /Maker wide-spread penalty 0.12/i);
});

test("balanced hidden-value bot metadata defaults and maker quotes stay bounded", async () => {
  const room = createBotRoomState("BOTV", "Human", "market_taker", "rl");
  prepareNextGame(room, fixedContract(), { autoStart: true });
  room.bot.privateEstimate = 95;

  const decision = await botDecision(room, room.bot.playerId, {});

  assert.equal(room.bot.profile, "balanced");
  assert.equal(room.players.find((player) => player.id === room.bot.playerId)?.botDisplayName, "Balanced Bot");
  assert.equal(decision.type, "submit_quote");
  assert.ok(decision.payload.ask - decision.payload.bid <= 7);
  assert.ok(decision.payload.size <= 2);
});

test("inactivity helpers identify and clear stale players", () => {
  const now = 1_000_000;
  const room = createRoomState("TEST2", "Alpha");
  room.players[0].lastActiveAt = now - 301_000;
  const second = addPlayerToRoom(room, "Bravo");
  second.lastActiveAt = now - 120_000;

  assert.deepEqual(inactivePlayerIds(room, now, 300_000), [room.players[0].id]);
  assert.equal(nextInactivityDeadline(room, 300_000), room.players[0].lastActiveAt + 300_000);

  markPlayerActive(room, room.players[0].id, now);

  assert.deepEqual(inactivePlayerIds(room, now, 300_000), []);
  assert.equal(nextInactivityDeadline(room, 300_000), second.lastActiveAt + 300_000);
});

test("markPlayerActive is throttled to avoid excessive room churn", () => {
  const room = createRoomState("TEST3", "Alpha");
  const playerId = room.players[0].id;
  room.players[0].lastActiveAt = 1_000;

  assert.equal(markPlayerActive(room, playerId, 10_000), false);
  assert.equal(room.players[0].lastActiveAt, 1_000);

  assert.equal(markPlayerActive(room, playerId, 40_000), true);
  assert.equal(room.players[0].lastActiveAt, 40_000);
});

test("hidden-value room view exposes host status for the current viewer", () => {
  const { room, second } = createTwoPlayerRoom();

  const hostView = buildPlayerView(room, room.hostId, new Set());
  const secondView = buildPlayerView(room, second.id, new Set());

  assert.equal(hostView.isHost, true);
  assert.equal(secondView.isHost, false);
});

test("live hidden-value room view does not leak authored answer metadata", () => {
  const { room } = createFixedContractRoom();

  const view = buildPlayerView(room, room.makerId, new Set());

  assert.equal(view.game.settlement, null);
  assert.equal(view.game.settlementDetails, null);
  assert.deepEqual(Object.keys(view.game.contract).sort(), ["maxTurns", "prompt", "rangeHigh", "rangeLow", "unitLabel"]);
});

test("finished hidden-value room view reveals settlement rationale and source", () => {
  const { room } = createFixedContractRoom();
  finishGame(room);

  const view = buildPlayerView(room, room.makerId, new Set());

  assert.equal(view.game.settlement, 50);
  assert.deepEqual(view.game.settlementDetails, {
    value: 50,
    answerRationale: "Test source: benchmark sits near 50 points and this round settles at 50 points.",
    sourceLabel: "Test source",
    sourceUrl: "https://example.com/test-source",
  });
});
