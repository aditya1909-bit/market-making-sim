import { GAME_ACTOR, GAME_ROLE, ROOM_STATUS, TAKER_ACTION } from "../shared/protocol.js";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function roleForPlayer(room, playerId) {
  if (room.makerId === playerId) {
    return GAME_ROLE.MAKER;
  }
  if (room.takerId === playerId) {
    return GAME_ROLE.TAKER;
  }
  return GAME_ROLE.SPECTATOR;
}

export function createGameState(contract) {
  return {
    contract,
    status: ROOM_STATUS.LOBBY,
    turn: 0,
    maxTurns: contract.maxTurns,
    activeActor: null,
    currentQuote: null,
    lastResolution: null,
    maker: { cash: 0, inventory: 0 },
    taker: { cash: 0, inventory: 0 },
    log: [],
  };
}

export function assignRoles(room) {
  const players = [...room.players.values()];
  if (players.length < 2) {
    throw new Error("Need exactly two players to assign roles.");
  }
  const [a, b] = players;
  const makerFirst = Math.random() > 0.5;
  room.makerId = makerFirst ? a.id : b.id;
  room.takerId = makerFirst ? b.id : a.id;
}

export function maybeStartGame(room) {
  if (room.status !== ROOM_STATUS.LOBBY) {
    return false;
  }
  if (!room.makerId || !room.takerId) {
    return false;
  }
  const maker = room.players.get(room.makerId);
  const taker = room.players.get(room.takerId);
  if (!maker?.ready || !taker?.ready) {
    return false;
  }

  room.status = ROOM_STATUS.LIVE;
  room.game.status = ROOM_STATUS.LIVE;
  room.game.turn = 1;
  room.game.activeActor = GAME_ACTOR.MAKER;
  room.game.log.unshift({
    type: "info",
    turn: 0,
    text: "Game started. Market maker quotes first.",
  });
  return true;
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
  room.game.activeActor = GAME_ACTOR.TAKER;
  room.game.lastResolution = {
    type: "quote_submitted",
    text: `Maker quoted ${round2(bid)} / ${round2(ask)} for ${size}.`,
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
    text = `Taker buys ${qty} at ${tradePrice}.`;
  } else if (action === TAKER_ACTION.SELL) {
    tradePrice = quote.bid;
    room.game.maker.cash -= tradePrice * qty;
    room.game.maker.inventory += qty;
    room.game.taker.cash += tradePrice * qty;
    room.game.taker.inventory -= qty;
    text = `Taker sells ${qty} at ${tradePrice}.`;
  } else if (action === TAKER_ACTION.PASS) {
    text = "Taker passes.";
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
  room.game.currentQuote = null;

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

export function buildPlayerView(room, playerId) {
  const role = roleForPlayer(room, playerId);
  const isFinished = room.status === ROOM_STATUS.FINISHED;
  return {
    roomId: room.id,
    roomCode: room.code,
    status: room.status,
    role,
    ready: room.players.get(playerId)?.ready ?? false,
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      ready: player.ready,
      role: roleForPlayer(room, player.id),
      connected: player.connected,
    })),
    game: {
      contract: {
        prompt: room.game.contract.prompt,
        unitLabel: room.game.contract.unitLabel,
        rangeLow: room.game.contract.rangeLow,
        rangeHigh: room.game.contract.rangeHigh,
        maxTurns: room.game.contract.maxTurns,
      },
      turn: room.game.turn,
      maxTurns: room.game.maxTurns,
      activeActor: room.game.activeActor,
      currentQuote: room.game.currentQuote,
      lastResolution: room.game.lastResolution,
      maker: room.game.maker,
      taker: room.game.taker,
      settlement: isFinished ? room.game.contract.hiddenValue : null,
      makerPnl: isFinished ? round2(room.game.maker.cash + room.game.maker.inventory * room.game.contract.hiddenValue) : null,
      takerPnl: isFinished ? round2(room.game.taker.cash + room.game.taker.inventory * room.game.contract.hiddenValue) : null,
      log: room.game.log.slice(0, 12),
    },
  };
}
