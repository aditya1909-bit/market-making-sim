import { CARD_RL_POLICY_COMPAT_VERSION } from "./card-rl-policy-config.js";
import { cardTargetApproxContribution, cardTargetForId, cardTargetScore } from "./card-targets.js";
import { cardTradingOpen } from "./card-engine.js";
import { TAKER_ACTION } from "./protocol.js";

function buildQuoteTemplates() {
  const templates = [{ id: "noop", reservationOffset: 0, spreadScale: 0, size: 0, noop: true }];
  [-0.18, -0.12, -0.08, -0.04, 0, 0.04, 0.08, 0.12, 0.18].forEach((reservationOffset) => {
    [
      [0.75, 1],
      [1.0, 1],
      [1.15, 2],
      [1.45, 2],
    ].forEach(([spreadScale, size]) => {
      const side = reservationOffset < -0.005 ? "buy" : reservationOffset > 0.005 ? "sell" : "mid";
      const offsetLabel = String(Math.round(Math.abs(reservationOffset) * 100)).padStart(2, "0");
      const spreadLabel = String(Math.round(spreadScale * 100)).padStart(3, "0");
      templates.push({
        id: `${side}_${offsetLabel}_${spreadLabel}_${size}`,
        reservationOffset,
        spreadScale,
        size,
      });
    });
  });
  templates.push({ id: "panic_buy_3", reservationOffset: -0.24, spreadScale: 1.8, size: 3 });
  templates.push({ id: "panic_sell_3", reservationOffset: 0.24, spreadScale: 1.8, size: 3 });
  templates.push({ id: "inventory_buy_4", reservationOffset: -0.3, spreadScale: 1.9, size: 4 });
  templates.push({ id: "inventory_sell_4", reservationOffset: 0.3, spreadScale: 1.9, size: 4 });
  return templates;
}

export const CARD_QUOTE_TEMPLATES = buildQuoteTemplates();
export const CARD_INTENT_LABELS = ["take", "quote", "reveal", "wait"];

const MAX_QUOTE_SIZE = 5;
const TOTAL_BOARD_CARDS = 5;
const PRIVATE_CARDS_PER_PLAYER = 2;
const POSTERIOR_SAMPLE_COUNT = 96;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function tanh(value) {
  return Math.tanh(value);
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
  const totalCardsInPlay = seatCount * PRIVATE_CARDS_PER_PLAYER + (room.game.boardCards?.length || TOTAL_BOARD_CARDS);
  const knownCount = (room.game.privateHands?.[playerId] || []).length + (room.game.revealedBoardCount || 0);
  return Math.max(0, totalCardsInPlay - knownCount);
}

function cardContribution(targetId, card) {
  return cardTargetApproxContribution(targetId, card);
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
  const targetId = room.game.targetScorerId || room.game.target?.id || cardTargetForId(null).id;
  const privateHand = room.game.privateHands?.[playerId] || [];
  const visibleBoard = (room.game.boardCards || []).slice(0, room.game.revealedBoardCount || 0);
  const knownCards = privateHand.concat(visibleBoard);
  const knownScore = cardTargetScore(targetId, knownCards);
  const remaining = remainingDeck(room, playerId);
  const unknownCount = Math.min(countUnknownCards(room, playerId), remaining.length);
  const rangeLow = Number(room.game.rangeLow ?? room.game.contract?.rangeLow ?? -10);
  const rangeHigh = Number(room.game.rangeHigh ?? room.game.contract?.rangeHigh ?? 10);
  const width = Math.max(1, rangeHigh - rangeLow);
  const privateMix = contributionRatios(privateHand, targetId);
  const boardMix = contributionRatios(visibleBoard, targetId);
  let mean = knownScore;
  let stdev = 0;

  if (unknownCount > 0) {
    const outcomes = [];
    const sampleCount = Math.min(POSTERIOR_SAMPLE_COUNT, Math.max(24, remaining.length * 2));
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const pool = [...remaining];
      for (let index = 0; index < unknownCount; index += 1) {
        const pickIndex = index + Math.floor(Math.random() * (pool.length - index));
        const current = pool[index];
        pool[index] = pool[pickIndex];
        pool[pickIndex] = current;
      }
      outcomes.push(cardTargetScore(targetId, knownCards.concat(pool.slice(0, unknownCount))));
    }
    mean = outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length;
    const variance = outcomes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, outcomes.length);
    stdev = Math.sqrt(Math.max(variance, 0));
  }

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

export function publicPosteriorStats(room) {
  const targetId = room.game.targetScorerId || room.game.target?.id || cardTargetForId(null).id;
  const visibleBoard = (room.game.boardCards || []).slice(0, room.game.revealedBoardCount || 0);
  const knownScore = cardTargetScore(targetId, visibleBoard);
  const excluded = new Set(visibleBoard.map((card) => card.id));
  const remaining = buildDeck().filter((card) => !excluded.has(card.id));
  const seatCount = (room.game.activeSeatIds || []).length;
  const totalCardsInPlay = seatCount * PRIVATE_CARDS_PER_PLAYER + (room.game.boardCards?.length || TOTAL_BOARD_CARDS);
  const unknownCount = Math.max(0, totalCardsInPlay - (room.game.revealedBoardCount || 0));
  const rangeLow = Number(room.game.rangeLow ?? room.game.contract?.rangeLow ?? -10);
  const rangeHigh = Number(room.game.rangeHigh ?? room.game.contract?.rangeHigh ?? 10);
  const width = Math.max(1, rangeHigh - rangeLow);
  const boardMix = contributionRatios(visibleBoard, targetId);
  let mean = knownScore;
  let stdev = 0;

  if (unknownCount > 0 && remaining.length) {
    const values = remaining.map((card) => cardTargetScore(targetId, [card]));
    const populationMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const populationVariance = values.reduce((sum, value) => sum + (value - populationMean) ** 2, 0) / Math.max(1, values.length);
    mean = knownScore + unknownCount * populationMean;
    stdev = Math.sqrt(
      Math.max(
        0,
        values.length > 1 ? unknownCount * ((values.length - unknownCount) / (values.length - 1)) * populationVariance : 0
      )
    );
  }

  return {
    targetId,
    mean,
    stdev,
    width,
    rangeLow,
    rangeHigh,
    knownScore,
    unknownCount,
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
  const publicStats = publicPosteriorStats(room);
  const position = room.game.positions?.[playerId] || { cash: 0, inventory: 0 };
  const quotes = liveQuoteEntries(room, playerId, now);
  const rangeMid = (stats.rangeLow + stats.rangeHigh) / 2;
  const ownQuote = room.game.liveQuotes?.[playerId] || null;
  const ownMid = midpoint(ownQuote);
  const ownSpread = ownQuote ? Number(ownQuote.ask) - Number(ownQuote.bid) : 0;
  const bestBid = quotes.length ? Math.max(...quotes.map((entry) => Number(entry.quote.bid))) : rangeMid;
  const bestAsk = quotes.length ? Math.min(...quotes.map((entry) => Number(entry.quote.ask))) : rangeMid;
  const bestQuoteAge = quotes.length ? Math.max(...quotes.map((entry) => entry.ageMs / 25_000)) : 0;
  const hasPublicMark =
    quotes.length > 0 ||
    Boolean(ownQuote) ||
    (room.game.log || []).some((entry) => entry?.type === "quote" || entry?.type === "buy" || entry?.type === "sell");
  const lastMark = hasPublicMark ? Number(room.game.lastMark ?? rangeMid) : rangeMid;
  const privateScore = cardTargetScore(stats.targetId, room.game.privateHands?.[playerId] || []);
  const visibleBoard = (room.game.boardCards || []).slice(0, room.game.revealedBoardCount || 0);
  const boardScore = cardTargetScore(stats.targetId, visibleBoard);
  return {
    stats,
    publicStats,
    position,
    quotes,
    ownQuote,
    lastMark,
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
      clamp(stats.knownScore / stats.width, -2, 2),
      clamp(privateScore / stats.width, -2, 2),
      clamp(boardScore / stats.width, -2, 2),
      clamp((stats.mean - bestBid) / stats.width, -2, 2),
      clamp((bestAsk - stats.mean) / stats.width, -2, 2),
      !quotes.length || stats.mean >= bestBid ? 1 : 0,
      !quotes.length || stats.mean <= bestAsk ? 1 : 0,
      clamp(bestQuoteAge, 0, 2),
    ],
    ownQuoteAgeRatio: ownQuote ? clamp((now - Number(ownQuote.quotedAt || now)) / 25_000, 0, 2) : 0,
    ownQuoteRefreshAllowed:
      !ownQuote || Number(ownQuote.size || 0) < Number(ownQuote.initialSize || ownQuote.size || 0),
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

export function quoteFromTemplate(room, playerId, template, now = Date.now(), options = {}) {
  if (!template || template.noop) {
    return null;
  }
  const base = baseFeatureVector(room, playerId, now);
  if (base.ownQuote && !base.ownQuoteRefreshAllowed) {
    return null;
  }
  const stats = base.publicStats;
  const inventory = Number(base.position.inventory || 0);
  const rangeMid = (stats.rangeLow + stats.rangeHigh) / 2;
  const bestBid = base.quotes.length ? Math.max(...base.quotes.map((entry) => Number(entry.quote.bid))) : rangeMid;
  const bestAsk = base.quotes.length ? Math.min(...base.quotes.map((entry) => Number(entry.quote.ask))) : rangeMid;
  let publicFair = stats.mean;
  if (base.quotes.length) {
    publicFair = publicFair * 0.88 + ((bestBid + bestAsk) / 2) * 0.12;
  }
  if (base.quotes.length || Math.abs(base.lastMark - rangeMid) > 0.01) {
    publicFair = publicFair * 0.9 + base.lastMark * 0.1;
  }
  const privateSkewScale = clamp(Number(options.privateSkewScale ?? 0.5), 0, 1);
  const privateSkew = clamp(base.stats.mean - stats.mean, -0.16 * stats.width, 0.16 * stats.width) * privateSkewScale;
  const reservation =
    publicFair + privateSkew + Number(template.reservationOffset || 0) * stats.width * 0.68 - inventory * stats.width * 0.04;
  const baseHalfSpread = Math.max(0.18, stats.stdev * (0.45 + Number(template.spreadScale || 1) * 0.38));
  const competitionSpread = base.quotes.length
    ? Math.max(0.08, Math.min(...base.quotes.map((entry) => Number(entry.quote.ask) - Number(entry.quote.bid))) * 0.3)
    : 0.28;
  const halfSpread = Math.max(baseHalfSpread, competitionSpread);
  let bid = clamp(round2(reservation - halfSpread), stats.rangeLow, stats.rangeHigh - 0.01);
  let ask = clamp(round2(Math.max(reservation + halfSpread, bid + 0.01)), bid + 0.01, stats.rangeHigh);
  const competitive = Number(template.spreadScale || 1) <= 1.15 && Math.abs(Number(template.reservationOffset || 0)) <= 0.12;
  if (competitive && base.quotes.length) {
    const bestBid = Math.max(...base.quotes.map((entry) => Number(entry.quote.bid)));
    const bestAsk = Math.min(...base.quotes.map((entry) => Number(entry.quote.ask)));
    if (reservation >= bestBid) {
      bid = Math.min(ask - 0.01, Math.max(bid, round2(bestBid + 0.01)));
    }
    if (reservation <= bestAsk) {
      ask = Math.max(bid + 0.01, Math.min(ask, round2(bestAsk - 0.01)));
    }
  }
  return {
    bid,
    ask,
    size: clamp(Number(template.size || 1), 1, MAX_QUOTE_SIZE),
  };
}

export function heuristicCardBotDecision(room, playerId, now = Date.now()) {
  if (!cardTradingOpen(room, now)) {
    return {
      type: "wait",
      payload: {},
      debug: {
        source: "heuristic",
        reason: "calculation_phase",
      },
    };
  }
  const base = baseFeatureVector(room, playerId, now);
  const stats = base.stats;
  const liveQuotes = base.quotes;
  const revealProgress = room.game.revealedBoardCount || 0;
  const boardTotal = room.game.boardCards?.length || TOTAL_BOARD_CARDS;
  const seatRatio = clamp((room.game.activeSeatIds?.length || 0) / 10, 0, 1);
  const revealReady =
    revealProgress < boardTotal &&
    !room.game.revealVotes?.[playerId] &&
    (seatRatio >= 0.8 ? revealProgress >= boardTotal - 1 || (liveQuotes.length === 0 && !base.ownQuote) : liveQuotes.length === 0 || revealProgress >= boardTotal - 1);

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

  const quoteThreshold =
    0.012 +
    clamp((base.stats.stdev / base.stats.width) * 0.03, 0, 0.06) -
    clamp((room.game.activeSeatIds?.length || 0) / 10, 0, 1) * 0.006;
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
    (base.ownQuoteRefreshAllowed && (quoteAgeRatio > 0.55 || Math.abs(base.ownMidBias) > 0.05));

  if (needQuoteRefresh) {
    const privateBias = clamp((base.stats.mean - base.publicStats.mean) / base.stats.width, -0.35, 0.35);
    const skewScale = 0.35 + seatRatio * 0.45;
    const template =
      Math.abs(base.values[2]) > 0.55
        ? base.values[2] > 0
          ? CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "buy_18_100_1")
          : CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "sell_18_100_1")
        : privateBias >= 0.12
          ? CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "sell_18_075_1")
          : privateBias >= 0.06
            ? CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "sell_12_075_1")
            : privateBias <= -0.12
              ? CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "buy_18_075_1")
              : privateBias <= -0.06
                ? CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "buy_12_075_1")
                : seatRatio >= 0.8
                  ? CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "mid_00_075_1")
                  : base.values[1] > 0.18
                  ? CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "mid_00_115_2")
                  : liveQuotes.length > 2
                    ? CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "mid_00_075_1")
                    : CARD_QUOTE_TEMPLATES.find((entry) => entry.id === "mid_00_100_1");
    return {
      type: "submit_quote",
      payload: quoteFromTemplate(room, playerId, template, now, { privateSkewScale: skewScale }),
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
  const bestQuoteAgeRatio = base.quotes.length ? Math.max(...base.quotes.map((entry) => clamp(entry.ageMs / 25_000, 0, 2))) : 0;
  return Math.max(0.012, 0.018 + seatRatio * 0.009 + uncertaintyRatio * 0.028 - revealRatio * 0.012 - bestQuoteAgeRatio * 0.016);
}

function opportunisticTakeThreshold(base) {
  const seatRatio = Number(base.values?.[4] || 0);
  const uncertaintyRatio = Number(base.values?.[1] || 0);
  const bestQuoteAgeRatio = base.quotes.length ? Math.max(...base.quotes.map((entry) => clamp(entry.ageMs / 25_000, 0, 2))) : 0;
  return Math.max(0.006, 0.009 + seatRatio * 0.004 + uncertaintyRatio * 0.014 - bestQuoteAgeRatio * 0.014);
}

function encodeNeuralBase(model, base) {
  const hiddenSize = Number(model?.hiddenSize || model?.trunk?.weights?.length || 0);
  const hidden = [];
  const preactivations = [];
  for (let index = 0; index < hiddenSize; index += 1) {
    const weights = model?.trunk?.weights?.[index] || [];
    const bias = Number(model?.trunk?.bias?.[index] || 0);
    const preactivation = dot(weights, base.values) + bias;
    preactivations.push(preactivation);
    hidden.push(tanh(preactivation));
  }
  return { hidden, preactivations };
}

function chooseIntentFromModel(base, model, encoded = null) {
  const labels = model?.intentHead?.labels || CARD_INTENT_LABELS;
  const input = model?.modelType === "neural_mlp" ? encoded?.hidden || [] : base.values;
  const logits = (model?.intentHead?.weights || []).map((weights, index) => dot(weights, input) + Number(model?.intentHead?.bias?.[index] || 0));
  if (!logits.length) {
    return { intent: "quote", score: 0 };
  }
  const bestIndex = logits.reduce((best, value, index, all) => (value > all[best] ? index : best), 0);
  return {
    intent: labels[bestIndex] || CARD_INTENT_LABELS[bestIndex] || "quote",
    score: logits[bestIndex],
  };
}

function chooseQuoteFromModel(room, playerId, model, now, base = null, encoded = null) {
  const resolvedBase = base || baseFeatureVector(room, playerId, now);
  const templates = Array.isArray(model?.quoteTemplates) && model.quoteTemplates.length ? model.quoteTemplates : CARD_QUOTE_TEMPLATES;
  let bestTemplate = templates[0];
  let bestScore = -Infinity;
  templates.forEach((template, index) => {
    const features = quoteTemplateFeatures(resolvedBase, template);
    const bias = Number(model?.quoteHead?.bias?.[index] || 0);
    const score =
      model?.modelType === "neural_mlp"
        ? dot(model?.quoteHead?.stateWeights?.[index] || [], encoded?.hidden || []) +
          dot(model?.quoteHead?.templateWeights?.[index] || [], features.slice(resolvedBase.values.length)) +
          bias
        : dot(model?.quoteHead?.weights?.[index] || [], features) + bias;
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

function chooseTakeFromModel(room, playerId, model, now, base = null, encoded = null) {
  const resolvedBase = base || baseFeatureVector(room, playerId, now);
  const entries = liveQuoteEntries(room, playerId, now);
  const passInput = model?.modelType === "neural_mlp" ? encoded?.hidden || [] : resolvedBase.values;
  const passScore = dot(model?.takeHead?.passWeights || [], passInput) + Number(model?.takeHead?.passBias || 0);
  let best = {
    targetPlayerId: null,
    action: null,
    score: passScore,
    pass: true,
  };

  entries.forEach((entry) => {
    const features = takeCandidateFeatures(resolvedBase, entry);
    const candidateScore =
      model?.modelType === "neural_mlp"
        ? dot(model?.takeHead?.candidateStateWeights || [], encoded?.hidden || []) +
          dot(model?.takeHead?.candidateExtraWeights || [], features.slice(resolvedBase.values.length)) +
          Number(model?.takeHead?.candidateBias || 0)
        : dot(model?.takeHead?.candidateWeights || [], features) + Number(model?.takeHead?.candidateBias || 0);
    const buyEdge = (resolvedBase.stats.mean - Number(entry.quote.ask)) / resolvedBase.stats.width;
    const sellEdge = (Number(entry.quote.bid) - resolvedBase.stats.mean) / resolvedBase.stats.width;
    const action = buyEdge >= sellEdge ? TAKER_ACTION.BUY : TAKER_ACTION.SELL;
    if (candidateScore > best.score) {
      best = {
        targetPlayerId: entry.targetPlayerId,
        action,
        score: candidateScore,
        pass: false,
      };
    }
  });

  return best;
}

function chooseRevealFromModel(room, playerId, model, now, base = null, encoded = null) {
  const resolvedBase = base || baseFeatureVector(room, playerId, now);
  const input = model?.modelType === "neural_mlp" ? encoded?.hidden || [] : resolvedBase.values;
  const probability = sigmoid(dot(model?.revealHead?.weights || [], input) + Number(model?.revealHead?.bias || 0));
  return {
    probability,
    vote: probability >= 0.5,
  };
}

export function isCompatibleCardPolicy(policy) {
  return (
    Boolean(policy?.model) &&
    Number(policy?.compatibilityVersion || policy?.metadata?.compatibilityVersion || policy?.model?.compatibilityVersion || 0) ===
      CARD_RL_POLICY_COMPAT_VERSION
  );
}

export function policyVersionLabel(policy) {
  return (
    policy?.id ||
    policy?.version ||
    policy?.metadata?.version ||
    policy?.metadata?.policyVersion ||
    policy?.metadata?.generatedAt ||
    policy?.metadata?.loadedFrom ||
    "heuristic"
  );
}

export function chooseCardBotDecision(room, playerId, policy, now = Date.now()) {
  if (!cardTradingOpen(room, now)) {
    return {
      type: "wait",
      payload: {},
      debug: {
        source: isCompatibleCardPolicy(policy) ? "policy" : "heuristic",
        reason: "calculation_phase",
      },
    };
  }
  if (!isCompatibleCardPolicy(policy)) {
    return heuristicCardBotDecision(room, playerId, now);
  }

  const base = baseFeatureVector(room, playerId, now);
  const encoded = policy?.model?.modelType === "neural_mlp" ? encodeNeuralBase(policy.model, base) : null;
  const heuristicTake = strongestTakeOpportunity(base);
  const intentChoice = chooseIntentFromModel(base, policy.model, encoded);
  const takeChoice = chooseTakeFromModel(room, playerId, policy.model, now, base, encoded);
  const quoteChoice = chooseQuoteFromModel(room, playerId, policy.model, now, base, encoded);
  const revealChoice = chooseRevealFromModel(room, playerId, policy.model, now, base, encoded);
  const preferredTakeEdge = heuristicTake?.edge ?? -Infinity;
  const shouldForceTake =
    heuristicTake &&
    heuristicTake.edge >= strongTakeThreshold(base) &&
    (takeChoice.pass || takeChoice.score >= quoteChoice.score - 0.16);
  const shouldPreferTake =
    heuristicTake &&
    heuristicTake.edge >= opportunisticTakeThreshold(base) &&
    (!takeChoice.pass || intentChoice.intent === "take");

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

  if (shouldPreferTake) {
    return {
      type: "taker_action",
      payload: {
        targetPlayerId: takeChoice.pass ? heuristicTake.entry.targetPlayerId : takeChoice.targetPlayerId,
        action: takeChoice.pass ? heuristicTake.action : takeChoice.action,
      },
      debug: {
        source: "policy",
        reason: "preferred_take_edge",
        edge: round2(preferredTakeEdge),
        score: round2(takeChoice.score),
      },
    };
  }

  if (intentChoice.intent === "take" && !takeChoice.pass && preferredTakeEdge >= opportunisticTakeThreshold(base)) {
    return {
      type: "taker_action",
      payload: {
        targetPlayerId: takeChoice.targetPlayerId,
        action: takeChoice.action,
      },
      debug: {
        source: "policy",
        reason: "intent_take",
        score: round2(takeChoice.score),
      },
    };
  }

  if (intentChoice.intent === "quote" && quoteChoice.payload) {
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

  if (intentChoice.intent === "reveal" && revealChoice.vote && !room.game.revealVotes?.[playerId]) {
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

  if (!takeChoice.pass && preferredTakeEdge >= opportunisticTakeThreshold(base) && takeChoice.score >= quoteChoice.score + 0.02) {
    return {
      type: "taker_action",
      payload: {
        targetPlayerId: takeChoice.targetPlayerId,
        action: takeChoice.action,
      },
      debug: {
        source: "policy",
        reason: "fallback_take",
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
        reason: "fallback_quote",
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
        reason: "fallback_reveal",
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
