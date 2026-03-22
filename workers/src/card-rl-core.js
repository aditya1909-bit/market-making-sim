import { CARD_RL_POLICY_COMPAT_VERSION } from "./card-rl-policy-config.js";
import { TAKER_ACTION } from "./protocol.js";

export const CARD_QUOTE_TEMPLATES = [
  { id: "noop", reservationOffset: 0, spreadScale: 0, size: 0, noop: true },
  { id: "tight_buy_1", reservationOffset: -0.03, spreadScale: 0.7, size: 1 },
  { id: "tight_sell_1", reservationOffset: 0.03, spreadScale: 0.7, size: 1 },
  { id: "mid_1", reservationOffset: 0, spreadScale: 1.0, size: 1 },
  { id: "mid_2", reservationOffset: 0, spreadScale: 1.15, size: 2 },
  { id: "wide_1", reservationOffset: 0, spreadScale: 1.45, size: 1 },
  { id: "wide_2", reservationOffset: 0, spreadScale: 1.55, size: 2 },
  { id: "buy_skew_2", reservationOffset: -0.08, spreadScale: 1.0, size: 2 },
  { id: "sell_skew_2", reservationOffset: 0.08, spreadScale: 1.0, size: 2 },
  { id: "panic_buy_3", reservationOffset: -0.14, spreadScale: 1.7, size: 3 },
  { id: "panic_sell_3", reservationOffset: 0.14, spreadScale: 1.7, size: 3 },
];

const MAX_QUOTE_SIZE = 5;
const TOTAL_BOARD_CARDS = 5;
const PRIVATE_CARDS_PER_PLAYER = 2;

const TARGET_SCORERS = {
  spades_minus_red(card) {
    let value = 0;
    if (card.suit === "S") {
      value += 1;
    }
    if (card.color === "red") {
      value -= 1;
    }
    return value;
  },
  black_minus_low(card) {
    let value = 0;
    if (card.color === "black") {
      value += 1;
    }
    if (card.rankValue <= 5) {
      value -= 1;
    }
    return value;
  },
  faces_plus_aces(card) {
    return card.rank === "A" || card.rank === "J" || card.rank === "Q" || card.rank === "K" ? 1 : 0;
  },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function dot(weights, values) {
  let total = 0;
  for (let index = 0; index < Math.min(weights.length, values.length); index += 1) {
    total += Number(weights[index] || 0) * Number(values[index] || 0);
  }
  return total;
}

function midpoint(quote) {
  if (!quote) {
    return null;
  }
  return (Number(quote.bid) + Number(quote.ask)) / 2;
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
    ["S", "black"],
    ["H", "red"],
    ["D", "red"],
    ["C", "black"],
  ];
  const cards = [];
  for (const [rank, rankValue] of ranks) {
    for (const [suit, color] of suits) {
      cards.push({
        id: `1-${rank}${suit}`,
        code: `${rank}${suit}`,
        rank,
        rankValue,
        suit,
        color,
      });
    }
  }
  return cards;
}

function scorer(targetId) {
  return TARGET_SCORERS[targetId] || TARGET_SCORERS.spades_minus_red;
}

function knownCardIds(room, playerId) {
  const ids = new Set();
  const privateHand = room.game.privateHands?.[playerId] || [];
  privateHand.forEach((card) => ids.add(card.id));
  (room.game.boardCards || []).slice(0, room.game.revealedBoardCount || 0).forEach((card) => ids.add(card.id));
  return ids;
}

function remainingDeck(room, playerId) {
  const excluded = knownCardIds(room, playerId);
  return buildDeck().filter((card) => !excluded.has(card.id));
}

function countUnknownCards(room, playerId) {
  const seatCount = (room.game.activeSeatIds || []).length;
  const totalCardsInPlay = seatCount * PRIVATE_CARDS_PER_PLAYER + TOTAL_BOARD_CARDS;
  const knownCount = (room.game.privateHands?.[playerId] || []).length + (room.game.revealedBoardCount || 0);
  return Math.max(0, totalCardsInPlay - knownCount);
}

function cardContribution(targetId, card) {
  return scorer(targetId)(card);
}

function contributionRatios(cards, targetId) {
  if (!cards.length) {
    return { positive: 0, negative: 0 };
  }
  let positive = 0;
  let negative = 0;
  cards.forEach((card) => {
    const value = cardContribution(targetId, card);
    if (value > 0) {
      positive += value;
    } else if (value < 0) {
      negative += Math.abs(value);
    }
  });
  const scale = Math.max(1, cards.length);
  return {
    positive: positive / scale,
    negative: negative / scale,
  };
}

export function posteriorStats(room, playerId) {
  const targetId = room.game.targetScorerId || room.game.target?.id || "spades_minus_red";
  const privateHand = room.game.privateHands?.[playerId] || [];
  const visibleBoard = (room.game.boardCards || []).slice(0, room.game.revealedBoardCount || 0);
  const knownCards = privateHand.concat(visibleBoard);
  const knownScore = knownCards.reduce((sum, card) => sum + cardContribution(targetId, card), 0);
  const remaining = remainingDeck(room, playerId);
  const unknownCount = Math.min(countUnknownCards(room, playerId), remaining.length);
  const values = remaining.map((card) => cardContribution(targetId, card));
  const populationCount = values.length;
  const populationMean = populationCount ? values.reduce((sum, value) => sum + value, 0) / populationCount : 0;
  const populationVariance = populationCount
    ? values.reduce((sum, value) => sum + (value - populationMean) ** 2, 0) / populationCount
    : 0;
  const unknownMean = unknownCount * populationMean;
  const unknownVariance =
    populationCount > 1 ? unknownCount * ((populationCount - unknownCount) / (populationCount - 1)) * populationVariance : 0;
  const rangeLow = Number(room.game.rangeLow ?? room.game.contract?.rangeLow ?? -10);
  const rangeHigh = Number(room.game.rangeHigh ?? room.game.contract?.rangeHigh ?? 10);
  const width = Math.max(1, rangeHigh - rangeLow);
  const mean = knownScore + unknownMean;
  const stdev = Math.sqrt(Math.max(unknownVariance, 0));
  const privateMix = contributionRatios(privateHand, targetId);
  const boardMix = contributionRatios(visibleBoard, targetId);
  return {
    targetId,
    mean,
    stdev,
    width,
    rangeLow,
    rangeHigh,
    knownScore,
    unknownCount,
    privatePositiveRatio: privateMix.positive,
    privateNegativeRatio: privateMix.negative,
    boardPositiveRatio: boardMix.positive,
    boardNegativeRatio: boardMix.negative,
  };
}

function normalizeInventory(value) {
  return clamp(Number(value || 0) / 8, -1.5, 1.5);
}

export function liveQuoteEntries(room, playerId, now = Date.now()) {
  const positions = room.game.positions || {};
  return Object.entries(room.game.liveQuotes || {})
    .filter(([otherPlayerId, quote]) => otherPlayerId !== playerId && quote)
    .map(([otherPlayerId, quote]) => ({
      targetPlayerId: otherPlayerId,
      quote,
      position: positions[otherPlayerId] || { cash: 0, inventory: 0 },
      ageMs: Math.max(0, now - Number(quote.quotedAt || now)),
    }))
    .sort((a, b) => Number(b.quote.quotedAt || 0) - Number(a.quote.quotedAt || 0));
}

export function baseFeatureVector(room, playerId, now = Date.now()) {
  const stats = posteriorStats(room, playerId);
  const position = room.game.positions?.[playerId] || { cash: 0, inventory: 0 };
  const quotes = liveQuoteEntries(room, playerId, now);
  const rangeMid = (stats.rangeLow + stats.rangeHigh) / 2;
  const ownQuote = room.game.liveQuotes?.[playerId] || null;
  const ownMid = midpoint(ownQuote);
  const ownSpread = ownQuote ? Number(ownQuote.ask) - Number(ownQuote.bid) : 0;
  const bestBid = quotes.length ? Math.max(...quotes.map((entry) => Number(entry.quote.bid))) : rangeMid;
  const bestAsk = quotes.length ? Math.min(...quotes.map((entry) => Number(entry.quote.ask))) : rangeMid;
  const lastMark = Number(room.game.lastMark ?? rangeMid);
  return {
    stats,
    position,
    quotes,
    ownQuote,
    values: [
      clamp((stats.mean - rangeMid) / stats.width, -1.5, 1.5),
      clamp(stats.stdev / stats.width, 0, 1.5),
      normalizeInventory(position.inventory),
      clamp((room.game.revealedBoardCount || 0) / Math.max(1, room.game.boardCards?.length || TOTAL_BOARD_CARDS), 0, 1),
      clamp(((room.game.activeSeatIds || []).length || 0) / 10, 0, 1),
      clamp(quotes.length / 8, 0, 1),
      clamp((stats.mean - bestAsk) / stats.width, -1.5, 1.5),
      clamp((bestBid - stats.mean) / stats.width, -1.5, 1.5),
      clamp(ownSpread / stats.width, 0, 1.5),
      clamp((lastMark - rangeMid) / stats.width, -1.5, 1.5),
      clamp(stats.privatePositiveRatio, 0, 2),
      clamp(stats.privateNegativeRatio, 0, 2),
      clamp(stats.boardPositiveRatio, 0, 2),
      clamp(stats.boardNegativeRatio, 0, 2),
      clamp(stats.unknownCount / Math.max(1, (room.game.activeSeatIds || []).length * PRIVATE_CARDS_PER_PLAYER + TOTAL_BOARD_CARDS), 0, 1),
    ],
    ownQuoteAgeRatio: ownQuote ? clamp((now - Number(ownQuote.quotedAt || now)) / 25_000, 0, 2) : 0,
    ownMidBias: ownMid === null ? 0 : clamp((ownMid - stats.mean) / stats.width, -1.5, 1.5),
  };
}

function quoteTemplateFeatures(baseState, template) {
  return [
    ...baseState.values,
    clamp(Number(template.reservationOffset || 0), -2, 2),
    clamp(Number(template.spreadScale || 0), 0, 3),
    clamp(Number(template.size || 0) / MAX_QUOTE_SIZE, 0, 1),
  ];
}

function takeCandidateFeatures(baseState, entry) {
  const quote = entry.quote;
  const buyEdge = clamp((baseState.stats.mean - Number(quote.ask)) / baseState.stats.width, -2, 2);
  const sellEdge = clamp((Number(quote.bid) - baseState.stats.mean) / baseState.stats.width, -2, 2);
  return [
    ...baseState.values,
    buyEdge,
    sellEdge,
    clamp((Number(quote.ask) - Number(quote.bid)) / baseState.stats.width, 0, 2),
    clamp(Number(quote.size || 1) / MAX_QUOTE_SIZE, 0, 1),
    clamp(entry.ageMs / 25_000, 0, 2),
  ];
}

export function quoteFromTemplate(room, playerId, template, now = Date.now()) {
  if (!template || template.noop) {
    return null;
  }
  const base = baseFeatureVector(room, playerId, now);
  const stats = base.stats;
  const inventory = Number(base.position.inventory || 0);
  const reservation = stats.mean + Number(template.reservationOffset || 0) * stats.width - inventory * stats.width * 0.025;
  const baseHalfSpread = Math.max(0.35, stats.stdev * (0.8 + Number(template.spreadScale || 1) * 0.65));
  const competitionSpread = base.quotes.length
    ? Math.max(
        0.2,
        Math.min(...base.quotes.map((entry) => Number(entry.quote.ask) - Number(entry.quote.bid))) * 0.45
      )
    : 0.5;
  const halfSpread = Math.max(baseHalfSpread, competitionSpread);
  const bid = clamp(round2(reservation - halfSpread), stats.rangeLow, stats.rangeHigh - 0.01);
  const ask = clamp(round2(Math.max(reservation + halfSpread, bid + 0.01)), bid + 0.01, stats.rangeHigh);
  return {
    bid,
    ask,
    size: clamp(Number(template.size || 1), 1, MAX_QUOTE_SIZE),
  };
}

export function heuristicCardBotDecision(room, playerId, now = Date.now()) {
  const base = baseFeatureVector(room, playerId, now);
  const stats = base.stats;
  const liveQuotes = base.quotes;
  const revealProgress = room.game.revealedBoardCount || 0;
  const boardTotal = room.game.boardCards?.length || TOTAL_BOARD_CARDS;
  const revealReady =
    revealProgress < boardTotal &&
    !room.game.revealVotes?.[playerId] &&
    (base.values[1] < 0.11 || liveQuotes.length === 0 || revealProgress >= boardTotal - 1);

  let bestTake = null;
  liveQuotes.forEach((entry) => {
    const buyEdge = (stats.mean - Number(entry.quote.ask)) / stats.width;
    const sellEdge = (Number(entry.quote.bid) - stats.mean) / stats.width;
    const edge = Math.max(buyEdge, sellEdge);
    const action = buyEdge >= sellEdge ? TAKER_ACTION.BUY : TAKER_ACTION.SELL;
    if (!bestTake || edge > bestTake.edge) {
      bestTake = { entry, action, edge };
    }
  });

  const quoteThreshold = 0.04 + clamp(base.values[1] * 0.2, 0, 0.12);
  if (bestTake && bestTake.edge > quoteThreshold) {
    return {
      type: "taker_action",
      payload: {
        targetPlayerId: bestTake.entry.targetPlayerId,
        action: bestTake.action,
      },
      debug: {
        source: "heuristic",
        reason: "take_edge",
        edge: round2(bestTake.edge),
      },
    };
  }

  const ownQuote = base.ownQuote;
  const quoteAgeRatio = base.ownQuoteAgeRatio;
  const needQuoteRefresh =
    !ownQuote ||
    quoteAgeRatio > 0.72 ||
    Math.abs(base.ownMidBias) > 0.08 ||
    liveQuotes.length > 0;

  if (needQuoteRefresh) {
    const template =
      Math.abs(base.values[2]) > 0.55
        ? base.values[2] > 0
          ? CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "buy_skew_2")
          : CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "sell_skew_2")
        : base.values[1] > 0.18
          ? CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "wide_2")
          : liveQuotes.length > 2
            ? CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "mid_2")
            : CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "mid_1");
    return {
      type: "submit_quote",
      payload: quoteFromTemplate(room, playerId, template, now),
      debug: {
        source: "heuristic",
        reason: "quote_refresh",
        templateId: template?.id || "mid_1",
      },
    };
  }

  if (revealReady) {
    return {
      type: "request_next_reveal",
      payload: {},
      debug: {
        source: "heuristic",
        reason: "reveal",
      },
    };
  }

  return {
    type: "wait",
    payload: {},
    debug: {
      source: "heuristic",
      reason: "hold",
    },
  };
}

function strongestTakeOpportunity(base) {
  const stats = base.stats;
  let bestTake = null;
  base.quotes.forEach((entry) => {
    const buyEdge = (stats.mean - Number(entry.quote.ask)) / stats.width;
    const sellEdge = (Number(entry.quote.bid) - stats.mean) / stats.width;
    const edge = Math.max(buyEdge, sellEdge);
    const action = buyEdge >= sellEdge ? TAKER_ACTION.BUY : TAKER_ACTION.SELL;
    if (!bestTake || edge > bestTake.edge) {
      bestTake = { entry, action, edge };
    }
  });
  return bestTake;
}

function strongTakeThreshold(base) {
  const seatRatio = Number(base.values?.[4] || 0);
  const uncertaintyRatio = Number(base.values?.[1] || 0);
  const revealRatio = Number(base.values?.[3] || 0);
  return 0.08 + seatRatio * 0.12 + uncertaintyRatio * 0.14 - revealRatio * 0.04;
}

function chooseQuoteFromModel(room, playerId, model, now) {
  const base = baseFeatureVector(room, playerId, now);
  const templates = Array.isArray(model?.quoteTemplates) && model.quoteTemplates.length ? model.quoteTemplates : CARD_QUOTE_TEMPLATES;
  let bestTemplate = templates[0];
  let bestScore = -Infinity;
  templates.forEach((template, index) => {
    const features = quoteTemplateFeatures(base, template);
    const weights = model?.quoteHead?.weights?.[index] || [];
    const bias = Number(model?.quoteHead?.bias?.[index] || 0);
    const score = dot(weights, features) + bias;
    if (score > bestScore) {
      bestScore = score;
      bestTemplate = template;
    }
  });
  return {
    template: bestTemplate,
    score: bestScore,
    payload: quoteFromTemplate(room, playerId, bestTemplate, now),
  };
}

function chooseTakeFromModel(room, playerId, model, now) {
  const base = baseFeatureVector(room, playerId, now);
  const entries = liveQuoteEntries(room, playerId, now);
  const passScore = dot(model?.takeHead?.passWeights || [], base.values) + Number(model?.takeHead?.passBias || 0);
  let best = {
    targetPlayerId: null,
    action: null,
    score: passScore,
    pass: true,
  };

  entries.forEach((entry) => {
    const features = takeCandidateFeatures(base, entry);
    const score = dot(model?.takeHead?.candidateWeights || [], features) + Number(model?.takeHead?.candidateBias || 0);
    const buyEdge = (base.stats.mean - Number(entry.quote.ask)) / base.stats.width;
    const sellEdge = (Number(entry.quote.bid) - base.stats.mean) / base.stats.width;
    const action = buyEdge >= sellEdge ? TAKER_ACTION.BUY : TAKER_ACTION.SELL;
    if (score > best.score) {
      best = {
        targetPlayerId: entry.targetPlayerId,
        action,
        score,
        pass: false,
      };
    }
  });

  return best;
}

function chooseRevealFromModel(room, playerId, model, now) {
  const base = baseFeatureVector(room, playerId, now);
  const probability = sigmoid(dot(model?.revealHead?.weights || [], base.values) + Number(model?.revealHead?.bias || 0));
  return {
    probability,
    vote: probability >= 0.5,
  };
}

export function isCompatibleCardPolicy(policy) {
  return (
    Boolean(policy?.model) &&
    Number(policy?.metadata?.compatibilityVersion || policy?.model?.compatibilityVersion || 0) === CARD_RL_POLICY_COMPAT_VERSION
  );
}

export function policyVersionLabel(policy) {
  return (
    policy?.metadata?.version ||
    policy?.metadata?.policyVersion ||
    policy?.metadata?.generatedAt ||
    policy?.metadata?.loadedFrom ||
    "heuristic"
  );
}

export function chooseCardBotDecision(room, playerId, policy, now = Date.now()) {
  if (!isCompatibleCardPolicy(policy)) {
    return heuristicCardBotDecision(room, playerId, now);
  }

  const base = baseFeatureVector(room, playerId, now);
  const heuristicTake = strongestTakeOpportunity(base);
  const takeChoice = chooseTakeFromModel(room, playerId, policy.model, now);
  const quoteChoice = chooseQuoteFromModel(room, playerId, policy.model, now);
  const revealChoice = chooseRevealFromModel(room, playerId, policy.model, now);
  const shouldForceTake =
    heuristicTake &&
    heuristicTake.edge >= strongTakeThreshold(base) &&
    (takeChoice.pass || takeChoice.score >= quoteChoice.score - 0.08);

  if (shouldForceTake) {
    return {
      type: "taker_action",
      payload: {
        targetPlayerId: heuristicTake.entry.targetPlayerId,
        action: heuristicTake.action,
      },
      debug: {
        source: "policy",
        reason: "forced_take_edge",
        edge: round2(heuristicTake.edge),
      },
    };
  }

  if (!takeChoice.pass && takeChoice.score >= quoteChoice.score && takeChoice.score >= (revealChoice.vote ? revealChoice.probability : -Infinity)) {
    return {
      type: "taker_action",
      payload: {
        targetPlayerId: takeChoice.targetPlayerId,
        action: takeChoice.action,
      },
      debug: {
        source: "policy",
        reason: "take",
        score: round2(takeChoice.score),
      },
    };
  }

  if (quoteChoice.payload) {
    return {
      type: "submit_quote",
      payload: quoteChoice.payload,
      debug: {
        source: "policy",
        reason: "quote",
        templateId: quoteChoice.template?.id || "unknown",
        score: round2(quoteChoice.score),
      },
    };
  }

  if (revealChoice.vote && !room.game.revealVotes?.[playerId]) {
    return {
      type: "request_next_reveal",
      payload: {},
      debug: {
        source: "policy",
        reason: "reveal",
        probability: round2(revealChoice.probability),
      },
    };
  }

  return {
    type: "wait",
    payload: {},
    debug: {
      source: "policy",
      reason: "hold",
    },
  };
}
