import test from "node:test";
import assert from "node:assert/strict";

import { cancelTicketState, reconcileClientTickets, serializeTicket } from "../src/matchmaker-state.js";

test("retrying matchmaking after a same-game matched ticket returns the existing assignment", () => {
  const matchedTicket = {
    id: "ticket-1",
    status: "matched",
    clientId: "client-1",
    gameType: "card_market",
    roomId: "room-1",
    roomCode: "ABC123",
    playerId: "player-1",
    createdAt: 10,
  };
  const result = reconcileClientTickets({ [matchedTicket.id]: matchedTicket }, [], "client-1", "card_market");

  assert.equal(result.changed, false);
  assert.equal(result.ticket, matchedTicket);
  assert.deepEqual(serializeTicket(result.ticket), {
    ticketId: "ticket-1",
    status: "matched",
    gameType: "card_market",
    roomId: "room-1",
    roomCode: "ABC123",
    playerId: "player-1",
  });
});

test("matched tickets from a different game type are not reused", () => {
  const matchedTicket = {
    id: "ticket-1",
    status: "matched",
    clientId: "client-1",
    gameType: "hidden_value",
    roomId: "room-1",
    roomCode: "ABC123",
    playerId: "player-1",
    createdAt: 10,
  };
  const result = reconcileClientTickets({ [matchedTicket.id]: matchedTicket }, [], "client-1", "card_market");

  assert.equal(result.changed, false);
  assert.equal(result.ticket, null);
});

test("requesting a different game type replaces an older queued ticket", () => {
  const queuedTicket = {
    id: "ticket-1",
    status: "queued",
    clientId: "client-1",
    gameType: "hidden_value",
    createdAt: 10,
  };
  const result = reconcileClientTickets({ [queuedTicket.id]: queuedTicket }, [queuedTicket.id], "client-1", "card_market");

  assert.equal(result.changed, true);
  assert.equal(result.ticket, null);
  assert.deepEqual(result.queue, []);
  assert.equal(queuedTicket.status, "cancelled");
});

test("cancelling a queued ticket marks it cancelled and removes it from the queue", () => {
  const queuedTicket = {
    id: "ticket-1",
    status: "queued",
    clientId: "client-1",
    gameType: "hidden_value",
  };
  const result = cancelTicketState({ [queuedTicket.id]: queuedTicket }, [queuedTicket.id], queuedTicket.id);

  assert.equal(result.found, true);
  assert.equal(result.ticket, queuedTicket);
  assert.equal(result.ticket.status, "cancelled");
  assert.deepEqual(result.queue, []);
});

test("cancelling a matched ticket preserves the matched assignment", () => {
  const matchedTicket = {
    id: "ticket-1",
    status: "matched",
    clientId: "client-1",
    gameType: "card_market",
    roomId: "room-1",
    roomCode: "TABLE1",
    playerId: "player-1",
  };
  const result = cancelTicketState({ [matchedTicket.id]: matchedTicket }, [], matchedTicket.id);

  assert.equal(result.found, true);
  assert.equal(result.ticket, matchedTicket);
  assert.equal(result.ticket.status, "matched");
  assert.deepEqual(result.queue, []);
});
