import test from "node:test";
import assert from "node:assert/strict";

import { addPlayerToRoom, createRoomState, removePlayerFromRoom } from "../src/game-engine.js";
import { addCardBotsToRoom } from "../src/card-bot-manager.js";
import {
  buildCardPlayerView,
  cancelCardRound,
  finishCardGame,
  maybeStartCardGame,
  prepareNextCardGame,
  refreshCardLobbyCountdown,
  refreshCardLobbyState,
  requestCardRevealVote,
  submitCardQuote,
  takeCardAction,
} from "../src/card-engine.js";

function createCardRoom() {
  const room = createRoomState("CARD1", "Alpha", {
    gameType: "card_market",
    maxPlayers: 10,
    roomVisibility: "public_table",
  });
  const bravo = addPlayerToRoom(room, "Bravo");
  prepareNextCardGame(room, { incrementGameNumber: true });
  return { room, alpha: room.players[0], bravo };
}

function startLiveCardRoom(now = 1_000) {
  const { room, alpha, bravo } = createCardRoom();
  alpha.ready = true;
  bravo.ready = true;
  const connectedIds = new Set([alpha.id, bravo.id]);
  refreshCardLobbyCountdown(room, connectedIds, now);
  maybeStartCardGame(room, connectedIds, room.game.countdownEndsAt);
  return { room, alpha, bravo, connectedIds };
}

test("card market keeps the same preview target when the countdown starts the round", () => {
  const now = 5_000;
  const { room, alpha, bravo } = createCardRoom();
  alpha.ready = true;
  bravo.ready = true;
  const connectedIds = new Set([alpha.id, bravo.id]);

  refreshCardLobbyCountdown(room, connectedIds, now);
  const previewTargetId = room.game.targetScorerId;
  const previewPrompt = room.game.prompt;
  const countdownEndsAt = room.game.countdownEndsAt;

  assert.ok(countdownEndsAt);

  maybeStartCardGame(room, connectedIds, countdownEndsAt);

  assert.equal(room.status, "live");
  assert.equal(room.game.targetScorerId, previewTargetId);
  assert.equal(room.game.prompt, previewPrompt);
  assert.deepEqual([...room.game.activeSeatIds].sort(), [alpha.id, bravo.id].sort());
});

test("joining during a live card round waits for the next deal and cannot act", () => {
  const { room, connectedIds } = startLiveCardRoom();
  const lateJoiner = addPlayerToRoom(room, "Charlie");
  connectedIds.add(lateJoiner.id);

  const view = buildCardPlayerView(room, lateJoiner.id, connectedIds, 10_000);

  assert.equal(room.status, "live");
  assert.equal(view.cardSeatStatus, "waiting_next_round");
  assert.deepEqual(view.game.privateHand, []);
  assert.equal(view.cardCapabilities.canQuote, false);
  assert.equal(view.cardCapabilities.canTrade, false);
  assert.equal(view.table.waitingCount, 1);
});

test("losing an active card seat cancels the round and returns the table to lobby", () => {
  const { room, bravo } = startLiveCardRoom();

  removePlayerFromRoom(room, bravo.id);
  cancelCardRound(room, "Bravo left the room. The round was cancelled.", 20_000);

  assert.equal(room.players.length, 1);
  assert.equal(room.status, "lobby");
  assert.deepEqual(room.game.activeSeatIds, []);
  assert.equal(room.game.previousSummary?.kind, "cancelled");
  assert.match(room.game.previousSummary?.text || "", /cancelled/i);
});

test("a waiting-next-round player can leave without cancelling the live card round", () => {
  const { room, alpha, bravo } = startLiveCardRoom();
  const lateJoiner = addPlayerToRoom(room, "Charlie");

  removePlayerFromRoom(room, lateJoiner.id);

  assert.equal(room.status, "live");
  assert.deepEqual([...room.game.activeSeatIds].sort(), [alpha.id, bravo.id].sort());
  assert.equal(room.players.length, 2);
});

test("card lobby countdown clears if readiness falls below the minimum", () => {
  const now = 12_000;
  const { room, alpha, bravo } = createCardRoom();
  const connectedIds = new Set([alpha.id, bravo.id]);
  alpha.ready = true;
  bravo.ready = true;

  refreshCardLobbyCountdown(room, connectedIds, now);
  assert.ok(room.game.countdownEndsAt);

  bravo.ready = false;
  refreshCardLobbyCountdown(room, connectedIds, now + 500);

  assert.equal(room.game.countdownEndsAt, null);
  assert.deepEqual(room.game.countdownSeatIds, []);
});

test("joining a card lobby preserves ready players and the existing countdown seats", () => {
  const now = 15_000;
  const { room, alpha, bravo } = createCardRoom();
  alpha.ready = true;
  bravo.ready = true;
  const connectedIds = new Set([alpha.id, bravo.id]);

  refreshCardLobbyState(room, connectedIds, now);
  const countdownSeatIds = [...room.game.countdownSeatIds];
  const countdownEndsAt = room.game.countdownEndsAt;

  const charlie = addPlayerToRoom(room, "Charlie");
  connectedIds.add(charlie.id);
  refreshCardLobbyState(room, connectedIds, now + 250);

  assert.equal(alpha.ready, true);
  assert.equal(bravo.ready, true);
  assert.equal(charlie.ready, false);
  assert.deepEqual(room.game.countdownSeatIds, countdownSeatIds);
  assert.equal(room.game.countdownEndsAt, countdownEndsAt);
});

test("only active seats can quote or vote to reveal in card market", () => {
  const { room, alpha } = startLiveCardRoom();
  const lateJoiner = addPlayerToRoom(room, "Charlie");

  submitCardQuote(room, alpha.id, { bid: 2, ask: 4, size: 1 });
  assert.throws(() => requestCardRevealVote(room, lateJoiner.id, 15_000), /waiting for the next round/i);
});

test("reposting the same card quote does not spam the tape", () => {
  const { room, alpha } = startLiveCardRoom();

  submitCardQuote(room, alpha.id, { bid: 2, ask: 4, size: 1 });
  submitCardQuote(room, alpha.id, { bid: 2, ask: 4, size: 1 });
  submitCardQuote(room, alpha.id, { bid: 2.1, ask: 4.1, size: 1 });

  const quoteEntries = room.game.log.filter((entry) => entry.type === "quote");
  assert.equal(quoteEntries.length, 1);
  assert.match(quoteEntries[0].text, /quoted 2 \/ 4 for 1/i);
});

test("card quotes reject non-integer size", () => {
  const { room, alpha } = startLiveCardRoom();

  assert.throws(
    () => submitCardQuote(room, alpha.id, { bid: 2, ask: 4, size: 1.5 }),
    /whole number between 1 and 5/i
  );
});

test("card quotes reject size above the server max", () => {
  const { room, alpha } = startLiveCardRoom();

  assert.throws(
    () => submitCardQuote(room, alpha.id, { bid: 2, ask: 4, size: 6 }),
    /whole number between 1 and 5/i
  );
});

test("finished card rounds preserve ranking and trade tape in the next lobby view", () => {
  const { room, alpha, bravo, connectedIds } = startLiveCardRoom();
  const settledTargetId = room.game.targetScorerId;
  const settledPrompt = room.game.prompt;
  const settledLabel = room.game.target?.label;
  const settledRangeLow = room.game.rangeLow;
  const settledRangeHigh = room.game.rangeHigh;

  submitCardQuote(room, alpha.id, { bid: 1, ask: 2, size: 1 });
  takeCardAction(room, bravo.id, { targetPlayerId: alpha.id, action: "buy" });
  finishCardGame(room, 30_000);

  const view = buildCardPlayerView(room, alpha.id, connectedIds, 30_100);

  assert.equal(view.status, "lobby");
  assert.equal(view.game.previousSummary?.kind, "finished");
  assert.equal(view.game.previousSummary?.target?.id, settledTargetId);
  assert.equal(view.game.previousSummary?.target?.label, settledLabel);
  assert.equal(view.game.previousSummary?.contract?.prompt, settledPrompt);
  assert.equal(view.game.previousSummary?.contract?.rangeLow, settledRangeLow);
  assert.equal(view.game.previousSummary?.contract?.rangeHigh, settledRangeHigh);
  assert.equal(typeof view.game.previousSummary?.settlement, "number");
  assert.ok((view.game.previousSummary?.ranking || []).length >= 2);
  assert.ok((view.game.previousSummary?.log || []).some((entry) => /buys 1 at 2/i.test(entry.text)));
  assert.equal(view.game.positions.length, 0);
});

test("card quotes fill one unit at a time and disappear only when fully taken", () => {
  const { room, alpha, bravo } = startLiveCardRoom();

  submitCardQuote(room, alpha.id, { bid: 1, ask: 2, size: 2 });
  takeCardAction(room, bravo.id, { targetPlayerId: alpha.id, action: "buy" });

  assert.equal(room.game.positions[bravo.id].inventory, 1);
  assert.equal(room.game.positions[alpha.id].inventory, -1);
  assert.equal(room.game.liveQuotes[alpha.id]?.size, 1);

  takeCardAction(room, bravo.id, { targetPlayerId: alpha.id, action: "buy" });

  assert.equal(room.game.positions[bravo.id].inventory, 2);
  assert.equal(room.game.positions[alpha.id].inventory, -2);
  assert.equal(room.game.liveQuotes[alpha.id], undefined);
  assert.throws(() => takeCardAction(room, bravo.id, { targetPlayerId: alpha.id, action: "buy" }), /no longer live/i);
});

test("bots cannot start the next card countdown without enough human opt-in", () => {
  const now = 20_000;
  const room = createRoomState("CARD2", "Alpha", {
    gameType: "card_market",
    maxPlayers: 10,
    roomVisibility: "private_room",
  });
  prepareNextCardGame(room, { incrementGameNumber: true });
  addCardBotsToRoom(room, 2, "policy-v1", now);

  room.players.forEach((player) => {
    if (player.isBot) {
      player.ready = true;
    }
  });

  const connectedIds = new Set([room.hostId]);
  refreshCardLobbyCountdown(room, connectedIds, now);

  assert.equal(room.game.countdownEndsAt, null);

  room.players[0].ready = true;
  refreshCardLobbyCountdown(room, connectedIds, now + 100);

  assert.ok(room.game.countdownEndsAt);
  assert.ok(room.game.countdownSeatIds.includes(room.hostId));
});
