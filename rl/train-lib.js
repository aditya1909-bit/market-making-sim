import { contractFromScenarioIndex, SCENARIO_COUNT } from "../workers/src/contracts.js";
import { MAKER_ACTIONS, TAKER_ACTIONS, makerStateKey, quoteFromMakerAction, takerStateKey } from "../workers/src/rl-core.js";
import { TAKER_ACTION } from "../workers/src/protocol.js";

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
      lastResolution: { type: "game_started", text: "Game started." },
      maker: { cash: 0, inventory: 0 },
      taker: { cash: 0, inventory: 0 },
    },
  };
}

function applyTaker(room, action) {
  const quote = room.game.currentQuote;
  const qty = quote.size;

  if (action === TAKER_ACTION.BUY) {
    room.game.maker.cash += quote.ask * qty;
    room.game.maker.inventory -= qty;
    room.game.taker.cash -= quote.ask * qty;
    room.game.taker.inventory += qty;
    room.game.lastResolution = { type: "turn_resolved", action: "buy", mark: quote.ask };
  } else if (action === TAKER_ACTION.SELL) {
    room.game.maker.cash -= quote.bid * qty;
    room.game.maker.inventory += qty;
    room.game.taker.cash += quote.bid * qty;
    room.game.taker.inventory -= qty;
    room.game.lastResolution = { type: "turn_resolved", action: "sell", mark: quote.bid };
  } else {
    room.game.lastResolution = {
      type: "turn_resolved",
      action: "pass",
      mark: (quote.bid + quote.ask) / 2,
    };
  }

  room.game.currentQuote = null;
  room.game.turn += 1;
}

export function exportModule(qMaker, qTaker, countsMaker, countsTaker, metadata) {
  return `export const RL_POLICY = ${JSON.stringify(
    {
      metadata,
      maker: qMaker,
      taker: qTaker,
      counts: {
        maker: countsMaker,
        taker: countsTaker,
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
    const scenarioIndex = (startOffset + episode * stride) % SCENARIO_COUNT;
    const contract = contractFromScenarioIndex(scenarioIndex);
    const width = Math.max(1, contract.rangeHigh - contract.rangeLow);
    const room = buildRoom(contract);
    const makerEstimate = contract.hiddenValue + (Math.random() * 2 - 1) * width * 0.14;
    const takerEstimate = contract.hiddenValue + (Math.random() * 2 - 1) * width * 0.14;
    const makerTrace = [];
    const takerTrace = [];
    const epsilon = config.epsilon * (1 - episode / Math.max(1, config.episodes));

    for (let turn = 1; turn <= contract.maxTurns; turn += 1) {
      room.game.turn = turn;

      const makerKey = makerStateKey(room, makerEstimate);
      const makerActionIndex = epsilonGreedy(qMaker, makerKey, MAKER_ACTIONS.length, epsilon);
      const quote = quoteFromMakerAction(room, makerEstimate, makerActionIndex);
      room.game.currentQuote = quote;
      room.game.lastResolution = { type: "quote_submitted", text: "maker quote" };
      makerTrace.push([makerKey, makerActionIndex]);

      const takerKey = takerStateKey(room, takerEstimate);
      const takerActionIndex = epsilonGreedy(qTaker, takerKey, TAKER_ACTIONS.length, epsilon);
      const takerAction = TAKER_ACTIONS[takerActionIndex];
      takerTrace.push([takerKey, takerActionIndex]);

      applyTaker(room, takerAction);
    }

    const { makerPnl, takerPnl } = settle(room, contract.hiddenValue);
    const makerReward = makerPnl / width;
    const takerReward = takerPnl / width;

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
