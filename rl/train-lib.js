import { contractFromScenarioIndex, SCENARIO_COUNT } from "../workers/src/contracts.js";
import {
  MAKER_ACTIONS,
  TAKER_ACTIONS,
  TAKER_DIRECTIONAL_ACTIONS,
  TAKER_MODES,
  fallbackMakerActionIndex,
  fallbackTakerMode,
  fallbackTakerAction,
  makerStateKey,
  pickActionFromPolicy,
  quoteFromMakerAction,
  takerActionForMode,
  takerActionStateKey,
  takerModeStateKey,
  takerStateKey,
  updateEstimateFromQuote,
  updateEstimateFromResolution,
} from "../workers/src/rl-core.js";
import { RL_POLICY_MIN_SUPPORT } from "../workers/src/rl-policy-config.js";
import { GAME_ROLE, TAKER_ACTION } from "../workers/src/protocol.js";

function ensureRow(table, key, count) {
  if (!table[key]) {
    table[key] = new Array(count).fill(0);
  }
  return table[key];
}

function incrementCount(table, key) {
  table[key] = Number(table[key] || 0) + 1;
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

function takerProfileMode(room, estimate, profile) {
  const fallback = fallbackTakerMode(room, estimate);
  const quote = room.game.currentQuote;
  const previous = room.game.previousQuote;

  if (!quote) {
    return "pass";
  }

  const width = Math.max(1, room.game.contract.rangeHigh - room.game.contract.rangeLow);
  const buyEdge = (estimate - quote.ask) / width;
  const sellEdge = (quote.bid - estimate) / width;
  const quoteMid = (quote.bid + quote.ask) / 2;
  const previousMid = previous ? (previous.bid + previous.ask) / 2 : quoteMid;
  const drift = (quoteMid - previousMid) / width;

  if (profile === "patient") {
    if (Math.max(buyEdge, sellEdge) < 0.028 && room.game.turn < room.game.maxTurns) {
      return "pass";
    }
    return "take";
  }

  if (profile === "sniper") {
    if (buyEdge > 0.006 || sellEdge > 0.006) {
      return "take";
    }
    return fallback;
  }

  if (profile === "bluff") {
    if (room.game.turn <= 3 && Math.max(buyEdge, sellEdge) < 0.025) {
      return "pass";
    }
    if (drift > 0.02 && sellEdge > -0.002) {
      return "probe";
    }
    if (drift < -0.02 && buyEdge > -0.002) {
      return "probe";
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

function mixedTakerMode(room, estimate, qTakerModes, countsTakerModes, epsilon, profile) {
  if (Math.random() < 0.26) {
    return takerProfileMode(room, estimate, profile);
  }
  if (Math.random() < 0.24) {
    return fallbackTakerMode(room, estimate);
  }
  const stateKey = takerModeStateKey(room, estimate);
  const choice = epsilonGreedy(qTakerModes, stateKey, TAKER_MODES.length, epsilon);
  return TAKER_MODES[choice] || pickActionFromPolicy(qTakerModes, stateKey, fallbackTakerMode(room, estimate), 0, countsTakerModes, 4);
}

function mixedTakerAction(room, estimate, mode, qTaker, countsTaker, epsilon) {
  const fallback = fallbackTakerAction(room, estimate);
  if (mode === "pass") {
    return TAKER_ACTION.PASS;
  }
  if (Math.random() < 0.2) {
    return takerActionForMode(room, estimate, mode, fallback, fallback);
  }
  const stateKey = takerActionStateKey(room, estimate, mode);
  const choice = epsilonGreedy(qTaker, stateKey, TAKER_DIRECTIONAL_ACTIONS.length, epsilon);
  const preferred =
    TAKER_DIRECTIONAL_ACTIONS[choice] ||
    pickActionFromPolicy(qTaker, stateKey, fallback === TAKER_ACTION.PASS ? TAKER_ACTION.BUY : fallback, 0, countsTaker, 4);
  return takerActionForMode(room, estimate, mode, preferred, fallback);
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
      quoteHistory: [],
      actionHistory: [],
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
  let makerEdge = 0;
  let takerEdge = 0;

  if (action === TAKER_ACTION.BUY) {
    room.game.maker.cash += quote.ask * qty;
    room.game.maker.inventory -= qty;
    room.game.taker.cash -= quote.ask * qty;
    room.game.taker.inventory += qty;
    room.game.lastResolution = { type: "turn_resolved", action: "buy", mark: quote.ask };
    traded = true;
    makerEdge = (quote.ask - room.game.contract.hiddenValue) * qty;
    takerEdge = (room.game.contract.hiddenValue - quote.ask) * qty;
  } else if (action === TAKER_ACTION.SELL) {
    room.game.maker.cash -= quote.bid * qty;
    room.game.maker.inventory += qty;
    room.game.taker.cash += quote.bid * qty;
    room.game.taker.inventory -= qty;
    room.game.lastResolution = { type: "turn_resolved", action: "sell", mark: quote.bid };
    traded = true;
    makerEdge = (room.game.contract.hiddenValue - quote.bid) * qty;
    takerEdge = (quote.bid - room.game.contract.hiddenValue) * qty;
  } else {
    room.game.lastResolution = {
      type: "turn_resolved",
      action: "pass",
      mark: (quote.bid + quote.ask) / 2,
    };
  }

  room.game.previousQuote = quote;
  room.game.currentQuote = null;
  room.game.actionHistory = [...(room.game.actionHistory || []), action].slice(-6);
  room.game.turn += 1;
  return { traded, spread, action, makerEdge, takerEdge };
}

export function compressPolicy(table, counts, minSamples) {
  const policy = {};
  const support = {};

  for (const [stateKey, values] of Object.entries(table)) {
    const total = Number(counts[stateKey] || 0);
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

export function compressShardResult(result, minSamples = 12) {
  const maker = compressPolicy(result.qMaker, result.countsMaker, minSamples);
  const takerModes = compressPolicy(result.qTakerModes, result.countsTakerModes, minSamples);
  const taker = compressPolicy(result.qTaker, result.countsTaker, minSamples);

  return {
    maker,
    takerModes,
    taker,
    rawStates: {
      maker: Object.keys(result.qMaker).length,
      takerModes: Object.keys(result.qTakerModes).length,
      taker: Object.keys(result.qTaker).length,
    },
  };
}

export function mergeCompressedShardOutputs(outputs) {
  function mergeSide(sideKey) {
    const votes = {};
    const support = {};

    outputs.forEach((output) => {
      const side = output[sideKey];
      for (const [stateKey, actionIndex] of Object.entries(side.policy || {})) {
        const stateVotes = votes[stateKey] || (votes[stateKey] = {});
        const weight = Number(side.support?.[stateKey] || 0);
        stateVotes[actionIndex] = (stateVotes[actionIndex] || 0) + weight;
        support[stateKey] = (support[stateKey] || 0) + weight;
      }
    });

    const policy = {};
    for (const [stateKey, actionVotes] of Object.entries(votes)) {
      let bestAction = null;
      let bestWeight = -Infinity;
      for (const [actionIndex, weight] of Object.entries(actionVotes)) {
        if (weight > bestWeight) {
          bestWeight = weight;
          bestAction = Number(actionIndex);
        }
      }
      policy[stateKey] = bestAction;
    }

    return { policy, support };
  }

  return {
    maker: mergeSide("maker"),
    takerModes: mergeSide("takerModes"),
    taker: mergeSide("taker"),
    rawStates: outputs.reduce(
      (acc, output) => ({
        maker: acc.maker + Number(output.rawStates?.maker || 0),
        takerModes: acc.takerModes + Number(output.rawStates?.takerModes || 0),
        taker: acc.taker + Number(output.rawStates?.taker || 0),
      }),
      { maker: 0, takerModes: 0, taker: 0 }
    ),
  };
}

function filterCompressedSide(side, minSupport) {
  const policy = {};
  const support = side?.support || {};
  for (const [stateKey, actionIndex] of Object.entries(side?.policy || {})) {
    if (Number(support[stateKey] || 0) < minSupport) {
      continue;
    }
    policy[stateKey] = actionIndex;
  }
  return policy;
}

function exportLivePolicyObject(maker, takerModes, taker, metadata, trainingMinSamples = null, liveMinSupport = RL_POLICY_MIN_SUPPORT) {
  return {
    metadata: {
      ...metadata,
      trainingMinSamples,
      liveMinSupport,
      exportedMakerStates: Object.keys(maker).length,
      exportedTakerModeStates: Object.keys(takerModes).length,
      exportedTakerStates: Object.keys(taker).length,
    },
    maker,
    takerModes,
    taker,
  };
}

export function exportCompressedPolicy(policyBundle, metadata, liveMinSupport = RL_POLICY_MIN_SUPPORT) {
  const maker = filterCompressedSide(policyBundle.maker, liveMinSupport.maker);
  const takerModes = filterCompressedSide(policyBundle.takerModes, liveMinSupport.takerModes);
  const taker = filterCompressedSide(policyBundle.taker, liveMinSupport.taker);
  return `export const RL_POLICY=${JSON.stringify(exportLivePolicyObject(maker, takerModes, taker, metadata, null, liveMinSupport))};\n`;
}

export function exportModule(
  qMaker,
  qTakerModes,
  qTaker,
  countsMaker,
  countsTakerModes,
  countsTaker,
  metadata,
  minSamples = 12,
  liveMinSupport = RL_POLICY_MIN_SUPPORT
) {
  const maker = compressPolicy(qMaker, countsMaker, liveMinSupport.maker);
  const takerModes = compressPolicy(qTakerModes, countsTakerModes, liveMinSupport.takerModes);
  const taker = compressPolicy(qTaker, countsTaker, liveMinSupport.taker);

  return `export const RL_POLICY=${JSON.stringify(
    exportLivePolicyObject(maker.policy, takerModes.policy, taker.policy, metadata, minSamples, liveMinSupport)
  )};\n`;
}

export function runEpisodes(config) {
  const qMaker = {};
  const qTakerModes = {};
  const qTaker = {};
  const countsMaker = {};
  const countsTakerModes = {};
  const countsTaker = {};
  const startOffset = Number(config.startOffset || 0);
  const stride = Number(config.scenarioStride || 1);
  const progressEvery = Math.max(
    1,
    Number(config.progressEvery || Math.min(25000, Math.ceil(Math.max(1, config.episodes) / 100)))
  );

  for (let episode = 0; episode < config.episodes; episode += 1) {
    const styles = sampleEpisodeStyles(episode, config.episodes);
    const scenarioIndex = (startOffset + episode * stride) % SCENARIO_COUNT;
    const contract = contractFromScenarioIndex(scenarioIndex);
    const width = Math.max(1, contract.rangeHigh - contract.rangeLow);
    const room = buildRoom(contract);
    let makerEstimate = contract.hiddenValue + (Math.random() * 2 - 1) * width * 0.14;
    let takerEstimate = contract.hiddenValue + (Math.random() * 2 - 1) * width * 0.14;
    const makerTrace = [];
    const takerModeTrace = [];
    const takerTrace = [];
    let tradeCount = 0;
    let passCount = 0;
    let spreadSum = 0;
    let makerEdgeSum = 0;
    let takerEdgeSum = 0;
    const epsilon = config.epsilon * (1 - episode / Math.max(1, config.episodes));

    for (let turn = 1; turn <= contract.maxTurns; turn += 1) {
      room.game.turn = turn;

      const makerKey = makerStateKey(room, makerEstimate);
      const makerActionIndex = mixedMakerAction(room, makerEstimate, qMaker, countsMaker, epsilon, styles.makerProfile);
      const quote = quoteFromMakerAction(room, makerEstimate, makerActionIndex);
      room.game.currentQuote = quote;
      room.game.lastResolution = { type: "quote_submitted", text: "maker quote" };
      room.game.quoteHistory = [...(room.game.quoteHistory || []), quote].slice(-4);
      makerTrace.push([makerKey, makerActionIndex]);

      takerEstimate = updateEstimateFromQuote(room, GAME_ROLE.TAKER, takerEstimate);
      const takerModeKey = takerModeStateKey(room, takerEstimate);
      const takerMode = mixedTakerMode(room, takerEstimate, qTakerModes, countsTakerModes, epsilon, styles.takerProfile);
      takerModeTrace.push([takerModeKey, TAKER_MODES.indexOf(takerMode)]);
      const takerKey = takerActionStateKey(room, takerEstimate, takerMode);
      const takerAction = mixedTakerAction(room, takerEstimate, takerMode, qTaker, countsTaker, epsilon);
      const takerActionIndex = TAKER_DIRECTIONAL_ACTIONS.indexOf(takerAction);
      if (takerMode !== "pass" && takerActionIndex >= 0) {
        takerTrace.push([takerKey, takerActionIndex]);
      }

      const outcome = applyTaker(room, takerAction);
      makerEstimate = updateEstimateFromResolution(room, GAME_ROLE.MAKER, makerEstimate);
      spreadSum += outcome.spread / width;
      makerEdgeSum += outcome.makerEdge / width;
      takerEdgeSum += outcome.takerEdge / width;
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
    const makerReward =
      makerPnl / width -
      makerInventoryPenalty +
      0.06 * tradeBonus -
      0.05 * passPenalty -
      0.035 * spreadPenalty +
      0.06 * makerEdgeSum;
    const takerReward =
      takerPnl / width -
      takerInventoryPenalty -
      0.05 * passPenalty +
      0.11 * takerEdgeSum +
      0.03 * tradeBonus;

    makerTrace.forEach(([key, index]) => {
      const row = ensureRow(qMaker, key, MAKER_ACTIONS.length);
      incrementCount(countsMaker, key);
      row[index] += config.alpha * (makerReward - row[index]);
    });

    takerModeTrace.forEach(([key, index]) => {
      const row = ensureRow(qTakerModes, key, TAKER_MODES.length);
      incrementCount(countsTakerModes, key);
      row[index] += config.alpha * (takerReward - row[index]);
    });

    takerTrace.forEach(([key, index]) => {
      const row = ensureRow(qTaker, key, TAKER_DIRECTIONAL_ACTIONS.length);
      incrementCount(countsTaker, key);
      row[index] += config.alpha * (takerReward - row[index]);
    });

    if (typeof config.onProgress === "function" && ((episode + 1) % progressEvery === 0 || episode + 1 === config.episodes)) {
      config.onProgress({
        completedEpisodes: episode + 1,
        totalEpisodes: config.episodes,
        stateCounts: {
          maker: Object.keys(qMaker).length,
          takerModes: Object.keys(qTakerModes).length,
          taker: Object.keys(qTaker).length,
        },
        heapUsedMB: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
      });
    }
  }

  return {
    qMaker,
    qTakerModes,
    qTaker,
    countsMaker,
    countsTakerModes,
    countsTaker,
  };
}

export function mergeShardOutputs(outputs) {
  const maker = {};
  const takerModes = {};
  const taker = {};
  const countsMaker = {};
  const countsTakerModes = {};
  const countsTaker = {};

  function mergeSide(target, targetCounts, shardTable, shardCounts) {
    for (const [stateKey, values] of Object.entries(shardTable)) {
      if (!target[stateKey]) {
        target[stateKey] = new Array(values.length).fill(0);
        targetCounts[stateKey] = 0;
      }

      const incomingCount = Number(shardCounts[stateKey] || 0);
      if (!incomingCount) {
        continue;
      }

      const existingCount = Number(targetCounts[stateKey] || 0);
      const total = existingCount + incomingCount;
      for (let index = 0; index < values.length; index += 1) {
        target[stateKey][index] =
          total === 0 ? 0 : (target[stateKey][index] * existingCount + values[index] * incomingCount) / total;
      }
      targetCounts[stateKey] = total;
    }
  }

  outputs.forEach((output) => {
    mergeSide(maker, countsMaker, output.qMaker, output.countsMaker);
    mergeSide(takerModes, countsTakerModes, output.qTakerModes, output.countsTakerModes);
    mergeSide(taker, countsTaker, output.qTaker, output.countsTaker);
  });

  return {
    qMaker: maker,
    qTakerModes: takerModes,
    qTaker: taker,
    countsMaker,
    countsTakerModes,
    countsTaker,
  };
}
