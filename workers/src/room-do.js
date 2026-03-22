import { DurableObject } from "cloudflare:workers";
import { botDecision, observeBotQuote, observeBotResolution, refreshBotEstimate } from "./bot-policy.js";
import {
  addCardBotsToRoom,
  cardBotConnectedIds,
  ensureCardBotsReady,
  markCardBotForRemoval,
  pruneCardBotsPendingRemoval,
} from "./card-bot-manager.js";
import { advanceCardBots, nextCardBotWakeAt, reseedLiveCardBots, resolveCardPolicyVersion } from "./card-bot-runtime.js";
import {
  advanceCardGameClock,
  buildCardPlayerView,
  cancelCardRound,
  maybeStartCardGame,
  nextCardAlarmAt,
  prepareNextCardGame,
  refreshCardLobbyState,
  requestCardRevealVote,
  startCardGame,
  submitCardQuote,
  takeCardAction,
} from "./card-engine.js";
import { sampleContract } from "./contracts.js";
import {
  addPlayerToRoom,
  assignRoles,
  buildPlayerView,
  clearReady,
  createBotRoomState,
  createMatchedRoomState,
  createRoomState,
  handleHiddenPlayerDeparture,
  hasAllRematchVotes,
  inactivePlayerIds,
  markPlayerActive,
  maybeStartGame,
  nextInactivityDeadline,
  playerFor,
  prepareNextGame,
  requestRematch,
  removePlayerFromRoom,
  resetRematchVotes,
  setReady,
  startGame,
  submitQuote,
  takeAction,
} from "./game-engine.js";
import { CLIENT_EVENTS, GAME_ACTOR, SERVER_EVENTS } from "./protocol.js";

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const INACTIVITY_CLOSE_CODE = 4001;
const INACTIVITY_CLOSE_REASON = "Removed for inactivity";

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

      if (request.method === "GET" && url.pathname === "/internal/card-public-availability") {
        return this.getCardPublicAvailability();
      }

      if (request.method === "POST" && url.pathname === "/internal/card-bots") {
        return this.addCardBots(request);
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/internal/card-bots/")) {
        return this.removeCardBot(request, url.pathname.split("/")[3]);
      }

      return json({ error: "Not found." }, 404);
    } catch (error) {
      return json({ error: error.message || "Room request failed." }, 400);
    }
  }

  async getPlayerState(url) {
    if (!this.room) {
      return json({ error: "Room code not found." }, 404);
    }
    await this.syncCardGameState();
    const playerId = url.searchParams.get("playerId");
    if (!playerId || !playerFor(this.room, playerId)) {
      return json({ error: "Unknown player." }, 404);
    }
    return json(this.serializeJoin(playerId), 200);
  }

  async getCardPublicAvailability() {
    if (!this.room) {
      return json({ exists: false, joinable: false }, 404);
    }
    await this.syncCardGameState();
    const joinable =
      this.room.gameType === "card_market" &&
      this.room.roomVisibility === "public_table" &&
      this.room.status === "lobby" &&
      this.room.players.length < this.room.maxPlayers;
    return json(
      {
        exists: true,
        joinable,
        roomId: this.room.id,
        roomCode: this.room.code,
        status: this.room.status,
        roomVisibility: this.room.roomVisibility,
        playerCount: this.room.players.length,
        maxPlayers: this.room.maxPlayers,
      },
      200
    );
  }

  async createPrivateRoom(request) {
    if (this.room) {
      return json({ error: "Room already exists." }, 409);
    }

    const body = await readJson(request);
    const name = validateName(body.name);
    const code = String(body.code || "").trim().toUpperCase();
    const gameType = body.gameType === "card_market" ? "card_market" : "hidden_value";
    const roomVisibility = body.roomVisibility === "public_table" ? "public_table" : "private_room";
    if (!code) {
      throw new Error("Room code is required.");
    }

    this.room = createRoomState(code, name, {
      gameType,
      roomVisibility,
      maxPlayers: gameType === "card_market" ? 10 : 2,
    });
    if (gameType === "card_market") {
      prepareNextCardGame(this.room, { incrementGameNumber: true });
      ensureCardBotsReady(this.room);
    } else {
      prepareNextGame(this.room, sampleContract());
    }
    markPlayerActive(this.room, this.room.players[0].id);
    await this.scheduleRoomAlarm();
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
    const human = this.room.players.find((player) => !player.isBot);
    markPlayerActive(this.room, human.id);
    refreshBotEstimate(this.room);
    await this.advanceBotUntilHumanTurn();
    await this.scheduleRoomAlarm();
    await this.persist();

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
    if (!isCardGame(this.room) && this.room.players.length === 2 && !this.room.game.contract) {
      prepareNextGame(this.room, sampleContract());
    }
    if (isCardGame(this.room) && this.room.status === "lobby") {
      refreshCardLobbyState(this.room, this.connectedIds(), Date.now());
    }
    markPlayerActive(this.room, player.id);
    await this.scheduleRoomAlarm();
    await this.persist();

    return json(this.serializeJoin(player.id), 200);
  }

  async addCardBots(request) {
    if (!this.room) {
      return json({ error: "Room code not found." }, 404);
    }
    if (!isCardGame(this.room)) {
      throw new Error("Card bots are only available in card-market rooms.");
    }

    const body = await readJson(request);
    const requester = String(body.playerId || "");
    if (!requester || requester !== this.room.hostId) {
      throw new Error("Only the room host can add card bots.");
    }
    if (!playerFor(this.room, requester)) {
      throw new Error("Unknown host player.");
    }

    const policyVersion = await resolveCardPolicyVersion(this.env, body.policyVersion || null);
    const added = addCardBotsToRoom(this.room, body.count, policyVersion, Date.now());
    if (!added.length) {
      throw new Error("No seats available for additional card bots.");
    }

    ensureCardBotsReady(this.room);
    if (this.room.status === "live") {
      reseedLiveCardBots(
        this.room,
        Date.now(),
        added.map((player) => player.id)
      );
    } else {
      refreshCardLobbyState(this.room, this.connectedIds(), Date.now());
    }

    await this.persist();
    await this.scheduleRoomAlarm();
    this.broadcastRoom();
    return json({
      added: added.map((player) => ({
        id: player.id,
        name: player.name,
        botKind: player.botKind,
        botPolicyVersion: player.botPolicyVersion,
      })),
    });
  }

  async removeCardBot(request, botPlayerId) {
    if (!this.room) {
      return json({ error: "Room code not found." }, 404);
    }
    if (!isCardGame(this.room)) {
      throw new Error("Card bots are only available in card-market rooms.");
    }

    const body = await readJson(request);
    const requester = String(body.playerId || new URL(request.url).searchParams.get("playerId") || "");
    if (!requester || requester !== this.room.hostId) {
      throw new Error("Only the room host can remove card bots.");
    }

    const outcome = markCardBotForRemoval(this.room, botPlayerId);
    if (!outcome.deferred) {
      refreshCardLobbyState(this.room, this.connectedIds(), Date.now());
    }

    await this.persist();
    await this.scheduleRoomAlarm();
    this.broadcastRoom();
    return json(outcome);
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
    const gameType = body.gameType === "card_market" ? "card_market" : "hidden_value";
    const code = String(body.code || "").trim().toUpperCase();
    if (!code) {
      throw new Error("Room code is required.");
    }

    this.room = createMatchedRoomState(code, validateName(names[0]), validateName(names[1]), gameType);
    if (gameType === "card_market") {
      prepareNextCardGame(this.room, { incrementGameNumber: true });
    } else {
      prepareNextGame(this.room, sampleContract());
    }
    this.room.players.forEach((player) => {
      markPlayerActive(this.room, player.id);
    });
    await this.scheduleRoomAlarm();
    await this.persist();

    return json(
      {
        roomId: this.room.id,
        roomCode: this.room.code,
        players: this.room.players.map((player) => ({
          playerId: player.id,
          view: isCardGame(this.room)
            ? buildCardPlayerView(this.room, player.id, this.connectedIds())
            : buildPlayerView(this.room, player.id, this.connectedIds()),
        })),
      },
      201
    );
  }

  async handleSocket(request, url) {
    if (!this.room) {
      return new Response("Room not found.", { status: 404 });
    }

    await this.syncCardGameState();

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
    markPlayerActive(this.room, playerId);
    await this.persist();
    await this.scheduleRoomAlarm();
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

    let activityChanged = false;
    try {
      await this.syncCardGameState();
      activityChanged = markPlayerActive(this.room, playerId);
      const parsed = JSON.parse(toText(message));
      switch (parsed.type) {
        case CLIENT_EVENTS.READY:
          setReady(this.room, playerId, parsed.payload?.ready ?? parsed.ready);
          ensureCardBotsReady(this.room);
          if (!isCardGame(this.room) && this.room.players.length === 2 && (!this.room.makerId || !this.room.takerId)) {
            assignRoles(this.room);
          }
          if (isCardGame(this.room)) {
            maybeStartCardGame(this.room, this.connectedIds(), Date.now());
          } else {
            maybeStartGame(this.room);
          }
          if (!isCardGame(this.room) && this.room.bot?.enabled && this.room.status === "live" && this.room.bot.privateEstimate === null) {
            refreshBotEstimate(this.room);
          }
          await this.advanceBotUntilHumanTurn();
          await this.scheduleRoomAlarm();
          await this.persist();
          this.broadcastRoom();
          return;
        case CLIENT_EVENTS.START_GAME:
          if (isCardGame(this.room)) {
            startCardGame(this.room, this.room.game.countdownSeatIds, Date.now());
            reseedLiveCardBots(this.room, Date.now());
          } else {
            startGame(this.room);
          }
          if (!isCardGame(this.room) && this.room.bot?.enabled) {
            refreshBotEstimate(this.room);
          }
          await this.advanceBotUntilHumanTurn();
          await this.scheduleRoomAlarm();
          await this.persist();
          this.broadcastRoom();
          return;
        case CLIENT_EVENTS.SUBMIT_QUOTE:
          if (isCardGame(this.room)) {
            submitCardQuote(this.room, playerId, parsed.payload || {});
            reseedLiveCardBots(this.room, Date.now());
          } else {
            submitQuote(this.room, playerId, parsed.payload || {});
          }
          if (!isCardGame(this.room) && this.room.bot?.enabled && this.room.takerId === this.room.bot.playerId) {
            observeBotQuote(this.room, this.room.bot.playerId);
          }
          await this.advanceBotUntilHumanTurn();
          await this.scheduleRoomAlarm();
          await this.persist();
          this.broadcastRoom();
          return;
        case CLIENT_EVENTS.TAKER_ACTION:
          if (isCardGame(this.room)) {
            takeCardAction(this.room, playerId, parsed.payload || {});
            reseedLiveCardBots(this.room, Date.now());
          } else {
            takeAction(this.room, playerId, parsed.payload || {});
          }
          if (!isCardGame(this.room) && this.room.bot?.enabled && this.room.makerId === this.room.bot.playerId) {
            observeBotResolution(this.room, this.room.bot.playerId);
          }
          await this.advanceBotUntilHumanTurn();
          await this.scheduleRoomAlarm();
          await this.persist();
          this.broadcastRoom();
          return;
        case CLIENT_EVENTS.REQUEST_NEXT_REVEAL:
          if (!isCardGame(this.room)) {
            throw new Error("Early reveal voting is only available in the card market.");
          }
          requestCardRevealVote(this.room, playerId);
          reseedLiveCardBots(this.room, Date.now());
          await this.persist();
          await this.scheduleRoomAlarm();
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
              ensureCardBotsReady(this.room);
              pruneCardBotsPendingRemoval(this.room);
            } else {
              prepareNextGame(this.room, sampleContract(), { swap: true, autoStart: true });
            }
            if (!isCardGame(this.room) && this.room.bot?.enabled) {
              refreshBotEstimate(this.room);
              await this.advanceBotUntilHumanTurn();
            }
          }
          await this.scheduleRoomAlarm();
          await this.persist();
          this.broadcastRoom();
          return;
        }
        case CLIENT_EVENTS.LEAVE_ROOM:
          await this.handleLeaveRoom(playerId);
          await this.scheduleRoomAlarm();
          await this.persist();
          if (this.room) {
            this.broadcastRoom();
          }
          return;
        case CLIENT_EVENTS.PING:
          if (activityChanged) {
            await this.persist();
          }
          await this.scheduleRoomAlarm();
          this.send(ws, { type: SERVER_EVENTS.PONG, at: Date.now() });
          return;
        default:
          throw new Error(`Unknown client event: ${parsed.type}`);
      }
    } catch (error) {
      if (activityChanged) {
        await this.persist();
      }
      await this.scheduleRoomAlarm();
      this.send(ws, { type: SERVER_EVENTS.ERROR, error: error.message || "Message failed." });
    }
  }

  async webSocketClose() {
    if (!this.room) {
      return;
    }
    await this.syncCardGameState();
    await this.scheduleRoomAlarm();
    this.broadcastRoom();
  }

  async webSocketError() {
    if (!this.room) {
      return;
    }
    await this.syncCardGameState();
    await this.scheduleRoomAlarm();
    this.broadcastRoom();
  }

  async alarm() {
    await this.ready;
    if (!this.room) {
      return;
    }
    let changed = await this.syncCardGameState();
    if (this.room && isCardGame(this.room) && pruneCardBotsPendingRemoval(this.room)) {
      changed = true;
    }
    if (await this.removeInactivePlayers()) {
      changed = true;
    }
    await this.scheduleRoomAlarm();
    if (changed) {
      await this.persist();
      this.broadcastRoom();
    }
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

      const decision = await botDecision(this.room, botPlayerId, this.env);
      if (decision.type === "submit_quote") {
        submitQuote(this.room, botPlayerId, decision.payload);
      } else {
        takeAction(this.room, botPlayerId, decision.payload);
      }
    }
  }

  connectedIds() {
    const ids = new Set(
      this.ctx
        .getWebSockets()
        .map((socket) => socket.deserializeAttachment()?.playerId)
        .filter((playerId) => playerId && playerFor(this.room, playerId))
    );
    cardBotConnectedIds(this.room).forEach((playerId) => ids.add(playerId));
    return ids;
  }

  closeSocketsForPlayer(playerId, code = 1000, reason = "Connection closed") {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.playerId !== playerId) {
        continue;
      }
      try {
        socket.close(code, reason);
      } catch {
        // ignore socket close failures
      }
    }
  }

  async handleLeaveRoom(playerId) {
    if (!this.room) {
      return;
    }

    const departing = playerFor(this.room, playerId);
    if (!departing) {
      throw new Error("Unknown player.");
    }

    const liveHiddenRoom = !isCardGame(this.room) && this.room.status === "live";
    const message = liveHiddenRoom
      ? `${departing.name} left the room. The round was cancelled. Waiting for a new opponent.`
      : `${departing.name} left the room. Waiting for a new opponent.`;

    if (this.room.bot?.enabled) {
      this.closeSocketsForPlayer(playerId, 1000, "Left room");
      this.room = null;
      await this.scheduleRoomAlarm();
      return;
    }

    if (isCardGame(this.room)) {
      const activeCardSeat = this.room.status === "live" && this.room.game.activeSeatIds?.includes(playerId);
      removePlayerFromRoom(this.room, playerId);
      this.closeSocketsForPlayer(playerId, 1000, "Left room");
      if (activeCardSeat) {
        cancelCardRound(this.room, `${departing.name} left during the round. The table returned to lobby for a fresh deal.`);
        pruneCardBotsPendingRemoval(this.room);
      } else {
        refreshCardLobbyState(this.room, this.connectedIds(), Date.now());
      }
      return;
    }

    const outcome = handleHiddenPlayerDeparture(this.room, playerId, message);
    this.closeSocketsForPlayer(playerId, 1000, "Left room");
    if (outcome.roomEmpty) {
      this.room = null;
      await this.scheduleRoomAlarm();
    }
  }

  async removeInactivePlayers(now = Date.now()) {
    if (!this.room) {
      return false;
    }

    const inactiveIds = inactivePlayerIds(this.room, now, INACTIVITY_TIMEOUT_MS);
    if (!inactiveIds.length) {
      return false;
    }

    let changed = false;
    for (const playerId of inactiveIds) {
      const inactivePlayer = playerFor(this.room, playerId);
      if (!inactivePlayer) {
        continue;
      }

      if (this.room.bot?.enabled) {
        this.closeSocketsForPlayer(playerId, INACTIVITY_CLOSE_CODE, INACTIVITY_CLOSE_REASON);
        this.room = null;
        changed = true;
        break;
      }

      if (isCardGame(this.room)) {
        const activeCardSeat = this.room.status === "live" && this.room.game.activeSeatIds?.includes(playerId);
        removePlayerFromRoom(this.room, playerId);
        this.closeSocketsForPlayer(playerId, INACTIVITY_CLOSE_CODE, INACTIVITY_CLOSE_REASON);
        if (activeCardSeat) {
          cancelCardRound(
            this.room,
            `${inactivePlayer.name} was removed after 5 minutes of inactivity. The table returned to lobby for a fresh deal.`,
            now
          );
          pruneCardBotsPendingRemoval(this.room);
        } else {
          refreshCardLobbyState(this.room, this.connectedIds(), now);
        }
        changed = true;
        continue;
      }

      const outcome = handleHiddenPlayerDeparture(
        this.room,
        playerId,
        `${inactivePlayer.name} was removed after 5 minutes of inactivity. Waiting for a new opponent.`
      );
      this.closeSocketsForPlayer(playerId, INACTIVITY_CLOSE_CODE, INACTIVITY_CLOSE_REASON);
      changed = true;
      if (outcome.roomEmpty) {
        this.room = null;
        break;
      }
    }

    return changed;
  }

  validPlayerId(playerId) {
    return Boolean(playerId && playerFor(this.room, playerId));
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
      if (!this.validPlayerId(playerId)) {
        try {
          socket.close(1000, "Player is no longer in the room");
        } catch {
          // ignore stale socket close failures
        }
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
    if (this.room) {
      await this.ctx.storage.put("room", this.room);
      return;
    }
    await this.ctx.storage.delete("room");
  }

  async syncCardGameState(now = Date.now()) {
    if (!isCardGame(this.room)) {
      return false;
    }
    ensureCardBotsReady(this.room);
    let changed = advanceCardGameClock(this.room, this.connectedIds(), now);
    if (await advanceCardBots(this.room, this.env, now)) {
      changed = true;
    }
    if (pruneCardBotsPendingRemoval(this.room)) {
      changed = true;
    }
    if (changed) {
      await this.persist();
    }
    return changed;
  }

  nextAlarmAt() {
    if (!this.room) {
      return null;
    }
    const deadlines = [];
    const inactivityAt = nextInactivityDeadline(this.room, INACTIVITY_TIMEOUT_MS);
    if (inactivityAt) {
      deadlines.push(inactivityAt);
    }
    if (isCardGame(this.room)) {
      const cardAt = nextCardAlarmAt(this.room);
      if (cardAt) {
        deadlines.push(cardAt);
      }
      const botAt = nextCardBotWakeAt(this.room);
      if (botAt) {
        deadlines.push(botAt);
      }
    }
    if (!deadlines.length) {
      return null;
    }
    return Math.min(...deadlines);
  }

  async scheduleRoomAlarm() {
    const nextAt = this.nextAlarmAt();
    if (nextAt) {
      await this.ctx.storage.setAlarm(nextAt);
      return;
    }
    await this.ctx.storage.deleteAlarm();
  }

  send(socket, payload) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // no-op
    }
  }
}
