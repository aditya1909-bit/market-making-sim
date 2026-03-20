import { DurableObject } from "cloudflare:workers";
import { botDecision, observeBotQuote, observeBotResolution, refreshBotEstimate } from "./bot-policy.js";
import { buildCardPlayerView, maybeStartCardGame, prepareNextCardGame, startCardGame, submitCardQuote, takeCardAction } from "./card-engine.js";
import { sampleContract } from "./contracts.js";
import {
  addPlayerToRoom,
  assignRoles,
  buildPlayerView,
  clearReady,
  createBotRoomState,
  createMatchedRoomState,
  createRoomState,
  hasAllRematchVotes,
  maybeStartGame,
  playerFor,
  prepareNextGame,
  requestRematch,
  resetRematchVotes,
  setReady,
  startGame,
  submitQuote,
  takeAction,
} from "./game-engine.js";
import { CLIENT_EVENTS, GAME_ACTOR, SERVER_EVENTS } from "./protocol.js";

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

function isCardGame(room) {
  return room?.gameType === "card_market";
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

      if (request.method === "GET" && url.pathname === "/internal/state") {
        return this.getPlayerState(url);
      }

      if (request.method === "POST" && url.pathname === "/internal/create") {
        return this.createPrivateRoom(request);
      }

      if (request.method === "POST" && url.pathname === "/internal/create-bot") {
        return this.createBotRoom(request);
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

  getPlayerState(url) {
    if (!this.room) {
      return json({ error: "Room code not found." }, 404);
    }
    const playerId = url.searchParams.get("playerId");
    if (!playerId || !playerFor(this.room, playerId)) {
      return json({ error: "Unknown player." }, 404);
    }
    return json(this.serializeJoin(playerId), 200);
  }

  async createPrivateRoom(request) {
    if (this.room) {
      return json({ error: "Room already exists." }, 409);
    }

    const body = await readJson(request);
    const name = validateName(body.name);
    const code = String(body.code || "").trim().toUpperCase();
    const gameType = body.gameType === "card_market" ? "card_market" : "hidden_value";
    if (!code) {
      throw new Error("Room code is required.");
    }

    this.room = createRoomState(code, name, {
      gameType,
      maxPlayers: gameType === "card_market" ? 10 : 2,
    });
    if (gameType === "card_market") {
      prepareNextCardGame(this.room, { incrementGameNumber: true });
    } else {
      prepareNextGame(this.room, sampleContract());
    }
    await this.persist();

    return json(this.serializeJoin(this.room.players[0].id), 201);
  }

  async createBotRoom(request) {
    if (this.room) {
      return json({ error: "Room already exists." }, 409);
    }

    const body = await readJson(request);
    const name = validateName(body.name);
    const code = String(body.code || "").trim().toUpperCase();
    const humanRole = body.humanRole;
    if (!code) {
      throw new Error("Room code is required.");
    }

    this.room = createBotRoomState(code, name, humanRole, "rl");
    prepareNextGame(this.room, sampleContract(), { autoStart: true });
    refreshBotEstimate(this.room);
    await this.advanceBotUntilHumanTurn();
    await this.persist();

    const human = this.room.players.find((player) => !player.isBot);
    return json(this.serializeJoin(human.id), 201);
  }

  async joinPrivateRoom(request) {
    if (!this.room) {
      return json({ error: "Room code not found." }, 404);
    }

    const body = await readJson(request);
    const player = addPlayerToRoom(this.room, validateName(body.name));
    if (!isCardGame(this.room) && this.room.players.length === 2 && (!this.room.makerId || !this.room.takerId)) {
      assignRoles(this.room);
    }
    if (isCardGame(this.room) && this.room.status === "lobby") {
      prepareNextCardGame(this.room);
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
    prepareNextGame(this.room, sampleContract());
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
    if (!playerFor(this.room, playerId)) {
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
          if (!isCardGame(this.room) && this.room.players.length === 2 && (!this.room.makerId || !this.room.takerId)) {
            assignRoles(this.room);
          }
          if (isCardGame(this.room)) {
            maybeStartCardGame(this.room);
          } else {
            maybeStartGame(this.room);
          }
          if (!isCardGame(this.room) && this.room.bot?.enabled && this.room.status === "live" && this.room.bot.privateEstimate === null) {
            refreshBotEstimate(this.room);
          }
          await this.advanceBotUntilHumanTurn();
          await this.persist();
          this.broadcastRoom();
          return;
        case CLIENT_EVENTS.START_GAME:
          if (isCardGame(this.room)) {
            startCardGame(this.room);
          } else {
            startGame(this.room);
          }
          if (!isCardGame(this.room) && this.room.bot?.enabled) {
            refreshBotEstimate(this.room);
          }
          await this.advanceBotUntilHumanTurn();
          await this.persist();
          this.broadcastRoom();
          return;
        case CLIENT_EVENTS.SUBMIT_QUOTE:
          if (isCardGame(this.room)) {
            submitCardQuote(this.room, playerId, parsed.payload || {});
          } else {
            submitQuote(this.room, playerId, parsed.payload || {});
          }
          if (!isCardGame(this.room) && this.room.bot?.enabled && this.room.takerId === this.room.bot.playerId) {
            observeBotQuote(this.room, this.room.bot.playerId);
          }
          await this.advanceBotUntilHumanTurn();
          await this.persist();
          this.broadcastRoom();
          return;
        case CLIENT_EVENTS.TAKER_ACTION:
          if (isCardGame(this.room)) {
            takeCardAction(this.room, playerId, parsed.payload || {});
          } else {
            takeAction(this.room, playerId, parsed.payload || {});
          }
          if (!isCardGame(this.room) && this.room.bot?.enabled && this.room.makerId === this.room.bot.playerId) {
            observeBotResolution(this.room, this.room.bot.playerId);
          }
          await this.advanceBotUntilHumanTurn();
          await this.persist();
          this.broadcastRoom();
          return;
        case CLIENT_EVENTS.REQUEST_REMATCH: {
          requestRematch(this.room, playerId);
          if (this.room.bot?.enabled) {
            this.room.rematchVotes[this.room.bot.playerId] = true;
          }
          const readyToRestart = hasAllRematchVotes(this.room);
          if (readyToRestart) {
            if (isCardGame(this.room)) {
              resetRematchVotes(this.room);
              clearReady(this.room);
              prepareNextCardGame(this.room, { incrementGameNumber: true });
            } else {
              prepareNextGame(this.room, sampleContract(), { swap: true, autoStart: true });
            }
            if (!isCardGame(this.room) && this.room.bot?.enabled) {
              refreshBotEstimate(this.room);
              await this.advanceBotUntilHumanTurn();
            }
          }
          await this.persist();
          this.broadcastRoom();
          return;
        }
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

  async advanceBotUntilHumanTurn() {
    if (isCardGame(this.room) || !this.room?.bot?.enabled) {
      return;
    }

    for (let step = 0; step < 12; step += 1) {
      if (this.room.status !== "live") {
        return;
      }

      const botPlayerId = this.room.bot.playerId;
      const botIsMakerTurn = this.room.game.activeActor === GAME_ACTOR.MAKER && this.room.makerId === botPlayerId;
      const botIsTakerTurn = this.room.game.activeActor === GAME_ACTOR.TAKER && this.room.takerId === botPlayerId;

      if (!botIsMakerTurn && !botIsTakerTurn) {
        return;
      }

      if (this.room.bot.privateEstimate === null) {
        refreshBotEstimate(this.room);
      }

      const decision = botDecision(this.room, botPlayerId);
      if (decision.type === "submit_quote") {
        submitQuote(this.room, botPlayerId, decision.payload);
      } else {
        takeAction(this.room, botPlayerId, decision.payload);
      }
    }
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
      view: isCardGame(this.room)
        ? buildCardPlayerView(this.room, playerId, this.connectedIds())
        : buildPlayerView(this.room, playerId, this.connectedIds()),
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
        payload: isCardGame(this.room)
          ? buildCardPlayerView(this.room, playerId, connectedIds)
          : buildPlayerView(this.room, playerId, connectedIds),
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
