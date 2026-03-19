import crypto from "node:crypto";
import { sampleContract } from "./contracts.js";
import { assignRoles, buildPlayerView, createGameState, maybeStartGame, submitQuote, takeAction } from "./game-engine.js";
import { CLIENT_EVENTS, ROOM_STATUS, SERVER_EVENTS } from "../shared/protocol.js";

function randomCode(length = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  while (out.length < length) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.players = new Map();
    this.queue = [];
    this.tickets = new Map();
  }

  createRoom(name) {
    const room = this.#makeRoom();
    const player = this.#makePlayer(name);
    room.players.set(player.id, player);
    room.hostId = player.id;
    this.rooms.set(room.id, room);
    this.players.set(player.id, { roomId: room.id });
    return { room, player };
  }

  joinRoomByCode(code, name) {
    const room = [...this.rooms.values()].find((entry) => entry.code === code.toUpperCase());
    if (!room) {
      throw new Error("Room code not found.");
    }
    if (room.players.size >= 2) {
      throw new Error("Room is already full.");
    }
    const player = this.#makePlayer(name);
    room.players.set(player.id, player);
    this.players.set(player.id, { roomId: room.id });
    if (room.players.size === 2 && (!room.makerId || !room.takerId)) {
      assignRoles(room);
    }
    return { room, player };
  }

  enqueueRandom(name) {
    const ticketId = crypto.randomUUID();
    const waiting = this.queue.shift();

    if (!waiting) {
      this.tickets.set(ticketId, { id: ticketId, status: "queued", name });
      this.queue.push(ticketId);
      return { ticketId, status: "queued" };
    }

    const waitingTicket = this.tickets.get(waiting);
    if (!waitingTicket) {
      this.tickets.set(ticketId, { id: ticketId, status: "queued", name });
      this.queue.push(ticketId);
      return { ticketId, status: "queued" };
    }

    const room = this.#makeRoom();
    const playerA = this.#makePlayer(waitingTicket.name);
    const playerB = this.#makePlayer(name);
    room.players.set(playerA.id, playerA);
    room.players.set(playerB.id, playerB);
    assignRoles(room);

    this.rooms.set(room.id, room);
    this.players.set(playerA.id, { roomId: room.id });
    this.players.set(playerB.id, { roomId: room.id });

    waitingTicket.status = "matched";
    waitingTicket.roomId = room.id;
    waitingTicket.playerId = playerA.id;
    waitingTicket.roomCode = room.code;

    this.tickets.set(ticketId, {
      id: ticketId,
      status: "matched",
      roomId: room.id,
      playerId: playerB.id,
      roomCode: room.code,
      name,
    });

    return {
      ticketId,
      status: "matched",
      roomId: room.id,
      playerId: playerB.id,
      roomCode: room.code,
    };
  }

  getMatchmakingTicket(ticketId) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error("Matchmaking ticket not found.");
    }
    return clone(ticket);
  }

  cancelMatchmakingTicket(ticketId) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error("Matchmaking ticket not found.");
    }
    if (ticket.status === "matched") {
      return clone(ticket);
    }
    this.queue = this.queue.filter((id) => id !== ticketId);
    ticket.status = "cancelled";
    return clone(ticket);
  }

  connectSocket(playerId, socket) {
    const room = this.getRoomForPlayer(playerId);
    const player = room.players.get(playerId);
    if (!player) {
      throw new Error("Player not found in room.");
    }
    player.connected = true;
    player.socket = socket;
    this.broadcastRoom(room.id);
  }

  disconnectSocket(playerId) {
    const room = this.getRoomForPlayer(playerId);
    const player = room.players.get(playerId);
    if (!player) {
      return;
    }
    player.connected = false;
    player.socket = null;
    this.broadcastRoom(room.id);
  }

  handleClientEvent(playerId, message) {
    const room = this.getRoomForPlayer(playerId);
    const player = room.players.get(playerId);
    if (!player) {
      throw new Error("Unknown player.");
    }

    switch (message.type) {
      case CLIENT_EVENTS.READY:
        player.ready = Boolean(message.payload?.ready ?? message.ready);
        if (room.players.size === 2 && (!room.makerId || !room.takerId)) {
          assignRoles(room);
        }
        maybeStartGame(room);
        this.broadcastRoom(room.id);
        return;
      case CLIENT_EVENTS.START_GAME:
        maybeStartGame(room);
        this.broadcastRoom(room.id);
        return;
      case CLIENT_EVENTS.SUBMIT_QUOTE:
        submitQuote(room, playerId, message.payload || {});
        this.broadcastRoom(room.id);
        return;
      case CLIENT_EVENTS.TAKER_ACTION:
        takeAction(room, playerId, message.payload || {});
        this.broadcastRoom(room.id);
        return;
      case CLIENT_EVENTS.LEAVE_ROOM:
        player.ready = false;
        this.broadcastRoom(room.id);
        return;
      case CLIENT_EVENTS.PING:
        this.#send(player.socket, { type: SERVER_EVENTS.PONG, at: Date.now() });
        return;
      default:
        throw new Error(`Unknown client event: ${message.type}`);
    }
  }

  broadcastRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    for (const player of room.players.values()) {
      if (!player.socket) {
        continue;
      }
      this.#send(player.socket, {
        type: SERVER_EVENTS.ROOM_STATE,
        payload: buildPlayerView(room, player.id),
      });
    }
  }

  getRoomForPlayer(playerId) {
    const ref = this.players.get(playerId);
    if (!ref) {
      throw new Error("Unknown player.");
    }
    const room = this.rooms.get(ref.roomId);
    if (!room) {
      throw new Error("Room not found.");
    }
    return room;
  }

  serializeRoomJoin(room, player) {
    return {
      roomId: room.id,
      roomCode: room.code,
      playerId: player.id,
      status: room.status,
      view: buildPlayerView(room, player.id),
    };
  }

  #makeRoom() {
    const contract = sampleContract();
    const id = crypto.randomUUID();
    return {
      id,
      code: randomCode(),
      hostId: null,
      players: new Map(),
      makerId: null,
      takerId: null,
      status: ROOM_STATUS.LOBBY,
      game: createGameState(contract),
    };
  }

  #makePlayer(name) {
    return {
      id: crypto.randomUUID(),
      name: name?.trim() || "Anonymous",
      ready: false,
      connected: false,
      socket: null,
    };
  }

  #send(socket, payload) {
    if (!socket || socket.readyState !== 1) {
      return;
    }
    socket.send(JSON.stringify(payload));
  }
}
