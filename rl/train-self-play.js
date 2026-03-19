import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { SCENARIO_COUNT } from "../workers/src/contracts.js";
import { exportModule, mergeShardOutputs, runEpisodes } from "./train-lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    episodes: 20000,
    alpha: 0.08,
    epsilon: 0.18,
    workers: Math.max(1, Math.min(os.availableParallelism?.() || os.cpus().length || 1, 8)),
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
    } else if (token === "--workers") {
      out.workers = Math.max(1, Number(argv[index + 1] || out.workers));
      index += 1;
    } else if (token === "--out") {
      out.output = path.resolve(process.cwd(), argv[index + 1] || out.output);
      index += 1;
    }
  }

  return out;
}

function runWorkerShard(config, shardIndex) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./train-shard.js", import.meta.url), {
      workerData: {
        episodes: config.episodes,
        alpha: config.alpha,
        epsilon: config.epsilon,
        startOffset: shardIndex,
        scenarioStride: config.scenarioStride,
      },
    });

    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Training worker ${shardIndex} exited with code ${code}.`));
      }
    });
  });
}

async function trainParallel(config) {
  const shardEpisodes = Math.floor(config.episodes / config.workers);
  const remainder = config.episodes % config.workers;

  const shards = await Promise.all(
    Array.from({ length: config.workers }, (_, shardIndex) =>
      runWorkerShard(
        {
          alpha: config.alpha,
          epsilon: config.epsilon,
          episodes: shardEpisodes + (shardIndex < remainder ? 1 : 0),
          scenarioStride: config.workers,
        },
        shardIndex
      )
    )
  );

  return mergeShardOutputs(shards);
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const effectiveWorkers = Math.min(config.workers, Math.max(1, config.episodes));
  const result =
    effectiveWorkers === 1
      ? runEpisodes({
          episodes: config.episodes,
          alpha: config.alpha,
          epsilon: config.epsilon,
          startOffset: 0,
          scenarioStride: 1,
        })
      : await trainParallel({ ...config, workers: effectiveWorkers });

  const metadata = {
    version: 2,
    source: effectiveWorkers === 1 ? "self-play-q-learning" : "parallel-self-play-q-learning",
    episodes: config.episodes,
    workers: effectiveWorkers,
    scenarioCount: SCENARIO_COUNT,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    config.output,
    exportModule(result.qMaker, result.qTaker, result.countsMaker, result.countsTaker, metadata),
    "utf8"
  );

  console.log(`Wrote policy to ${config.output}`);
  console.log(`Workers: ${effectiveWorkers}`);
  console.log(`Scenario pool: ${SCENARIO_COUNT}`);
  console.log(`States: maker=${Object.keys(result.qMaker).length}, taker=${Object.keys(result.qTaker).length}`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
