import test from "node:test";
import assert from "node:assert/strict";

import { sampleContract } from "../src/contracts.js";
import {
  addPlayerToRoom,
  createRoomState,
  finishGame,
  handleHiddenPlayerDeparture,
  prepareNextGame,
  requestRematch,
  startGame,
} from "../src/game-engine.js";

function createTwoPlayerRoom() {
  const room = createRoomState("TEST1", "Alpha");
  prepareNextGame(room, sampleContract());
  const second = addPlayerToRoom(room, "Bravo");
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
