import { contractFromScenarioIndex, SCENARIO_COUNT } from "../workers/src/contracts.js";
import {
  MAKER_ACTIONS,
  TAKER_ACTIONS,
  fallbackMakerActionIndex,
  fallbackTakerAction,
  makerStateKey,
  pickActionFromPolicy,
  quoteFromMakerAction,
  takerStateKey,
  updateEstimateFromQuote,
  updateEstimateFromResolution,
} from "../workers/src/rl-core.js";
import { GAME_ROLE, TAKER_ACTION } from "../workers/src/protocol.js";

function ensureRow(table, key, count) {
  if (!table[key]) {
    table[key] = new Array(count).fill(0);
  }
  return table[key];
}

function ensureCountRow(table, key, count) {
  if (!table[key]) {
    table[key] = new Array(count).fill(0);
  }
  return table[key];
}

function epsilonGreedy(table, key, count, epsilon) {
  if (Math.random() < epsilon || !table[key]) {
    return Math.floor(Math.random() * count);
  }

  let bestIndex = 0;
  let bestValue = table[key][0];
  for (let index = 1; index < count; index += 1) {
    if (table[key][index] > bestValue) {
      bestValue = table[key][index];
      bestIndex = index;
    }
  }
  return bestIndex;
}

function makerProfileAction(room, estimate, profile) {
  const lastAction = room.game.lastResolution?.action || null;
  const inventory = room.game.maker.inventory;

  if (profile === "pressure") {
    if (inventory >= 2) {
      return 9;
    }
    if (inventory <= -2) {
      return 8;
    }
    return room.game.turn >= room.game.maxTurns - 1 ? 3 : 2;
  }

  if (profile === "bluff") {
    if (lastAction === TAKER_ACTION.BUY) {
      return inventory < 0 ? 9 : 4;
    }
    if (lastAction === TAKER_ACTION.SELL) {
      return inventory > 0 ? 8 : 5;
    }
    return room.game.turn <= 2 ? 6 : 3;
  }

  return fallbackMakerActionIndex(room, estimate);
}

function takerProfileAction(room, estimate, profile) {
  const fallback = fallbackTakerAction(room, estimate);
  const quote = room.game.currentQuote;
  const previous = room.game.previousQuote;

  if (!quote) {
    return TAKER_ACTION.PASS;
  }

  const width = Math.max(1, room.game.contract.rangeHigh - room.game.contract.rangeLow);
  const buyEdge = (estimate - quote.ask) / width;
  const sellEdge = (quote.bid - estimate) / width;
  const quoteMid = (quote.bid + quote.ask) / 2;
  const previousMid = previous ? (previous.bid + previous.ask) / 2 : quoteMid;
  const drift = (quoteMid - previousMid) / width;

  if (profile === "patient") {
    if (Math.max(buyEdge, sellEdge) < 0.028 && room.game.turn < room.game.maxTurns) {
      return TAKER_ACTION.PASS;
    }
    return fallback;
  }

  if (profile === "sniper") {
    if (buyEdge > 0.006) {
      return TAKER_ACTION.BUY;
    }
    if (sellEdge > 0.006) {
      return TAKER_ACTION.SELL;
    }
    return fallback;
  }

  if (profile === "bluff") {
    if (room.game.turn <= 3 && Math.max(buyEdge, sellEdge) < 0.025) {
      return TAKER_ACTION.PASS;
    }
    if (drift > 0.02 && sellEdge > -0.002) {
      return TAKER_ACTION.SELL;
    }
    if (drift < -0.02 && buyEdge > -0.002) {
      return TAKER_ACTION.BUY;
    }
    return fallback;
  }

  return fallback;
}

function sampleEpisodeStyles(episode, totalEpisodes) {
  const progress = episode / Math.max(1, totalEpisodes);
  const makerRoll = Math.random();
  const takerRoll = Math.random();

  const makerProfile =
    progress < 0.25 ? (makerRoll < 0.2 ? "pressure" : "baseline") : makerRoll < 0.16 ? "pressure" : makerRoll < 0.32 ? "bluff" : "baseline";
  const takerProfile =
    progress < 0.25
      ? takerRoll < 0.25
        ? "sniper"
        : "baseline"
      : takerRoll < 0.16
        ? "patient"
        : takerRoll < 0.32
          ? "bluff"
          : takerRoll < 0.48
            ? "sniper"
            : "baseline";

  return { makerProfile, takerProfile };
}

function mixedMakerAction(room, estimate, qMaker, countsMaker, epsilon, profile) {
  if (Math.random() < 0.26) {
    return makerProfileAction(room, estimate, profile);
  }
  if (Math.random() < 0.24) {
    return fallbackMakerActionIndex(room, estimate);
  }
  const stateKey = makerStateKey(room, estimate);
  return epsilonGreedy(qMaker, stateKey, MAKER_ACTIONS.length, epsilon) ??
    pickActionFromPolicy(qMaker, stateKey, fallbackMakerActionIndex(room, estimate), 0, countsMaker, 4);
}

function mixedTakerAction(room, estimate, qTaker, countsTaker, epsilon, profile) {
  if (Math.random() < 0.26) {
    return takerProfileAction(room, estimate, profile);
  }
  if (Math.random() < 0.24) {
    return fallbackTakerAction(room, estimate);
  }
  const stateKey = takerStateKey(room, estimate);
  const choice = epsilonGreedy(qTaker, stateKey, TAKER_ACTIONS.length, epsilon);
  return TAKER_ACTIONS[choice] || pickActionFromPolicy(qTaker, stateKey, fallbackTakerAction(room, estimate), 0, countsTaker, 4);
}

function settle(room, hiddenValue) {
  return {
    makerPnl: room.game.maker.cash + room.game.maker.inventory * hiddenValue,
    takerPnl: room.game.taker.cash + room.game.taker.inventory * hiddenValue,
  };
}

function buildRoom(contract) {
  return {
    makerId: "maker",
    takerId: "taker",
    game: {
      contract,
      turn: 1,
      maxTurns: contract.maxTurns,
      activeActor: "maker",
      currentQuote: null,
      previousQuote: null,
      lastResolution: { type: "game_started", text: "Game started." },
      maker: { cash: 0, inventory: 0 },
      taker: { cash: 0, inventory: 0 },
    },
  };
}

function applyTaker(room, action) {
  const quote = room.game.currentQuote;
  const qty = quote.size;
  const spread = quote.ask - quote.bid;
  let traded = false;

  if (action === TAKER_ACTION.BUY) {
    room.game.maker.cash += quote.ask * qty;
    room.game.maker.inventory -= qty;
    room.game.taker.cash -= quote.ask * qty;
    room.game.taker.inventory += qty;
    room.game.lastResolution = { type: "turn_resolved", action: "buy", mark: quote.ask };
    traded = true;
  } else if (action === TAKER_ACTION.SELL) {
    room.game.maker.cash -= quote.bid * qty;
    room.game.maker.inventory += qty;
    room.game.taker.cash += quote.bid * qty;
    room.game.taker.inventory -= qty;
    room.game.lastResolution = { type: "turn_resolved", action: "sell", mark: quote.bid };
    traded = true;
  } else {
    room.game.lastResolution = {
      type: "turn_resolved",
      action: "pass",
      mark: (quote.bid + quote.ask) / 2,
    };
  }

  room.game.previousQuote = quote;
  room.game.currentQuote = null;
  room.game.turn += 1;
  return { traded, spread, action };
}

function compressPolicy(table, counts, minSamples) {
  const policy = {};
  const support = {};

  for (const [stateKey, values] of Object.entries(table)) {
    const countRow = counts[stateKey] || [];
    const total = countRow.reduce((sum, value) => sum + value, 0);
    if (total < minSamples) {
      continue;
    }

    let bestIndex = 0;
    let bestValue = values[0];
    for (let index = 1; index < values.length; index += 1) {
      if (values[index] > bestValue) {
        bestValue = values[index];
        bestIndex = index;
      }
    }

    policy[stateKey] = bestIndex;
    support[stateKey] = total;
  }

  return { policy, support };
}

export function exportModule(qMaker, qTaker, countsMaker, countsTaker, metadata, minSamples = 12) {
  const maker = compressPolicy(qMaker, countsMaker, minSamples);
  const taker = compressPolicy(qTaker, countsTaker, minSamples);

  return `export const RL_POLICY = ${JSON.stringify(
    {
      metadata: {
        ...metadata,
        exportMinSamples: minSamples,
        exportedMakerStates: Object.keys(maker.policy).length,
        exportedTakerStates: Object.keys(taker.policy).length,
      },
      maker: maker.policy,
      taker: taker.policy,
      counts: {
        maker: maker.support,
        taker: taker.support,
      },
    },
    null,
    2
  )};\n`;
}

export function runEpisodes(config) {
  const qMaker = {};
  const qTaker = {};
  const countsMaker = {};
  const countsTaker = {};
  const startOffset = Number(config.startOffset || 0);
  const stride = Number(config.scenarioStride || 1);

  for (let episode = 0; episode < config.episodes; episode += 1) {
    const styles = sampleEpisodeStyles(episode, config.episodes);
    const scenarioIndex = (startOffset + episode * stride) % SCENARIO_COUNT;
    const contract = contractFromScenarioIndex(scenarioIndex);
    const width = Math.max(1, contract.rangeHigh - contract.rangeLow);
    const room = buildRoom(contract);
    let makerEstimate = contract.hiddenValue + (Math.random() * 2 - 1) * width * 0.14;
    let takerEstimate = contract.hiddenValue + (Math.random() * 2 - 1) * width * 0.14;
    const makerTrace = [];
    const takerTrace = [];
    let tradeCount = 0;
    let passCount = 0;
    let spreadSum = 0;
    const epsilon = config.epsilon * (1 - episode / Math.max(1, config.episodes));

    for (let turn = 1; turn <= contract.maxTurns; turn += 1) {
      room.game.turn = turn;

      const makerKey = makerStateKey(room, makerEstimate);
      const makerActionIndex = mixedMakerAction(room, makerEstimate, qMaker, countsMaker, epsilon, styles.makerProfile);
      const quote = quoteFromMakerAction(room, makerEstimate, makerActionIndex);
      room.game.currentQuote = quote;
      room.game.lastResolution = { type: "quote_submitted", text: "maker quote" };
      makerTrace.push([makerKey, makerActionIndex]);

      takerEstimate = updateEstimateFromQuote(room, GAME_ROLE.TAKER, takerEstimate);
      const takerKey = takerStateKey(room, takerEstimate);
      const takerAction = mixedTakerAction(room, takerEstimate, qTaker, countsTaker, epsilon, styles.takerProfile);
      const takerActionIndex = TAKER_ACTIONS.indexOf(takerAction);
      takerTrace.push([takerKey, Math.max(0, takerActionIndex)]);

      const outcome = applyTaker(room, takerAction);
      makerEstimate = updateEstimateFromResolution(room, GAME_ROLE.MAKER, makerEstimate);
      spreadSum += outcome.spread / width;
      if (outcome.traded) {
        tradeCount += 1;
      } else if (outcome.action === TAKER_ACTION.PASS) {
        passCount += 1;
      }
    }

    const { makerPnl, takerPnl } = settle(room, contract.hiddenValue);
    const makerInventoryPenalty = Math.abs(room.game.maker.inventory) * 0.02;
    const takerInventoryPenalty = Math.abs(room.game.taker.inventory) * 0.02;
    const tradeBonus = tradeCount / Math.max(1, contract.maxTurns);
    const passPenalty = passCount / Math.max(1, contract.maxTurns);
    const spreadPenalty = spreadSum / Math.max(1, contract.maxTurns);
    const makerReward = makerPnl / width - makerInventoryPenalty + 0.02 * tradeBonus - 0.03 * spreadPenalty;
    const takerReward = takerPnl / width - takerInventoryPenalty - 0.05 * passPenalty;

    makerTrace.forEach(([key, index]) => {
      const row = ensureRow(qMaker, key, MAKER_ACTIONS.length);
      const counts = ensureCountRow(countsMaker, key, MAKER_ACTIONS.length);
      counts[index] += 1;
      row[index] += config.alpha * (makerReward - row[index]);
    });

    takerTrace.forEach(([key, index]) => {
      const row = ensureRow(qTaker, key, TAKER_ACTIONS.length);
      const counts = ensureCountRow(countsTaker, key, TAKER_ACTIONS.length);
      counts[index] += 1;
      row[index] += config.alpha * (takerReward - row[index]);
    });
  }

  return {
    qMaker,
    qTaker,
    countsMaker,
    countsTaker,
  };
}

export function mergeShardOutputs(outputs) {
  const maker = {};
  const taker = {};
  const countsMaker = {};
  const countsTaker = {};

  function mergeSide(target, targetCounts, shardTable, shardCounts) {
    for (const [stateKey, values] of Object.entries(shardTable)) {
      if (!target[stateKey]) {
        target[stateKey] = new Array(values.length).fill(0);
        targetCounts[stateKey] = new Array(values.length).fill(0);
      }

      const counts = shardCounts[stateKey] || new Array(values.length).fill(0);
      for (let index = 0; index < values.length; index += 1) {
        const incomingCount = counts[index] || 0;
        if (!incomingCount) {
          continue;
        }
        const existingCount = targetCounts[stateKey][index];
        const total = existingCount + incomingCount;
        target[stateKey][index] =
          total === 0 ? 0 : (target[stateKey][index] * existingCount + values[index] * incomingCount) / total;
        targetCounts[stateKey][index] = total;
      }
    }
  }

  outputs.forEach((output) => {
    mergeSide(maker, countsMaker, output.qMaker, output.countsMaker);
    mergeSide(taker, countsTaker, output.qTaker, output.countsTaker);
  });

  return {
    qMaker: maker,
    qTaker: taker,
    countsMaker,
    countsTaker,
  };
}
