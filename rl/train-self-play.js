import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_TEMPLATES } from "../workers/src/contracts.js";
import { MAKER_ACTIONS, TAKER_ACTIONS, makerStateKey, quoteFromMakerAction, takerStateKey } from "../workers/src/rl-core.js";
import { TAKER_ACTION } from "../workers/src/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sample(list) {
  return list[randomInt(0, list.length - 1)];
}

function makeContract() {
  const template = sample(CONTRACT_TEMPLATES);
  return {
    id: crypto.randomUUID(),
    prompt: template.prompt,
    unitLabel: template.unitLabel,
    rangeLow: template.rangeLow,
    rangeHigh: template.rangeHigh,
    maxTurns: template.maxTurns,
    hiddenValue: randomInt(template.rangeLow, template.rangeHigh),
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

function epsilonGreedy(q, stateKey, count, epsilon) {
  if (Math.random() < epsilon || !q[stateKey]) {
    return randomInt(0, count - 1);
  }
  let best = 0;
  let bestValue = q[stateKey][0];
  for (let index = 1; index < count; index += 1) {
    if (q[stateKey][index] > bestValue) {
      bestValue = q[stateKey][index];
      best = index;
    }
  }
  return best;
}

function ensureRow(table, key, count) {
  if (!table[key]) {
    table[key] = new Array(count).fill(0);
  }
  return table[key];
}

function settle(room, hiddenValue) {
  const makerPnl = room.game.maker.cash + room.game.maker.inventory * hiddenValue;
  const takerPnl = room.game.taker.cash + room.game.taker.inventory * hiddenValue;
  return { makerPnl, takerPnl };
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

function exportModule(qMaker, qTaker, episodes) {
  return `export const RL_POLICY = ${JSON.stringify(
    {
      metadata: {
        version: 1,
        source: "self-play-q-learning",
        episodes,
        generatedAt: new Date().toISOString(),
      },
      maker: qMaker,
      taker: qTaker,
    },
    null,
    2
  )};\n`;
}

function parseArgs(argv) {
  const out = {
    episodes: 20000,
    alpha: 0.08,
    epsilon: 0.18,
    output: path.resolve(__dirname, "../workers/src/rl-policy-data.js"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--episodes") {
      out.episodes = Number(argv[index + 1] || out.episodes);
      index += 1;
    } else if (token === "--alpha") {
      out.alpha = Number(argv[index + 1] || out.alpha);
      index += 1;
    } else if (token === "--epsilon") {
      out.epsilon = Number(argv[index + 1] || out.epsilon);
      index += 1;
    } else if (token === "--out") {
      out.output = path.resolve(process.cwd(), argv[index + 1] || out.output);
      index += 1;
    }
  }

  return out;
}

function train(config) {
  const qMaker = {};
  const qTaker = {};

  for (let episode = 0; episode < config.episodes; episode += 1) {
    const contract = makeContract();
    const width = Math.max(1, contract.rangeHigh - contract.rangeLow);
    const room = buildRoom(contract);
    const makerEstimate = contract.hiddenValue + (Math.random() * 2 - 1) * width * 0.14;
    const takerEstimate = contract.hiddenValue + (Math.random() * 2 - 1) * width * 0.14;
    const makerTrace = [];
    const takerTrace = [];
    const epsilon = config.epsilon * (1 - episode / config.episodes);

    for (let turn = 1; turn <= contract.maxTurns; turn += 1) {
      room.game.turn = turn;

      const makerKey = makerStateKey(room, makerEstimate);
      const makerRow = ensureRow(qMaker, makerKey, MAKER_ACTIONS.length);
      const makerActionIndex = epsilonGreedy(qMaker, makerKey, MAKER_ACTIONS.length, epsilon);
      const quote = quoteFromMakerAction(room, makerEstimate, makerActionIndex);
      room.game.currentQuote = quote;
      room.game.lastResolution = { type: "quote_submitted", text: "maker quote" };
      makerTrace.push([makerKey, makerActionIndex]);

      const takerKey = takerStateKey(room, takerEstimate);
      const takerRow = ensureRow(qTaker, takerKey, TAKER_ACTIONS.length);
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
      row[index] += config.alpha * (makerReward - row[index]);
    });

    takerTrace.forEach(([key, index]) => {
      const row = ensureRow(qTaker, key, TAKER_ACTIONS.length);
      row[index] += config.alpha * (takerReward - row[index]);
    });
  }

  return { qMaker, qTaker };
}

function main() {
  const config = parseArgs(process.argv.slice(2));
  const { qMaker, qTaker } = train(config);
  fs.writeFileSync(config.output, exportModule(qMaker, qTaker, config.episodes), "utf8");
  console.log(`Wrote policy to ${config.output}`);
  console.log(`States: maker=${Object.keys(qMaker).length}, taker=${Object.keys(qTaker).length}`);
}

main();
