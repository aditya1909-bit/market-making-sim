import { GAME_ACTOR, GAME_ROLE, ROOM_STATUS, TAKER_ACTION } from "./protocol.js";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

export function playerFor(room, playerId) {
  return room.players.find((player) => player.id === playerId) || null;
}

export function roleForPlayer(room, playerId) {
  if (room.makerId === playerId) {
    return GAME_ROLE.MAKER;
  }
  if (room.takerId === playerId) {
    return GAME_ROLE.TAKER;
  }
  return GAME_ROLE.SPECTATOR;
}

export function createPlayer(name, options = {}) {
  const lastActiveAt = Number.isFinite(options.lastActiveAt) ? Number(options.lastActiveAt) : Date.now();
  return {
    id: crypto.randomUUID(),
    name: String(name || "Player").trim().slice(0, 32) || "Player",
    ready: Boolean(options.ready),
    isBot: Boolean(options.isBot),
    botKind: options.botKind ? String(options.botKind) : null,
    botPolicyVersion: options.botPolicyVersion ? String(options.botPolicyVersion) : null,
    botNextActionAt: Number.isFinite(options.botNextActionAt) ? Number(options.botNextActionAt) : null,
    pendingRemoval: Boolean(options.pendingRemoval),
    lastActiveAt,
  };
}

export function createGameState(contract = null) {
  return {
    contract,
    status: ROOM_STATUS.LOBBY,
    turn: 0,
    maxTurns: contract?.maxTurns ?? 0,
    activeActor: null,
    currentQuote: null,
    previousQuote: null,
    quoteHistory: [],
    actionHistory: [],
    lastResolution: null,
    maker: { cash: 0, inventory: 0 },
    taker: { cash: 0, inventory: 0 },
    log: [],
  };
}

function baseRoom(code, options = {}) {
  return {
    id: crypto.randomUUID(),
    code,
    hostId: null,
    players: [],
    gameType: options.gameType || "hidden_value",
    roomVisibility: options.roomVisibility || "private_room",
    maxPlayers: options.maxPlayers || 2,
    makerId: null,
    takerId: null,
    status: ROOM_STATUS.LOBBY,
    game: createGameState(),
    matchType: "human",
    gameNumber: 0,
    rematchVotes: {},
    bot: null,
  };
}

function lobbyMessage(text) {
  if (!text) {
    return null;
  }
  return {
    type: "player_left",
    text,
  };
}

export function createRoomState(code, hostName, options = {}) {
  const room = baseRoom(code, options);
  const host = createPlayer(hostName);
  room.players = [host];
  room.hostId = host.id;
  return room;
}

export function createMatchedRoomState(code, nameA, nameB, gameType = "hidden_value") {
  const normalizedGameType = gameType === "card_market" ? "card_market" : "hidden_value";
  const room = baseRoom(code, {
    gameType: normalizedGameType,
    maxPlayers: normalizedGameType === "card_market" ? 10 : 2,
    roomVisibility: "private_room",
  });
  const a = createPlayer(nameA);
  const b = createPlayer(nameB);
  room.players = [a, b];
  room.hostId = a.id;
  if (normalizedGameType === "hidden_value") {
    assignRoles(room);
  }
  return room;
}

export function createBotRoomState(code, humanName, humanRole = GAME_ROLE.MAKER, strategy = "rl") {
  const room = baseRoom(code, { gameType: "hidden_value", maxPlayers: 2, roomVisibility: "private_room" });
  const human = createPlayer(humanName, { ready: true });
  const bot = createPlayer("RL Bot", { ready: true, isBot: true });
  room.players = [human, bot];
  room.hostId = human.id;
  room.matchType = "bot";
  room.bot = {
    enabled: true,
    playerId: bot.id,
    strategy,
    privateEstimate: null,
  };

  if (humanRole === GAME_ROLE.TAKER) {
    room.makerId = bot.id;
    room.takerId = human.id;
  } else {
    room.makerId = human.id;
    room.takerId = bot.id;
  }

  return room;
}

export function clearRoles(room) {
  room.makerId = null;
  room.takerId = null;
}

export function seedContract(room, contract) {
  room.game = createGameState(contract);
}

export function assignRoles(room) {
  if (room.players.length !== 2) {
    throw new Error("Need exactly two players to assign roles.");
  }
  const [a, b] = room.players;
  const makerFirst = Math.random() > 0.5;
  room.makerId = makerFirst ? a.id : b.id;
  room.takerId = makerFirst ? b.id : a.id;
}

export function swapRoles(room) {
  const currentMaker = room.makerId;
  room.makerId = room.takerId;
  room.takerId = currentMaker;
}

export function addPlayerToRoom(room, name) {
  if (room.players.length >= (room.maxPlayers || 2)) {
    throw new Error("Room is already full.");
  }
  const player = createPlayer(name);
  room.players.push(player);
  if (room.gameType === "hidden_value" && room.players.length === 2 && (!room.makerId || !room.takerId)) {
    assignRoles(room);
  }
  return player;
}

export function removePlayerFromRoom(room, playerId) {
  const index = room.players.findIndex((player) => player.id === playerId);
  if (index < 0) {
    throw new Error("Unknown player.");
  }

  const [removed] = room.players.splice(index, 1);
  delete room.rematchVotes[playerId];

  if (room.hostId === playerId) {
    room.hostId = room.players[0]?.id || null;
  }

  if (room.makerId === playerId || room.takerId === playerId) {
    clearRoles(room);
  }

  return removed;
}

export function markPlayerActive(room, playerId, now = Date.now()) {
  const player = playerFor(room, playerId);
  if (!player || player.isBot) {
    return false;
  }
  player.lastActiveAt = now;
  return true;
}

export function inactivePlayerIds(room, now = Date.now(), inactivityMs = 5 * 60 * 1000) {
  return room.players
    .filter((player) => !player.isBot && Number.isFinite(player.lastActiveAt) && now - player.lastActiveAt >= inactivityMs)
    .map((player) => player.id);
}

export function nextInactivityDeadline(room, inactivityMs = 5 * 60 * 1000) {
  const deadlines = room.players
    .filter((player) => !player.isBot && Number.isFinite(player.lastActiveAt))
    .map((player) => player.lastActiveAt + inactivityMs);

  if (!deadlines.length) {
    return null;
  }
  return Math.min(...deadlines);
}

export function setReady(room, playerId, ready) {
  const player = playerFor(room, playerId);
  if (!player) {
    throw new Error("Unknown player.");
  }
  player.ready = Boolean(ready);
}

export function clearReady(room) {
  room.players.forEach((player) => {
    player.ready = Boolean(player.isBot);
  });
}

export function resetRematchVotes(room) {
  room.rematchVotes = {};
}

export function requestRematch(room, playerId) {
  if (room.status !== ROOM_STATUS.FINISHED) {
    throw new Error("Rematch is only available after settlement.");
  }
  room.rematchVotes[playerId] = true;
  return hasAllRematchVotes(room);
}

export function hasAllRematchVotes(room) {
  return room.players.every((player) => room.rematchVotes[player.id]);
}

export function startGame(room) {
  if (!room.makerId || !room.takerId) {
    throw new Error("Roles must be assigned before the game starts.");
  }
  if (!room.game.contract) {
    throw new Error("Game contract is missing.");
  }

  room.status = ROOM_STATUS.LIVE;
  room.game.status = ROOM_STATUS.LIVE;
  room.game.turn = 1;
  room.game.maxTurns = room.game.contract.maxTurns;
  room.game.activeActor = GAME_ACTOR.MAKER;
  room.game.currentQuote = null;
  room.game.previousQuote = null;
  room.game.quoteHistory = [];
  room.game.actionHistory = [];
  room.game.lastResolution = {
    type: "game_started",
    text: `Game ${room.gameNumber} started. Market maker quotes first.`,
  };
  room.game.log.unshift({
    type: "info",
    turn: 0,
    text: room.game.lastResolution.text,
  });
}

export function maybeStartGame(room) {
  if (room.status !== ROOM_STATUS.LOBBY) {
    return false;
  }
  if (!room.makerId || !room.takerId) {
    return false;
  }
  const maker = playerFor(room, room.makerId);
  const taker = playerFor(room, room.takerId);
  if (!maker?.ready || !taker?.ready) {
    return false;
  }

  startGame(room);
  return true;
}

export function prepareNextGame(room, contract, { swap = false, autoStart = false } = {}) {
  if (swap) {
    swapRoles(room);
  }
  resetRematchVotes(room);
  clearReady(room);
  seedContract(room, contract);
  room.status = ROOM_STATUS.LOBBY;
  room.gameNumber += 1;

  if (autoStart) {
    room.players.forEach((player) => {
      player.ready = true;
    });
    startGame(room);
  }
}

export function handleHiddenPlayerDeparture(room, playerId, message) {
  const removed = removePlayerFromRoom(room, playerId);

  if (!room.players.length) {
    return {
      removed,
      roomEmpty: true,
    };
  }

  resetRematchVotes(room);
  clearReady(room);
  clearRoles(room);
  room.status = ROOM_STATUS.LOBBY;
  room.game = createGameState();
  room.game.lastResolution = lobbyMessage(message);
  if (room.game.lastResolution) {
    room.game.log.unshift({
      type: "info",
      turn: 0,
      text: room.game.lastResolution.text,
    });
  }

  return {
    removed,
    roomEmpty: false,
  };
}

export function submitQuote(room, playerId, payload) {
  if (room.status !== ROOM_STATUS.LIVE || room.game.activeActor !== GAME_ACTOR.MAKER) {
    throw new Error("It is not the market maker's turn.");
  }
  if (playerId !== room.makerId) {
    throw new Error("Only the market maker can submit a quote.");
  }

  const bid = Number(payload.bid);
  const ask = Number(payload.ask);
  const size = clamp(Number(payload.size) || 1, 1, 10);

  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    throw new Error("Bid and ask must be numeric.");
  }
  if (ask <= bid) {
    throw new Error("Ask must be strictly greater than bid.");
  }

  room.game.currentQuote = { bid: round2(bid), ask: round2(ask), size };
  room.game.quoteHistory = [...(room.game.quoteHistory || []), room.game.currentQuote].slice(-4);
  room.game.activeActor = GAME_ACTOR.TAKER;
  room.game.lastResolution = {
    type: "quote_submitted",
    text: `${playerFor(room, playerId)?.name || "Maker"} quoted ${round2(bid)} / ${round2(ask)} for ${size}.`,
  };
}

export function takeAction(room, playerId, payload) {
  if (room.status !== ROOM_STATUS.LIVE || room.game.activeActor !== GAME_ACTOR.TAKER) {
    throw new Error("It is not the market taker's turn.");
  }
  if (playerId !== room.takerId) {
    throw new Error("Only the market taker can respond to a quote.");
  }
  if (!room.game.currentQuote) {
    throw new Error("No active quote to trade against.");
  }

  const takerName = playerFor(room, playerId)?.name || "Taker";
  const action = payload.action;
  const quote = room.game.currentQuote;
  const qty = quote.size;
  let tradePrice = null;
  let text = "";

  if (action === TAKER_ACTION.BUY) {
    tradePrice = quote.ask;
    room.game.maker.cash += tradePrice * qty;
    room.game.maker.inventory -= qty;
    room.game.taker.cash -= tradePrice * qty;
    room.game.taker.inventory += qty;
    text = `${takerName} buys ${qty} at ${tradePrice}.`;
  } else if (action === TAKER_ACTION.SELL) {
    tradePrice = quote.bid;
    room.game.maker.cash -= tradePrice * qty;
    room.game.maker.inventory += qty;
    room.game.taker.cash += tradePrice * qty;
    room.game.taker.inventory -= qty;
    text = `${takerName} sells ${qty} at ${tradePrice}.`;
  } else if (action === TAKER_ACTION.PASS) {
    text = `${takerName} passes.`;
  } else {
    throw new Error("Unknown taker action.");
  }

  const mark = action === TAKER_ACTION.PASS ? round2((quote.bid + quote.ask) / 2) : tradePrice;

  room.game.lastResolution = {
    type: "turn_resolved",
    action,
    mark,
    text,
  };
  room.game.log.unshift({
    type: action,
    turn: room.game.turn,
    text: `Turn ${room.game.turn}. Quote ${quote.bid} / ${quote.ask} x ${quote.size}. ${text}`,
  });
  room.game.previousQuote = quote;
  room.game.currentQuote = null;
  room.game.actionHistory = [...(room.game.actionHistory || []), action].slice(-6);

  if (room.game.turn >= room.game.maxTurns) {
    finishGame(room);
    return;
  }

  room.game.turn += 1;
  room.game.activeActor = GAME_ACTOR.MAKER;
}

export function finishGame(room) {
  const settle = room.game.contract.hiddenValue;
  const makerPnl = round2(room.game.maker.cash + room.game.maker.inventory * settle);
  const takerPnl = round2(room.game.taker.cash + room.game.taker.inventory * settle);

  room.status = ROOM_STATUS.FINISHED;
  room.game.status = ROOM_STATUS.FINISHED;
  room.game.activeActor = null;
  room.game.lastResolution = {
    type: "game_finished",
    settlement: settle,
    makerPnl,
    takerPnl,
    text: `Game finished. Settlement ${settle}. Maker PnL ${makerPnl}. Taker PnL ${takerPnl}.`,
  };
  room.game.log.unshift({
    type: "finished",
    turn: room.game.turn,
    text: room.game.lastResolution.text,
  });
}

export function buildPlayerView(room, playerId, connectedIds = new Set()) {
  const role = roleForPlayer(room, playerId);
  const player = playerFor(room, playerId);
  const isFinished = room.status === ROOM_STATUS.FINISHED;
  const pendingRematch = room.players
    .filter((entry) => !room.rematchVotes[entry.id])
    .map((entry) => entry.name);

  return {
    roomId: room.id,
    roomCode: room.code,
    gameType: room.gameType,
    status: room.status,
    isHost: room.hostId === playerId,
    role,
    ready: player?.ready ?? false,
    matchType: room.matchType,
    gameNumber: room.gameNumber,
    bot:
      room.bot && role !== GAME_ROLE.SPECTATOR
        ? {
            enabled: true,
            strategy: room.bot.strategy,
            isOpponent: room.bot.playerId !== playerId,
            playerId: room.bot.playerId,
          }
        : null,
    rematch: {
      requested: Boolean(room.rematchVotes[playerId]),
      pendingPlayers: pendingRematch,
    },
    players: room.players.map((entry) => ({
      id: entry.id,
      name: entry.name,
      ready: entry.ready,
      role: roleForPlayer(room, entry.id),
      connected: entry.isBot || connectedIds.has(entry.id),
      isBot: entry.isBot,
      botKind: entry.botKind || null,
      botPolicyVersion: entry.botPolicyVersion || null,
      pendingRemoval: Boolean(entry.pendingRemoval),
    })),
    game: {
      contract: room.game.contract
        ? {
            prompt: room.game.contract.prompt,
            unitLabel: room.game.contract.unitLabel,
            rangeLow: room.game.contract.rangeLow,
            rangeHigh: room.game.contract.rangeHigh,
            maxTurns: room.game.contract.maxTurns,
          }
        : null,
      turn: room.game.turn,
      maxTurns: room.game.maxTurns,
      activeActor: room.game.activeActor,
      currentQuote: room.game.currentQuote,
      previousQuote: room.game.previousQuote,
      quoteHistory: (room.game.quoteHistory || []).slice(-4),
      lastResolution: room.game.lastResolution,
      maker: room.game.maker,
      taker: room.game.taker,
      settlement: isFinished ? room.game.contract.hiddenValue : null,
      makerPnl: isFinished ? round2(room.game.maker.cash + room.game.maker.inventory * room.game.contract.hiddenValue) : null,
      takerPnl: isFinished ? round2(room.game.taker.cash + room.game.taker.inventory * room.game.contract.hiddenValue) : null,
      log: room.game.log.slice(0, 16),
    },
  };
}
