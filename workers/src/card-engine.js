import { GAME_ACTOR, GAME_ROLE, ROOM_STATUS, TAKER_ACTION } from "./protocol.js";
import { playerFor } from "./game-engine.js";

const BOARD_CARD_COUNT = 3;
const PRIVATE_CARDS_PER_PLAYER = 2;
const MAX_QUOTE_SIZE = 5;

const TARGETS = [
  {
    id: "spades_minus_red",
    label: "Spades minus red cards",
    prompt: "Trade the final value of spades minus red cards across every private hand and all revealed board cards.",
    unitLabel: "points",
    rangeFor(totalCards) {
      return { rangeLow: -totalCards, rangeHigh: totalCards };
    },
    score(cards) {
      let total = 0;
      for (const card of cards) {
        if (card.suit === "S") {
          total += 1;
        }
        if (card.color === "red") {
          total -= 1;
        }
      }
      return total;
    },
  },
  {
    id: "black_minus_low",
    label: "Black cards minus low cards",
    prompt: "Trade the final value of black cards minus cards ranked five or lower across every private hand and all revealed board cards.",
    unitLabel: "points",
    rangeFor(totalCards) {
      return { rangeLow: -totalCards, rangeHigh: totalCards };
    },
    score(cards) {
      let total = 0;
      for (const card of cards) {
        if (card.color === "black") {
          total += 1;
        }
        if (card.rankValue <= 5) {
          total -= 1;
        }
      }
      return total;
    },
  },
  {
    id: "faces_plus_aces",
    label: "Face cards plus aces",
    prompt: "Trade the final count of face cards and aces across every private hand and all revealed board cards.",
    unitLabel: "cards",
    rangeFor(totalCards) {
      return { rangeLow: 0, rangeHigh: totalCards };
    },
    score(cards) {
      let total = 0;
      for (const card of cards) {
        if (card.rank === "A" || card.rank === "J" || card.rank === "Q" || card.rank === "K") {
          total += 1;
        }
      }
      return total;
    },
  },
];

function round2(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function shuffle(values) {
  const deck = [...values];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const current = deck[i];
    deck[i] = deck[j];
    deck[j] = current;
  }
  return deck;
}

function buildDeck() {
  const ranks = [
    ["A", 14],
    ["K", 13],
    ["Q", 12],
    ["J", 11],
    ["10", 10],
    ["9", 9],
    ["8", 8],
    ["7", 7],
    ["6", 6],
    ["5", 5],
    ["4", 4],
    ["3", 3],
    ["2", 2],
  ];
  const suits = [
    ["S", "black", "Spades"],
    ["H", "red", "Hearts"],
    ["D", "red", "Diamonds"],
    ["C", "black", "Clubs"],
  ];

  const cards = [];
  for (const [rank, rankValue] of ranks) {
    for (const [suit, color, suitName] of suits) {
      cards.push({
        code: `${rank}${suit}`,
        rank,
        rankValue,
        suit,
        suitName,
        color,
      });
    }
  }
  return cards;
}

function chooseTarget(totalCards) {
  const target = TARGETS[Math.floor(Math.random() * TARGETS.length)];
  return {
    id: target.id,
    label: target.label,
    prompt: target.prompt,
    unitLabel: target.unitLabel,
    ...target.rangeFor(totalCards),
    scoreCards: target.score,
  };
}

function emptyPositions(players) {
  return Object.fromEntries(players.map((player) => [player.id, { cash: 0, inventory: 0 }]));
}

function currentMaker(room) {
  return playerFor(room, room.game.currentMakerId);
}

function responderIds(room) {
  return room.players.filter((player) => player.id !== room.game.currentMakerId).map((player) => player.id);
}

function allCardsInPlay(room) {
  const privateCards = Object.values(room.game.privateHands || {}).flat();
  return privateCards.concat(room.game.boardCards || []);
}

export function createCardGamePreview(room) {
  const totalCards = room.players.length * PRIVATE_CARDS_PER_PLAYER + BOARD_CARD_COUNT;
  const target = chooseTarget(totalCards);
  return {
    mode: "card_market",
    status: ROOM_STATUS.LOBBY,
    prompt: target.prompt,
    unitLabel: target.unitLabel,
    rangeLow: target.rangeLow,
    rangeHigh: target.rangeHigh,
    maxTurns: BOARD_CARD_COUNT,
    turn: 0,
    activeActor: null,
    currentMakerId: null,
    currentQuote: null,
    respondedPlayerIds: [],
    lastResolution: null,
    log: [],
    boardCards: [],
    privateHands: {},
    positions: emptyPositions(room.players),
    settlement: null,
    target: {
      id: target.id,
      label: target.label,
    },
  };
}

export function prepareNextCardGame(room, options = {}) {
  const incrementGameNumber = Boolean(options.incrementGameNumber);
  room.status = ROOM_STATUS.LOBBY;
  room.game = createCardGamePreview(room);
  if (incrementGameNumber) {
    room.gameNumber += 1;
  }
}

export function maybeStartCardGame(room) {
  if (room.status !== ROOM_STATUS.LOBBY) {
    return false;
  }
  if (room.players.length < 2) {
    return false;
  }
  if (room.players.length > 10) {
    throw new Error("Card market supports between 2 and 10 players.");
  }
  if (!room.players.every((player) => player.ready)) {
    return false;
  }

  startCardGame(room);
  return true;
}

export function startCardGame(room) {
  if (room.players.length < 2 || room.players.length > 10) {
    throw new Error("Card market supports between 2 and 10 players.");
  }

  const totalCards = room.players.length * PRIVATE_CARDS_PER_PLAYER + BOARD_CARD_COUNT;
  const target = chooseTarget(totalCards);
  const shuffledDeck = shuffle(buildDeck());
  const privateHands = {};

  room.players.forEach((player) => {
    privateHands[player.id] = shuffledDeck.splice(0, PRIVATE_CARDS_PER_PLAYER);
  });

  const boardCards = shuffledDeck.splice(0, BOARD_CARD_COUNT);
  const openingMakerIndex = Math.floor(Math.random() * room.players.length);

  room.status = ROOM_STATUS.LIVE;
  room.game = {
    mode: "card_market",
    status: ROOM_STATUS.LIVE,
    prompt: target.prompt,
    unitLabel: target.unitLabel,
    rangeLow: target.rangeLow,
    rangeHigh: target.rangeHigh,
    maxTurns: BOARD_CARD_COUNT,
    turn: 1,
    activeActor: GAME_ACTOR.MAKER,
    currentMakerId: room.players[openingMakerIndex].id,
    makerIndex: openingMakerIndex,
    currentQuote: null,
    respondedPlayerIds: [],
    boardCards,
    revealedBoardCount: 1,
    privateHands,
    positions: emptyPositions(room.players),
    settlement: null,
    target: {
      id: target.id,
      label: target.label,
    },
    targetScorerId: target.id,
    lastResolution: {
      type: "game_started",
      text: `Game ${room.gameNumber} started. ${playerFor(room, room.players[openingMakerIndex].id)?.name || "Maker"} quotes first.`,
    },
    log: [
      {
        type: "info",
        turn: 0,
        text: `Game ${room.gameNumber} started. One board card is live and the opening maker quotes first.`,
      },
    ],
  };
}

function validateQuote(payload) {
  const bid = Number(payload.bid);
  const ask = Number(payload.ask);
  const size = clamp(Number(payload.size) || 1, 1, MAX_QUOTE_SIZE);

  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    throw new Error("Bid and ask must be numeric.");
  }
  if (ask <= bid) {
    throw new Error("Ask must be strictly greater than bid.");
  }

  return {
    bid: round2(bid),
    ask: round2(ask),
    size,
  };
}

export function submitCardQuote(room, playerId, payload) {
  if (room.status !== ROOM_STATUS.LIVE || room.game.activeActor !== GAME_ACTOR.MAKER) {
    throw new Error("It is not the current maker's turn.");
  }
  if (playerId !== room.game.currentMakerId) {
    throw new Error("Only the current maker can submit a quote.");
  }

  const quote = validateQuote(payload);
  room.game.currentQuote = quote;
  room.game.respondedPlayerIds = [];
  room.game.activeActor = GAME_ACTOR.TAKER;
  room.game.lastResolution = {
    type: "quote_submitted",
    text: `${playerFor(room, playerId)?.name || "Maker"} quoted ${quote.bid} / ${quote.ask} for ${quote.size}.`,
  };
}

function finishCardRound(room) {
  room.game.currentQuote = null;

  if (room.game.turn >= room.game.maxTurns) {
    finishCardGame(room);
    return;
  }

  room.game.turn += 1;
  room.game.makerIndex = (room.game.makerIndex + 1) % room.players.length;
  room.game.currentMakerId = room.players[room.game.makerIndex].id;
  room.game.revealedBoardCount = Math.min(room.game.turn, room.game.boardCards.length);
  room.game.respondedPlayerIds = [];
  room.game.activeActor = GAME_ACTOR.MAKER;
  room.game.lastResolution = {
    type: "round_advanced",
    text: `Round ${room.game.turn} started. ${currentMaker(room)?.name || "Maker"} is now the maker.`,
  };
  room.game.log.unshift({
    type: "round",
    turn: room.game.turn,
    text: room.game.lastResolution.text,
  });
}

export function takeCardAction(room, playerId, payload) {
  if (room.status !== ROOM_STATUS.LIVE || room.game.activeActor !== GAME_ACTOR.TAKER) {
    throw new Error("It is not the responders' turn.");
  }
  if (playerId === room.game.currentMakerId) {
    throw new Error("The maker cannot trade against their own quote.");
  }
  if (room.game.respondedPlayerIds.includes(playerId)) {
    throw new Error("You already responded to this quote.");
  }
  if (!room.game.currentQuote) {
    throw new Error("No active quote to trade against.");
  }

  const responder = playerFor(room, playerId);
  const makerId = room.game.currentMakerId;
  const action = payload.action;
  const quote = room.game.currentQuote;
  const qty = quote.size;
  const makerPosition = room.game.positions[makerId];
  const responderPosition = room.game.positions[playerId];

  let text = "";
  if (action === TAKER_ACTION.BUY) {
    makerPosition.cash += quote.ask * qty;
    makerPosition.inventory -= qty;
    responderPosition.cash -= quote.ask * qty;
    responderPosition.inventory += qty;
    text = `${responder?.name || "Player"} buys ${qty} at ${quote.ask}.`;
  } else if (action === TAKER_ACTION.SELL) {
    makerPosition.cash -= quote.bid * qty;
    makerPosition.inventory += qty;
    responderPosition.cash += quote.bid * qty;
    responderPosition.inventory -= qty;
    text = `${responder?.name || "Player"} sells ${qty} at ${quote.bid}.`;
  } else if (action === TAKER_ACTION.PASS) {
    text = `${responder?.name || "Player"} passes.`;
  } else {
    throw new Error("Unknown responder action.");
  }

  room.game.respondedPlayerIds.push(playerId);
  room.game.lastResolution = {
    type: "turn_resolved",
    action,
    text,
  };
  room.game.log.unshift({
    type: action,
    turn: room.game.turn,
    text: `Round ${room.game.turn}. ${currentMaker(room)?.name || "Maker"} quoted ${quote.bid} / ${quote.ask} x ${quote.size}. ${text}`,
  });

  if (room.game.respondedPlayerIds.length >= responderIds(room).length) {
    finishCardRound(room);
  }
}

export function finishCardGame(room) {
  const target = TARGETS.find((entry) => entry.id === room.game.targetScorerId);
  const settlement = round2(target ? target.score(allCardsInPlay(room)) : 0);

  room.status = ROOM_STATUS.FINISHED;
  room.game.status = ROOM_STATUS.FINISHED;
  room.game.activeActor = null;
  room.game.currentQuote = null;
  room.game.settlement = settlement;
  room.game.lastResolution = {
    type: "game_finished",
    settlement,
    text: `Game finished. Final settlement ${settlement}.`,
  };
  room.game.log.unshift({
    type: "finished",
    turn: room.game.turn,
    text: room.game.lastResolution.text,
  });
}

function roleForCardPlayer(room, playerId) {
  if (room.status === ROOM_STATUS.LIVE && room.game.currentMakerId === playerId) {
    return GAME_ROLE.MAKER;
  }
  if (room.status === ROOM_STATUS.LIVE && room.players.some((player) => player.id === playerId)) {
    return GAME_ROLE.TAKER;
  }
  return GAME_ROLE.SPECTATOR;
}

function visibleBoard(room) {
  return (room.game.boardCards || []).slice(0, room.game.revealedBoardCount || 0);
}

function provisionalPnl(position, settlement) {
  return round2(position.cash + position.inventory * settlement);
}

export function buildCardPlayerView(room, playerId, connectedIds = new Set()) {
  const positions = room.game.positions || emptyPositions(room.players);
  const settlementMark =
    room.game.settlement ??
    (room.game.currentQuote ? round2((room.game.currentQuote.bid + room.game.currentQuote.ask) / 2) : 0);

  return {
    roomId: room.id,
    roomCode: room.code,
    gameType: room.gameType,
    status: room.status,
    role: roleForCardPlayer(room, playerId),
    ready: playerFor(room, playerId)?.ready ?? false,
    matchType: room.matchType,
    gameNumber: room.gameNumber,
    rematch: {
      requested: Boolean(room.rematchVotes[playerId]),
      pendingPlayers: room.players.filter((entry) => !room.rematchVotes[entry.id]).map((entry) => entry.name),
    },
    players: room.players.map((entry) => ({
      id: entry.id,
      name: entry.name,
      ready: entry.ready,
      role: roleForCardPlayer(room, entry.id),
      connected: connectedIds.has(entry.id),
      isBot: entry.isBot,
    })),
    game: {
      contract: {
        prompt: room.game.prompt,
        unitLabel: room.game.unitLabel,
        rangeLow: room.game.rangeLow,
        rangeHigh: room.game.rangeHigh,
        maxTurns: room.game.maxTurns,
      },
      mode: room.game.mode,
      target: room.game.target,
      turn: room.game.turn,
      maxTurns: room.game.maxTurns,
      activeActor: room.game.activeActor,
      currentMakerId: room.game.currentMakerId,
      currentMakerName: currentMaker(room)?.name || "-",
      currentQuote: room.game.currentQuote,
      respondedPlayerIds: [...(room.game.respondedPlayerIds || [])],
      lastResolution: room.game.lastResolution,
      boardCards: visibleBoard(room),
      boardRevealTotal: room.game.boardCards?.length || 0,
      privateHand: room.game.privateHands?.[playerId] || [],
      positions: room.players.map((entry) => ({
        id: entry.id,
        name: entry.name,
        cash: round2(positions[entry.id]?.cash || 0),
        inventory: positions[entry.id]?.inventory || 0,
        pnl: room.status === ROOM_STATUS.FINISHED ? provisionalPnl(positions[entry.id] || { cash: 0, inventory: 0 }, room.game.settlement) : provisionalPnl(positions[entry.id] || { cash: 0, inventory: 0 }, settlementMark),
      })),
      settlement: room.status === ROOM_STATUS.FINISHED ? room.game.settlement : null,
      log: room.game.log.slice(0, 18),
    },
  };
}
