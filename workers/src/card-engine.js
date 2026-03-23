import { GAME_ROLE, ROOM_STATUS, TAKER_ACTION } from "./protocol.js";
import { playerFor } from "./game-engine.js";

const BOARD_CARD_COUNT = 5;
const PRIVATE_CARDS_PER_PLAYER = 2;
const CARD_MIN_PLAYERS = 2;
const CARD_MAX_PLAYERS = 10;
const MAX_QUOTE_SIZE = 5;
const ROUND_DURATION_MS = 5 * 60 * 1000;
const REVEAL_INTERVAL_MS = 60 * 1000;
const QUOTE_TTL_MS = 25 * 1000;
const CARD_AUTO_START_COUNTDOWN_MS = 8 * 1000;
const SHOE_COUNT = 1;
const QUOTE_LOG_PRICE_EPSILON = 0.25;

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

function targetForSeatCount(playerCount) {
  return chooseTarget(playerCount * PRIVATE_CARDS_PER_PLAYER + BOARD_CARD_COUNT);
}

function scorerFor(targetId) {
  return TARGETS.find((entry) => entry.id === targetId) || TARGETS[0];
}

function emptyPositions(players) {
  return Object.fromEntries(players.map((player) => [player.id, { cash: 0, inventory: 0 }]));
}

function activeSeatIds(room) {
  return room.game.activeSeatIds || [];
}

function activeSeatSet(room) {
  return new Set(activeSeatIds(room));
}

function activePlayers(room) {
  const seatIds = activeSeatSet(room);
  return room.players.filter((player) => seatIds.has(player.id));
}

function connectedHumanPlayers(room, connectedIds = new Set()) {
  return room.players.filter((player) => !player.isBot && connectedIds.has(player.id));
}

function readyConnectedHumanPlayers(room, connectedIds = new Set()) {
  return connectedHumanPlayers(room, connectedIds).filter((player) => player.ready);
}

function nextRoundHumanReadyThreshold(room, connectedIds = new Set()) {
  const connectedHumans = connectedHumanPlayers(room, connectedIds).length;
  if (!connectedHumans) {
    return 1;
  }
  return Math.max(1, Math.ceil(connectedHumans / 2));
}

function eligibleSeatIds(room, connectedIds = new Set()) {
  const readyHumans = readyConnectedHumanPlayers(room, connectedIds);
  const readyThreshold = nextRoundHumanReadyThreshold(room, connectedIds);
  if (readyHumans.length < readyThreshold) {
    return [];
  }
  return room.players
    .filter((player) => !player.pendingRemoval && player.ready && (player.isBot || connectedIds.has(player.id)))
    .map((player) => player.id)
    .sort();
}

function arraysEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

function isActiveSeat(room, playerId) {
  return activeSeatSet(room).has(playerId);
}

function resetCardReady(room) {
  room.players.forEach((player) => {
    player.ready = false;
  });
}

function applyLobbyTarget(room, seatCount) {
  const target = targetForSeatCount(Math.max(seatCount, CARD_MIN_PLAYERS));
  let changed = false;

  if (room.game.prompt !== target.prompt) {
    room.game.prompt = target.prompt;
    changed = true;
  }
  if (room.game.unitLabel !== target.unitLabel) {
    room.game.unitLabel = target.unitLabel;
    changed = true;
  }
  if (room.game.rangeLow !== target.rangeLow || room.game.rangeHigh !== target.rangeHigh) {
    room.game.rangeLow = target.rangeLow;
    room.game.rangeHigh = target.rangeHigh;
    changed = true;
  }
  if (room.game.target?.id !== target.id || room.game.target?.label !== target.label) {
    room.game.target = { id: target.id, label: target.label };
    changed = true;
  }
  if (room.game.targetScorerId !== target.id) {
    room.game.targetScorerId = target.id;
    changed = true;
  }

  return changed;
}

function playerSeatStatus(room, playerId) {
  if (!playerFor(room, playerId)) {
    return "spectator";
  }
  if (playerFor(room, playerId)?.pendingRemoval) {
    return room.status === ROOM_STATUS.LIVE ? "active_round" : "removed";
  }
  if (room.status === ROOM_STATUS.LIVE) {
    return isActiveSeat(room, playerId) ? "active_round" : "waiting_next_round";
  }
  return "lobby_member";
}

function roleForCardPlayer() {
  return GAME_ROLE.SPECTATOR;
}

function makeSummary(kind, text, options = {}) {
  return {
    kind,
    text,
    settlement: options.settlement ?? null,
    activeSeatCount: options.activeSeatCount ?? 0,
    positions: options.positions || [],
    ranking: options.ranking || options.positions || [],
    log: options.log || [],
    completedAt: options.completedAt || Date.now(),
  };
}

function currentPositionSnapshot(room, playerId, mark) {
  const position = room.game.positions?.[playerId] || { cash: 0, inventory: 0 };
  return {
    id: playerId,
    name: playerFor(room, playerId)?.name || "Player",
    cash: round2(position.cash || 0),
    inventory: position.inventory || 0,
    pnl: provisionalPnl(position, mark),
  };
}

function cardSummaryForRound(room, kind, text, settlement = null, completedAt = Date.now()) {
  const mark = settlement ?? markForGame(room);
  const positions = activeSeatIds(room).map((playerId) => currentPositionSnapshot(room, playerId, mark));
  const ranking = [...positions].sort((a, b) => Number(b.pnl || 0) - Number(a.pnl || 0) || a.name.localeCompare(b.name));
  return makeSummary(kind, text, {
    settlement,
    activeSeatCount: activeSeatIds(room).length,
    completedAt,
    positions,
    ranking,
    log: room.game.log.slice(0, 40),
  });
}

function recordCardActionMoment(room, at = Date.now()) {
  if (!room?.game) {
    return;
  }
  const next = [...(room.game.recentActionMoments || []), at]
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)
    .slice(-10);
  room.game.recentActionMoments = next;
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

function visibleBoard(room) {
  return (room.game.boardCards || []).slice(0, room.game.revealedBoardCount || 0);
}

function allCardsInPlay(room) {
  const privateCards = activeSeatIds(room).flatMap((playerId) => room.game.privateHands?.[playerId] || []);
  return privateCards.concat(room.game.boardCards || []);
}

function midpoint(quote) {
  if (!quote) {
    return null;
  }
  return (Number(quote.bid) + Number(quote.ask)) / 2;
}

function quoteChangedMaterially(previousQuote, nextQuote) {
  if (!previousQuote) {
    return true;
  }
  return (
    Number(previousQuote.size || 0) !== Number(nextQuote.size || 0) ||
    Math.abs(Number(previousQuote.bid || 0) - Number(nextQuote.bid || 0)) >= QUOTE_LOG_PRICE_EPSILON ||
    Math.abs(Number(previousQuote.ask || 0) - Number(nextQuote.ask || 0)) >= QUOTE_LOG_PRICE_EPSILON
  );
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
  return round2((position?.cash || 0) + (position?.inventory || 0) * mark);
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
    text: `${reason}. Board is now ${visibleBoard(room).map((card) => card.code).join(" ")}. All live quotes were cleared.`,
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

export function createCardGamePreview(room, options = {}) {
  const target = options.target || targetForSeatCount(Math.max(room.players.length, CARD_MIN_PLAYERS));
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
    lastResolution: options.lastResolution || null,
    log: options.log ? [...options.log] : [],
    boardCards: [],
    revealedBoardCount: 0,
    privateHands: {},
    deck: [],
    positions: {},
    settlement: null,
    lastMark: 0,
    liveQuotes: {},
    revealVotes: {},
    activeSeatIds: [],
    countdownSeatIds: [],
    countdownStartedAt: null,
    countdownEndsAt: null,
    previousSummary: options.previousSummary || null,
    startedAt: null,
    endsAt: null,
    nextRevealAt: null,
    lastRevealAt: null,
    recentActionMoments: [],
    target: {
      id: target.id,
      label: target.label,
    },
    targetScorerId: target.id,
  };
}

export function prepareNextCardGame(room, options = {}) {
  room.status = ROOM_STATUS.LOBBY;
  resetCardReady(room);
  room.game = createCardGamePreview(room, {
    previousSummary: options.previousSummary || null,
    target: options.target || null,
    lastResolution: options.lastResolution || null,
    log: options.log || [],
  });
  if (options.incrementGameNumber) {
    room.gameNumber += 1;
  }
}

export function refreshCardLobbyState(room, connectedIds = new Set(), now = Date.now()) {
  if (room.status !== ROOM_STATUS.LOBBY) {
    return false;
  }

  const eligibleIds = eligibleSeatIds(room, connectedIds);
  const previewSeatCount = eligibleIds.length >= CARD_MIN_PLAYERS ? eligibleIds.length : room.players.length;
  let changed = applyLobbyTarget(room, previewSeatCount);

  if (refreshCardLobbyCountdown(room, connectedIds, now)) {
    changed = true;
  }

  return changed;
}

export function refreshCardLobbyCountdown(room, connectedIds = new Set(), now = Date.now()) {
  if (room.status !== ROOM_STATUS.LOBBY) {
    return false;
  }

  const eligibleIds = eligibleSeatIds(room, connectedIds);
  const currentIds = room.game.countdownSeatIds || [];
  const hasCountdown = Boolean(room.game.countdownEndsAt);
  let changed = false;

  if (eligibleIds.length < CARD_MIN_PLAYERS) {
    if (hasCountdown || currentIds.length) {
      room.game.countdownSeatIds = [];
      room.game.countdownStartedAt = null;
      room.game.countdownEndsAt = null;
      changed = true;
    }
    return changed;
  }

  if (!hasCountdown || !arraysEqual(currentIds, eligibleIds)) {
    applyLobbyTarget(room, eligibleIds.length);
    room.game.countdownSeatIds = eligibleIds;
    room.game.countdownStartedAt = now;
    room.game.countdownEndsAt = now + CARD_AUTO_START_COUNTDOWN_MS;
    room.game.lastResolution = {
      type: "countdown_started",
      text: `Countdown started for ${eligibleIds.length} ready player${eligibleIds.length === 1 ? "" : "s"}.`,
    };
    changed = true;
  }

  return changed;
}

export function maybeStartCardGame(room, connectedIds = new Set(), now = Date.now()) {
  if (room.status !== ROOM_STATUS.LOBBY) {
    return false;
  }
  refreshCardLobbyCountdown(room, connectedIds, now);
  if (!room.game.countdownEndsAt || now < room.game.countdownEndsAt) {
    return false;
  }
  const seatIds = room.game.countdownSeatIds || [];
  if (seatIds.length < CARD_MIN_PLAYERS) {
    return false;
  }
  startCardGame(room, seatIds, now);
  return true;
}

export function startCardGame(room, seatIds = null, now = Date.now()) {
  const resolvedSeatIds = Array.isArray(seatIds) && seatIds.length ? [...seatIds] : [...(room.game.countdownSeatIds || [])];
  const seatedPlayers = room.players.filter((player) => resolvedSeatIds.includes(player.id));
  if (seatedPlayers.length < CARD_MIN_PLAYERS || seatedPlayers.length > CARD_MAX_PLAYERS) {
    throw new Error("Card market supports between 2 and 10 active players.");
  }

  const totalCards = seatedPlayers.length * PRIVATE_CARDS_PER_PLAYER + BOARD_CARD_COUNT;
  if (totalCards > 52 * SHOE_COUNT) {
    throw new Error("Not enough cards in the deck for this room size.");
  }

  const scorer = scorerFor(room.game.targetScorerId);
  const range = scorer.rangeFor(totalCards);
  const shuffledDeck = shuffle(buildDeck());
  const privateHands = {};
  for (const player of seatedPlayers) {
    privateHands[player.id] = shuffledDeck.splice(0, PRIVATE_CARDS_PER_PLAYER);
  }
  const boardCards = shuffledDeck.splice(0, BOARD_CARD_COUNT);

  room.status = ROOM_STATUS.LIVE;
  room.game = {
    mode: "card_market",
    status: ROOM_STATUS.LIVE,
    prompt: scorer.prompt,
    unitLabel: scorer.unitLabel,
    rangeLow: range.rangeLow,
    rangeHigh: range.rangeHigh,
    maxTurns: BOARD_CARD_COUNT,
    turn: 1,
    activeActor: null,
    boardCards,
    revealedBoardCount: 1,
    privateHands,
    deck: shuffledDeck,
    positions: emptyPositions(seatedPlayers),
    settlement: null,
    lastMark: 0,
    liveQuotes: {},
    revealVotes: {},
    activeSeatIds: resolvedSeatIds,
    countdownSeatIds: [],
    countdownStartedAt: null,
    countdownEndsAt: null,
    previousSummary: room.game.previousSummary || null,
    startedAt: now,
    endsAt: now + ROUND_DURATION_MS,
    nextRevealAt: now + REVEAL_INTERVAL_MS,
    lastRevealAt: now,
    recentActionMoments: [],
    target: {
      id: scorer.id,
      label: scorer.label,
    },
    targetScorerId: scorer.id,
    lastResolution: {
      type: "game_started",
      text: `Game ${room.gameNumber} started with ${seatedPlayers.length} seated player${seatedPlayers.length === 1 ? "" : "s"}.`,
    },
    log: [
      {
        type: "info",
        turn: 0,
        text: `Game ${room.gameNumber} started. ${seatedPlayers.length} seated player${seatedPlayers.length === 1 ? "" : "s"} can trade while the board reveals over time.`,
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
  if (!isActiveSeat(room, playerId)) {
    throw new Error("You are waiting for the next round.");
  }

  const previousQuote = room.game.liveQuotes?.[playerId] || null;
  const quote = validateQuote(payload);
  room.game.liveQuotes[playerId] = quote;
  room.game.lastMark = midpoint(quote) ?? room.game.lastMark ?? 0;
  recordCardActionMoment(room, quote.quotedAt);
  if (quoteChangedMaterially(previousQuote, quote)) {
    room.game.lastResolution = {
      type: "quote_submitted",
      text: `${playerFor(room, playerId)?.name || "Player"} quoted ${quote.bid} / ${quote.ask} for ${quote.size}.`,
    };
    room.game.log.unshift({
      type: "quote",
      turn: room.game.revealedBoardCount,
      text: room.game.lastResolution.text,
    });
  }
}

export function takeCardAction(room, playerId, payload) {
  if (room.status !== ROOM_STATUS.LIVE) {
    throw new Error("The card market is not live.");
  }
  pruneExpiredQuotes(room, Date.now());
  if (!isActiveSeat(room, playerId)) {
    throw new Error("You are waiting for the next round.");
  }

  const targetPlayerId = String(payload.targetPlayerId || "");
  if (!targetPlayerId) {
    throw new Error("Select a quote first.");
  }
  if (playerId === targetPlayerId) {
    throw new Error("You cannot trade against your own quote.");
  }
  if (!isActiveSeat(room, targetPlayerId)) {
    throw new Error("That player is not seated in this round.");
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

  delete room.game.liveQuotes[targetPlayerId];
  room.game.lastMark = tradePrice;
  recordCardActionMoment(room, Date.now());
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
  if (!isActiveSeat(room, playerId)) {
    throw new Error("You are waiting for the next round.");
  }
  if ((room.game.revealedBoardCount || 0) >= (room.game.boardCards?.length || 0)) {
    throw new Error("All board cards are already visible.");
  }

  room.game.revealVotes[playerId] = true;
  recordCardActionMoment(room, now);
  const allVoted = activeSeatIds(room).every((activePlayerId) => room.game.revealVotes[activePlayerId]);
  if (allVoted) {
    revealNextBoardCard(room, now, "All seated players voted to reveal the next card early");
    return { revealed: true };
  }

  room.game.lastResolution = {
    type: "reveal_vote",
    text: `${playerFor(room, playerId)?.name || "Player"} voted to reveal the next card early.`,
  };
  return { revealed: false };
}

export function cancelCardRound(room, reason, now = Date.now()) {
  const summary = cardSummaryForRound(room, "cancelled", reason, null, now);
  prepareNextCardGame(room, {
    incrementGameNumber: true,
    previousSummary: summary,
    lastResolution: {
      type: "round_cancelled",
      text: reason,
    },
    log: [
      {
        type: "cancelled",
        turn: 0,
        text: reason,
      },
    ],
  });
}

export function advanceCardGameClock(room, connectedIds = new Set(), now = Date.now()) {
  if (room?.gameType !== "card_market") {
    return false;
  }

  let changed = false;

  if (room.status === ROOM_STATUS.LOBBY) {
    if (refreshCardLobbyCountdown(room, connectedIds, now)) {
      changed = true;
    }
    if (room.game.countdownEndsAt && now >= room.game.countdownEndsAt) {
      startCardGame(room, room.game.countdownSeatIds, now);
      changed = true;
    }
    return changed;
  }

  if (room.status !== ROOM_STATUS.LIVE) {
    return false;
  }

  if (pruneExpiredQuotes(room, now)) {
    changed = true;
  }

  while ((room.game.revealedBoardCount || 0) < (room.game.boardCards?.length || 0) && room.game.nextRevealAt && now >= room.game.nextRevealAt) {
    revealNextBoardCard(room, room.game.nextRevealAt, "The round timer revealed the next board card");
    changed = true;
  }

  if (room.game.endsAt && now >= room.game.endsAt) {
    finishCardGame(room, now);
    changed = true;
  }

  return changed;
}

export function nextCardAlarmAt(room) {
  if (room?.gameType !== "card_market") {
    return null;
  }

  const deadlines = [];
  if (room.status === ROOM_STATUS.LOBBY && room.game.countdownEndsAt) {
    deadlines.push(room.game.countdownEndsAt);
  }
  if (room.status === ROOM_STATUS.LIVE) {
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
  }

  if (!deadlines.length) {
    return null;
  }
  return Math.min(...deadlines);
}

export function finishCardGame(room, now = Date.now()) {
  const target = scorerFor(room.game.targetScorerId);
  const settlement = round2(target.score(allCardsInPlay(room)));
  const summary = cardSummaryForRound(room, "finished", `Game finished. Final settlement ${settlement}.`, settlement, now);
  const podium = summary.ranking
    .slice(0, 3)
    .map((entry, index) => `${index + 1}. ${entry.name} ${round2(entry.pnl)}`)
    .join(" · ");
  prepareNextCardGame(room, {
    incrementGameNumber: true,
    previousSummary: summary,
    lastResolution: {
      type: "game_finished",
      settlement,
      text: podium ? `${summary.text} ${podium}.` : summary.text,
    },
    log: [
      {
        type: "finished",
        turn: 0,
        text: podium ? `${summary.text} ${podium}.` : summary.text,
      },
    ],
  });
}

export function buildCardPlayerView(room, playerId, connectedIds = new Set(), now = Date.now()) {
  const positions = room.game.positions || {};
  const mark = markForGame(room);
  const revealVotes = room.game.revealVotes || {};
  const liveQuotes = room.game.liveQuotes || {};
  const activeIds = activeSeatIds(room);
  const activeIdSet = activeSeatSet(room);
  const connectedHumanCount = connectedHumanPlayers(room, connectedIds).length;
  const readyHumanCount = readyConnectedHumanPlayers(room, connectedIds).length;
  const readyThreshold = nextRoundHumanReadyThreshold(room, connectedIds);
  const canQuote = room.status === ROOM_STATUS.LIVE && activeIdSet.has(playerId);
  const canTrade =
    room.status === ROOM_STATUS.LIVE &&
    activeIdSet.has(playerId) &&
    activeIds.some((activePlayerId) => activePlayerId !== playerId && liveQuotes[activePlayerId]);
  const canVoteReveal =
    room.status === ROOM_STATUS.LIVE &&
    activeIdSet.has(playerId) &&
    (room.game.revealedBoardCount || 0) < (room.game.boardCards?.length || 0) &&
    !revealVotes[playerId];

  return {
    roomId: room.id,
    roomCode: room.code,
    gameType: room.gameType,
    roomVisibility: room.roomVisibility,
    status: room.status,
    isHost: room.hostId === playerId,
    role: roleForCardPlayer(room, playerId),
    cardSeatStatus: playerSeatStatus(room, playerId),
    cardCapabilities: {
      canQuote,
      canTrade,
      canVoteReveal,
    },
    table: {
      minPlayers: CARD_MIN_PLAYERS,
      maxPlayers: room.maxPlayers || CARD_MAX_PLAYERS,
      playerCount: room.players.length,
      activeSeatCount: activeIds.length,
      waitingCount: room.players.length - activeIds.length,
      connectedHumanCount,
      readyHumanCount,
      readyThreshold,
      countdownStartedAt: room.game.countdownStartedAt,
      countdownEndsAt: room.game.countdownEndsAt,
      msUntilStart:
        room.status === ROOM_STATUS.LOBBY && room.game.countdownEndsAt ? Math.max(room.game.countdownEndsAt - now, 0) : null,
    },
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
      seatStatus: playerSeatStatus(room, entry.id),
      quotingNow: Boolean(liveQuotes[entry.id]),
      connected: entry.isBot || connectedIds.has(entry.id),
      isBot: entry.isBot,
      botKind: entry.botKind || null,
      botPolicyVersion: entry.botPolicyVersion || null,
      pendingRemoval: Boolean(entry.pendingRemoval),
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
      previousSummary: room.game.previousSummary || null,
      boardCards: visibleBoard(room),
      boardRevealTotal: room.game.boardCards?.length || 0,
      privateHand: activeIdSet.has(playerId) ? room.game.privateHands?.[playerId] || [] : [],
      activeSeatIds: activeIds,
      waitingPlayerIds: room.players.filter((entry) => !activeIdSet.has(entry.id)).map((entry) => entry.id),
      positions: room.players
        .filter((entry) => positions[entry.id])
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          cash: round2(positions[entry.id]?.cash || 0),
          inventory: positions[entry.id]?.inventory || 0,
          pnl: provisionalPnl(positions[entry.id] || { cash: 0, inventory: 0 }, mark),
        })),
      liveQuotes: room.players
        .filter((entry) => liveQuotes[entry.id] && activeIdSet.has(entry.id))
        .map((entry) => ({
          playerId: entry.id,
          playerName: entry.name,
          seatStatus: playerSeatStatus(room, entry.id),
          bid: liveQuotes[entry.id].bid,
          ask: liveQuotes[entry.id].ask,
          size: liveQuotes[entry.id].size,
          quotedAt: liveQuotes[entry.id].quotedAt,
          msUntilExpiry: Math.max(QUOTE_TTL_MS - (now - liveQuotes[entry.id].quotedAt), 0),
          canTrade: canTrade && entry.id !== playerId,
        }))
        .sort((a, b) => (b.quotedAt || 0) - (a.quotedAt || 0)),
      revealVotes: activeIds.filter((activePlayerId) => revealVotes[activePlayerId]),
      revealVotesNeeded: activeIds.length,
      revealRequestedByYou: Boolean(revealVotes[playerId]),
      startedAt: room.game.startedAt,
      endsAt: room.game.endsAt,
      nextRevealAt: room.game.nextRevealAt,
      countdownStartedAt: room.game.countdownStartedAt,
      countdownEndsAt: room.game.countdownEndsAt,
      msRemaining: room.game.endsAt ? Math.max(room.game.endsAt - now, 0) : null,
      msUntilNextReveal:
        room.status === ROOM_STATUS.LIVE && room.game.nextRevealAt ? Math.max(room.game.nextRevealAt - now, 0) : null,
      msUntilStart:
        room.status === ROOM_STATUS.LOBBY && room.game.countdownEndsAt ? Math.max(room.game.countdownEndsAt - now, 0) : null,
      settlement: room.game.settlement,
      log: room.game.log.slice(0, 18),
    },
  };
}
