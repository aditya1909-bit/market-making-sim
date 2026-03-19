import { DurableObject } from "cloudflare:workers";
import { sampleContract } from "./contracts.js";
import {
  addPlayerToRoom,
  assignRoles,
  buildPlayerView,
  createMatchedRoomState,
  createRoomState,
  maybeStartGame,
  seedContract,
  setReady,
  submitQuote,
  takeAction,
} from "./game-engine.js";
import { CLIENT_EVENTS, SERVER_EVENTS } from "./protocol.js";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function validateName(name) {
  const value = String(name || "").trim().slice(0, 32);
  if (!value) {
    throw new Error("Player name is required.");
  }
  return value;
}

function toText(message) {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return new TextDecoder().decode(message);
  }
  if (ArrayBuffer.isView(message)) {
    return new TextDecoder().decode(message);
  }
  return String(message || "");
}

export class RoomDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.room = (await this.ctx.storage.get("room")) || null;
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleSocket(request, url);
    }

    try {
      if (request.method === "GET" && url.pathname === "/internal/exists") {
        return json({ exists: Boolean(this.room) });
      }

      if (request.method === "POST" && url.pathname === "/internal/create") {
        return this.createPrivateRoom(request);
      }

      if (request.method === "POST" && url.pathname === "/internal/join") {
        return this.joinPrivateRoom(request);
      }

      if (request.method === "POST" && url.pathname === "/internal/seed-match") {
        return this.seedMatchedRoom(request);
      }

      return json({ error: "Not found." }, 404);
    } catch (error) {
      return json({ error: error.message || "Room request failed." }, 400);
    }
  }

  async createPrivateRoom(request) {
    if (this.room) {
      return json({ error: "Room already exists." }, 409);
    }

    const body = await readJson(request);
    const name = validateName(body.name);
    const code = String(body.code || "").trim().toUpperCase();
    if (!code) {
      throw new Error("Room code is required.");
    }

    this.room = createRoomState(code, name);
    seedContract(this.room, sampleContract());
    await this.persist();

    return json(this.serializeJoin(this.room.players[0].id), 201);
  }

  async joinPrivateRoom(request) {
    if (!this.room) {
      return json({ error: "Room code not found." }, 404);
    }

    const body = await readJson(request);
    const player = addPlayerToRoom(this.room, validateName(body.name));
    if (this.room.players.length === 2 && (!this.room.makerId || !this.room.takerId)) {
      assignRoles(this.room);
    }
    await this.persist();

    return json(this.serializeJoin(player.id), 200);
  }

  async seedMatchedRoom(request) {
    if (this.room) {
      return json({ error: "Room already exists." }, 409);
    }

    const body = await readJson(request);
    const names = Array.isArray(body.names) ? body.names : [];
    if (names.length !== 2) {
      throw new Error("Matched room needs exactly two player names.");
    }
    const code = String(body.code || "").trim().toUpperCase();
    if (!code) {
      throw new Error("Room code is required.");
    }

    this.room = createMatchedRoomState(code, validateName(names[0]), validateName(names[1]));
    seedContract(this.room, sampleContract());
    await this.persist();

    return json(
      {
        roomId: this.room.id,
        roomCode: this.room.code,
        players: this.room.players.map((player) => ({
          playerId: player.id,
          view: buildPlayerView(this.room, player.id, this.connectedIds()),
        })),
      },
      201
    );
  }

  async handleSocket(request, url) {
    if (!this.room) {
      return new Response("Room not found.", { status: 404 });
    }

    const playerId = url.searchParams.get("playerId");
    const roomCode = String(url.searchParams.get("roomCode") || "").toUpperCase();
    if (!playerId) {
      return new Response("Missing playerId.", { status: 400 });
    }
    if (roomCode !== this.room.code) {
      return new Response("Room code mismatch.", { status: 400 });
    }
    if (!this.room.players.some((player) => player.id === playerId)) {
      return new Response("Unknown player.", { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.playerId === playerId) {
        try {
          socket.close(1000, "Replaced by new connection");
        } catch {
          // ignore stale socket close failures
        }
      }
    }

    server.serializeAttachment({ playerId });
    this.ctx.acceptWebSocket(server);
    this.broadcastRoom();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    const attachment = ws.deserializeAttachment();
    const playerId = attachment?.playerId;
    if (!playerId || !this.room) {
      this.send(ws, { type: SERVER_EVENTS.ERROR, error: "Unknown player." });
      return;
    }

    try {
      const parsed = JSON.parse(toText(message));
      switch (parsed.type) {
        case CLIENT_EVENTS.READY:
          setReady(this.room, playerId, parsed.payload?.ready ?? parsed.ready);
          if (this.room.players.length === 2 && (!this.room.makerId || !this.room.takerId)) {
            assignRoles(this.room);
          }
          maybeStartGame(this.room);
          await this.persist();
          this.broadcastRoom();
          return;
        case CLIENT_EVENTS.START_GAME:
          maybeStartGame(this.room);
          await this.persist();
          this.broadcastRoom();
          return;
        case CLIENT_EVENTS.SUBMIT_QUOTE:
          submitQuote(this.room, playerId, parsed.payload || {});
          await this.persist();
          this.broadcastRoom();
          return;
        case CLIENT_EVENTS.TAKER_ACTION:
          takeAction(this.room, playerId, parsed.payload || {});
          await this.persist();
          this.broadcastRoom();
          return;
        case CLIENT_EVENTS.LEAVE_ROOM:
          setReady(this.room, playerId, false);
          await this.persist();
          this.broadcastRoom();
          return;
        case CLIENT_EVENTS.PING:
          this.send(ws, { type: SERVER_EVENTS.PONG, at: Date.now() });
          return;
        default:
          throw new Error(`Unknown client event: ${parsed.type}`);
      }
    } catch (error) {
      this.send(ws, { type: SERVER_EVENTS.ERROR, error: error.message || "Message failed." });
    }
  }

  async webSocketClose() {
    if (!this.room) {
      return;
    }
    this.broadcastRoom();
  }

  async webSocketError() {
    if (!this.room) {
      return;
    }
    this.broadcastRoom();
  }

  connectedIds() {
    return new Set(
      this.ctx
        .getWebSockets()
        .map((socket) => socket.deserializeAttachment()?.playerId)
        .filter(Boolean)
    );
  }

  serializeJoin(playerId) {
    return {
      roomId: this.room.id,
      roomCode: this.room.code,
      playerId,
      status: this.room.status,
      view: buildPlayerView(this.room, playerId, this.connectedIds()),
    };
  }

  broadcastRoom() {
    if (!this.room) {
      return;
    }
    const connectedIds = this.connectedIds();
    for (const socket of this.ctx.getWebSockets()) {
      const playerId = socket.deserializeAttachment()?.playerId;
      if (!playerId) {
        continue;
      }
      this.send(socket, {
        type: SERVER_EVENTS.ROOM_STATE,
        payload: buildPlayerView(this.room, playerId, connectedIds),
      });
    }
  }

  async persist() {
    await this.ctx.storage.put("room", this.room);
  }

  send(socket, payload) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // no-op
    }
  }
}
