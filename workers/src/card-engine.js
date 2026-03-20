import { GAME_ROLE, ROOM_STATUS, TAKER_ACTION } from "./protocol.js";
import { playerFor } from "./game-engine.js";

const BOARD_CARD_COUNT = 5;
const PRIVATE_CARDS_PER_PLAYER = 2;
const MAX_QUOTE_SIZE = 5;
const ROUND_DURATION_MS = 5 * 60 * 1000;
const REVEAL_INTERVAL_MS = 60 * 1000;
const QUOTE_TTL_MS = 25 * 1000;
const SHOE_COUNT = 1;

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
  for (let deckIndex = 1; deckIndex <= SHOE_COUNT; deckIndex += 1) {
    for (const [rank, rankValue] of ranks) {
      for (const [suit, color, suitName] of suits) {
        cards.push({
          id: `${deckIndex}-${rank}${suit}`,
          code: `${rank}${suit}`,
          rank,
          rankValue,
          suit,
          suitName,
          color,
          deckIndex,
        });
      }
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
  };
}

function scorerFor(targetId) {
  return TARGETS.find((entry) => entry.id === targetId) || TARGETS[0];
}

function emptyPositions(players) {
  return Object.fromEntries(players.map((player) => [player.id, { cash: 0, inventory: 0 }]));
}

function pruneExpiredQuotes(room, now) {
  let changed = false;
  for (const [playerId, quote] of Object.entries(room.game.liveQuotes || {})) {
    if (!quote || typeof quote.quotedAt !== "number") {
      continue;
    }
    if (now - quote.quotedAt >= QUOTE_TTL_MS) {
      delete room.game.liveQuotes[playerId];
      changed = true;
    }
  }
  return changed;
}

function drawCard(room) {
  if (!room.game.deck?.length) {
    return null;
  }
  return room.game.deck.shift() || null;
}

function visibleBoard(room) {
  return (room.game.boardCards || []).slice(0, room.game.revealedBoardCount || 0);
}

function allCardsInPlay(room) {
  const privateCards = Object.values(room.game.privateHands || {}).flat();
  return privateCards.concat(room.game.boardCards || []);
}

function midpoint(quote) {
  if (!quote) {
    return null;
  }
  return (Number(quote.bid) + Number(quote.ask)) / 2;
}

function markForGame(room) {
  if (room.game.settlement !== null && room.game.settlement !== undefined) {
    return room.game.settlement;
  }
  const mids = Object.values(room.game.liveQuotes || {})
    .map((quote) => midpoint(quote))
    .filter((value) => value !== null && value !== undefined);
  if (!mids.length) {
    return room.game.lastMark ?? 0;
  }
  return round2(mids.reduce((sum, value) => sum + value, 0) / mids.length);
}

function provisionalPnl(position, mark) {
  return round2(position.cash + position.inventory * mark);
}

function roleForCardPlayer(room, playerId) {
  if (room.players.some((player) => player.id === playerId)) {
    return room.game.liveQuotes?.[playerId] ? "quoting" : "trader";
  }
  return GAME_ROLE.SPECTATOR;
}

function revealNextBoardCard(room, now, reason) {
  if ((room.game.revealedBoardCount || 0) >= (room.game.boardCards?.length || 0)) {
    return false;
  }

  room.game.revealedBoardCount += 1;
  room.game.lastRevealAt = now;
  room.game.revealVotes = {};
  room.game.liveQuotes = {};
  room.game.lastResolution = {
    type: "board_revealed",
    text: `${reason}. Board is now ${visibleBoard(room).map((card) => card.code).join(" ")}. Private hands stay fixed for the full round and all live quotes were cleared.`,
  };
  room.game.log.unshift({
    type: "reveal",
    turn: room.game.revealedBoardCount,
    text: room.game.lastResolution.text,
  });
  if (room.game.revealedBoardCount < room.game.boardCards.length) {
    room.game.nextRevealAt = now + REVEAL_INTERVAL_MS;
  } else {
    room.game.nextRevealAt = room.game.endsAt;
  }
  return true;
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
    lastResolution: null,
    log: [],
    boardCards: [],
    revealedBoardCount: 0,
    privateHands: {},
    deck: [],
    positions: emptyPositions(room.players),
    settlement: null,
    lastMark: 0,
    liveQuotes: {},
    revealVotes: {},
    startedAt: null,
    endsAt: null,
    nextRevealAt: null,
    lastRevealAt: null,
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

export function startCardGame(room, now = Date.now()) {
  if (room.players.length < 2 || room.players.length > 10) {
    throw new Error("Card market supports between 2 and 10 players.");
  }

  const totalCards = room.players.length * PRIVATE_CARDS_PER_PLAYER + BOARD_CARD_COUNT;
  if (totalCards > 52 * SHOE_COUNT) {
    throw new Error("Not enough cards in the deck for this room size.");
  }
  const target = chooseTarget(totalCards);
  const shuffledDeck = shuffle(buildDeck());
  const privateHands = {};

  room.players.forEach((player) => {
    privateHands[player.id] = shuffledDeck.splice(0, PRIVATE_CARDS_PER_PLAYER);
  });

  const boardCards = shuffledDeck.splice(0, BOARD_CARD_COUNT);

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
    activeActor: null,
    boardCards,
    revealedBoardCount: 1,
    privateHands,
    deck: shuffledDeck,
    positions: emptyPositions(room.players),
    settlement: null,
    lastMark: 0,
    liveQuotes: {},
    revealVotes: {},
    startedAt: now,
    endsAt: now + ROUND_DURATION_MS,
    nextRevealAt: now + REVEAL_INTERVAL_MS,
    lastRevealAt: now,
    target: {
      id: target.id,
      label: target.label,
    },
    targetScorerId: target.id,
    lastResolution: {
      type: "game_started",
      text: `Game ${room.gameNumber} started. First board card is live and the round clock is running.`,
    },
    log: [
      {
        type: "info",
        turn: 0,
        text: `Game ${room.gameNumber} started. Trade freely for five minutes while the board reveals over time.`,
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
    quotedAt: Date.now(),
  };
}

export function submitCardQuote(room, playerId, payload) {
  if (room.status !== ROOM_STATUS.LIVE) {
    throw new Error("The card market is not live.");
  }
  pruneExpiredQuotes(room, Date.now());
  if (!playerFor(room, playerId)) {
    throw new Error("Unknown player.");
  }

  const quote = validateQuote(payload);
  room.game.liveQuotes[playerId] = quote;
  room.game.lastMark = midpoint(quote) ?? room.game.lastMark ?? 0;
  room.game.lastResolution = {
    type: "quote_submitted",
    text: `${playerFor(room, playerId)?.name || "Player"} quoted ${quote.bid} / ${quote.ask} for ${quote.size}.`,
  };
}

export function takeCardAction(room, playerId, payload) {
  if (room.status !== ROOM_STATUS.LIVE) {
    throw new Error("The card market is not live.");
  }
  pruneExpiredQuotes(room, Date.now());
  const targetPlayerId = String(payload.targetPlayerId || "");
  if (!targetPlayerId) {
    throw new Error("Select a quote first.");
  }
  if (playerId === targetPlayerId) {
    throw new Error("You cannot trade against your own quote.");
  }

  const quote = room.game.liveQuotes?.[targetPlayerId];
  if (!quote) {
    throw new Error("That quote is no longer live.");
  }

  const action = payload.action;
  const qty = quote.size;
  const quoteOwner = playerFor(room, targetPlayerId);
  const taker = playerFor(room, playerId);
  const makerPosition = room.game.positions[targetPlayerId];
  const takerPosition = room.game.positions[playerId];

  let tradePrice = null;
  let text = "";

  if (action === TAKER_ACTION.BUY) {
    tradePrice = quote.ask;
    makerPosition.cash += tradePrice * qty;
    makerPosition.inventory -= qty;
    takerPosition.cash -= tradePrice * qty;
    takerPosition.inventory += qty;
    text = `${taker?.name || "Player"} buys ${qty} at ${tradePrice} from ${quoteOwner?.name || "maker"}.`;
  } else if (action === TAKER_ACTION.SELL) {
    tradePrice = quote.bid;
    makerPosition.cash -= tradePrice * qty;
    makerPosition.inventory += qty;
    takerPosition.cash += tradePrice * qty;
    takerPosition.inventory -= qty;
    text = `${taker?.name || "Player"} sells ${qty} at ${tradePrice} to ${quoteOwner?.name || "maker"}.`;
  } else {
    throw new Error("Unknown responder action.");
  }

  room.game.lastMark = tradePrice;
  room.game.lastResolution = {
    type: "trade",
    action,
    mark: tradePrice,
    text,
  };
  room.game.log.unshift({
    type: action,
    turn: room.game.revealedBoardCount,
    text,
  });
}

export function requestCardRevealVote(room, playerId, now = Date.now()) {
  if (room.status !== ROOM_STATUS.LIVE) {
    throw new Error("The card market is not live.");
  }
  pruneExpiredQuotes(room, now);
  if ((room.game.revealedBoardCount || 0) >= (room.game.boardCards?.length || 0)) {
    throw new Error("All board cards are already visible.");
  }

  room.game.revealVotes[playerId] = true;
  const allVoted = room.players.every((player) => room.game.revealVotes[player.id]);
  if (allVoted) {
    revealNextBoardCard(room, now, "All players voted to reveal the next card early");
    return { revealed: true };
  }

  room.game.lastResolution = {
    type: "reveal_vote",
    text: `${playerFor(room, playerId)?.name || "Player"} voted to reveal the next card early.`,
  };
  return { revealed: false };
}

export function advanceCardGameClock(room, now = Date.now()) {
  if (room?.gameType !== "card_market" || room.status !== ROOM_STATUS.LIVE) {
    return false;
  }

  let changed = false;

  if (pruneExpiredQuotes(room, now)) {
    changed = true;
  }

  while ((room.game.revealedBoardCount || 0) < (room.game.boardCards?.length || 0) && room.game.nextRevealAt && now >= room.game.nextRevealAt) {
    revealNextBoardCard(room, room.game.nextRevealAt, "The round timer revealed the next board card");
    changed = true;
  }

  if (room.game.endsAt && now >= room.game.endsAt) {
    finishCardGame(room);
    changed = true;
  }

  return changed;
}

export function nextCardAlarmAt(room) {
  if (room?.gameType !== "card_market" || room.status !== ROOM_STATUS.LIVE) {
    return null;
  }
  const deadlines = [];
  if (room.game.nextRevealAt) {
    deadlines.push(room.game.nextRevealAt);
  }
  if (room.game.endsAt) {
    deadlines.push(room.game.endsAt);
  }
  for (const quote of Object.values(room.game.liveQuotes || {})) {
    if (quote?.quotedAt) {
      deadlines.push(quote.quotedAt + QUOTE_TTL_MS);
    }
  }
  if (!deadlines.length) {
    return null;
  }
  return Math.min(...deadlines);
}

export function finishCardGame(room) {
  const target = scorerFor(room.game.targetScorerId);
  const settlement = round2(target.score(allCardsInPlay(room)));

  room.status = ROOM_STATUS.FINISHED;
  room.game.status = ROOM_STATUS.FINISHED;
  room.game.settlement = settlement;
  room.game.liveQuotes = {};
  room.game.revealVotes = {};
  room.game.nextRevealAt = null;
  room.game.lastResolution = {
    type: "game_finished",
    settlement,
    text: `Game finished. Final settlement ${settlement}.`,
  };
  room.game.log.unshift({
    type: "finished",
    turn: room.game.revealedBoardCount,
    text: room.game.lastResolution.text,
  });
}

export function buildCardPlayerView(room, playerId, connectedIds = new Set(), now = Date.now()) {
  pruneExpiredQuotes(room, now);
  const positions = room.game.positions || emptyPositions(room.players);
  const mark = markForGame(room);
  const revealVotes = room.game.revealVotes || {};
  const liveQuotes = room.game.liveQuotes || {};

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
      quoteTtlMs: QUOTE_TTL_MS,
      turn: room.game.revealedBoardCount || 0,
      maxTurns: room.game.boardCards?.length || 0,
      activeActor: null,
      currentQuote: null,
      lastResolution: room.game.lastResolution,
      boardCards: visibleBoard(room),
      boardRevealTotal: room.game.boardCards?.length || 0,
      privateHand: room.game.privateHands?.[playerId] || [],
      positions: room.players.map((entry) => ({
        id: entry.id,
        name: entry.name,
        cash: round2(positions[entry.id]?.cash || 0),
        inventory: positions[entry.id]?.inventory || 0,
        pnl: provisionalPnl(positions[entry.id] || { cash: 0, inventory: 0 }, mark),
      })),
      liveQuotes: room.players
        .filter((entry) => liveQuotes[entry.id])
        .map((entry) => ({
          playerId: entry.id,
          playerName: entry.name,
          bid: liveQuotes[entry.id].bid,
          ask: liveQuotes[entry.id].ask,
          size: liveQuotes[entry.id].size,
          quotedAt: liveQuotes[entry.id].quotedAt,
          msUntilExpiry: Math.max(QUOTE_TTL_MS - (now - liveQuotes[entry.id].quotedAt), 0),
          canTrade: entry.id !== playerId,
        }))
        .sort((a, b) => (b.quotedAt || 0) - (a.quotedAt || 0)),
      revealVotes: room.players.filter((entry) => revealVotes[entry.id]).map((entry) => entry.id),
      revealVotesNeeded: room.players.length,
      revealRequestedByYou: Boolean(revealVotes[playerId]),
      startedAt: room.game.startedAt,
      endsAt: room.game.endsAt,
      nextRevealAt: room.game.nextRevealAt,
      msRemaining: room.game.endsAt ? Math.max(room.game.endsAt - now, 0) : null,
      msUntilNextReveal:
        room.status === ROOM_STATUS.LIVE && room.game.nextRevealAt ? Math.max(room.game.nextRevealAt - now, 0) : null,
      settlement: room.status === ROOM_STATUS.FINISHED ? room.game.settlement : null,
      log: room.game.log.slice(0, 18),
    },
  };
}
