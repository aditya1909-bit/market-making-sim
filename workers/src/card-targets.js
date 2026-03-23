function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function count(cards, predicate) {
  return cards.reduce((total, card) => total + (predicate(card) ? 1 : 0), 0);
}

function redCount(cards) {
  return count(cards, (card) => card.color === "red");
}

function blackCount(cards) {
  return count(cards, (card) => card.color === "black");
}

function fiveCount(cards) {
  return count(cards, (card) => card.rankValue === 5);
}

function aceCount(cards) {
  return count(cards, (card) => card.rank === "A");
}

function heartCount(cards) {
  return count(cards, (card) => card.suit === "H");
}

function spadeCount(cards) {
  return count(cards, (card) => card.suit === "S");
}

function faceCount(cards) {
  return count(cards, (card) => card.rank === "J" || card.rank === "Q" || card.rank === "K");
}

function diamondCount(cards) {
  return count(cards, (card) => card.suit === "D");
}

export const CARD_TARGETS = [
  {
    id: "log_red_minus_two_pow_fives",
    label: "ln(1 + red) - 2^(five count)",
    prompt:
      "Final score = ln(1 + total red cards) minus 2 raised to the number of 5s across every player's 2 private cards and all public table cards.",
    unitLabel: "points",
    rangeFor(totalCards) {
      const cappedCards = Math.max(0, Number(totalCards || 0));
      const maxRed = Math.min(cappedCards, 26);
      const maxFives = Math.min(cappedCards, 4);
      return {
        rangeLow: Math.log1p(0) - 2 ** maxFives,
        rangeHigh: Math.log1p(maxRed) - 1,
      };
    },
    score(cards) {
      return Math.log1p(redCount(cards)) - 2 ** fiveCount(cards);
    },
    approxContribution(card) {
      let value = 0;
      if (card.color === "red") {
        value += 0.18;
      }
      if (card.rankValue === 5) {
        value -= 4;
      }
      return value;
    },
  },
  {
    id: "sqrt_black_times_aces_minus_hearts",
    label: "sqrt(1 + black) * aces - hearts",
    prompt:
      "Final score = sqrt(1 + total black cards) times total aces, minus total hearts, across every player's 2 private cards and all public table cards.",
    unitLabel: "points",
    rangeFor(totalCards) {
      const cappedCards = Math.max(0, Number(totalCards || 0));
      const maxBlack = Math.min(cappedCards, 26);
      const maxAces = Math.min(cappedCards, 4);
      const maxHearts = Math.min(cappedCards, 13);
      return {
        rangeLow: -maxHearts,
        rangeHigh: Math.sqrt(1 + maxBlack) * maxAces,
      };
    },
    score(cards) {
      return Math.sqrt(1 + blackCount(cards)) * aceCount(cards) - heartCount(cards);
    },
    approxContribution(card) {
      let value = 0;
      if (card.color === "black") {
        value += 0.3;
      }
      if (card.rank === "A") {
        value += 2.1;
      }
      if (card.suit === "H") {
        value -= 1;
      }
      return value;
    },
  },
  {
    id: "spades_times_faces_minus_diamonds",
    label: "spades * faces - diamonds",
    prompt:
      "Final score = total spades multiplied by total face cards (J, Q, K), minus total diamonds, across every player's 2 private cards and all public table cards.",
    unitLabel: "points",
    rangeFor(totalCards) {
      const cappedCards = Math.max(0, Number(totalCards || 0));
      const maxSpades = Math.min(cappedCards, 13);
      const maxFaces = Math.min(cappedCards, 12);
      const maxDiamonds = Math.min(cappedCards, 13);
      return {
        rangeLow: -maxDiamonds,
        rangeHigh: maxSpades * maxFaces,
      };
    },
    score(cards) {
      return spadeCount(cards) * faceCount(cards) - diamondCount(cards);
    },
    approxContribution(card) {
      let value = 0;
      if (card.suit === "S") {
        value += 1.2;
      }
      if (card.rank === "J" || card.rank === "Q" || card.rank === "K") {
        value += 1.2;
      }
      if (card.suit === "D") {
        value -= 1;
      }
      return value;
    },
  },
];

export function chooseCardTarget(totalCards) {
  const target = CARD_TARGETS[Math.floor(Math.random() * CARD_TARGETS.length)];
  return {
    id: target.id,
    label: target.label,
    prompt: target.prompt,
    unitLabel: target.unitLabel,
    ...target.rangeFor(totalCards),
  };
}

export function cardTargetForId(targetId) {
  return CARD_TARGETS.find((entry) => entry.id === targetId) || CARD_TARGETS[0];
}

export function cardTargetScore(targetId, cards) {
  return cardTargetForId(targetId).score(cards);
}

export function cardTargetApproxContribution(targetId, card) {
  return cardTargetForId(targetId).approxContribution?.(card) ?? 0;
}

export function normalizedCardTargetRange(targetId, totalCards) {
  const range = cardTargetForId(targetId).rangeFor(totalCards);
  return {
    rangeLow: clamp(Number(range?.rangeLow ?? 0), -1_000_000, 1_000_000),
    rangeHigh: clamp(Number(range?.rangeHigh ?? 0), -1_000_000, 1_000_000),
  };
}
