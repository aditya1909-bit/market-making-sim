import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { SCENARIO_COUNT } from "../workers/src/contracts.js";
import {
  exportCompressedPolicy,
  exportModule,
  mergeCompressedShardOutputs,
  runEpisodes,
} from "./train-lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    episodes: 20000,
    alpha: 0.08,
    epsilon: 0.18,
    minSamples: 12,
    progressEvery: 25000,
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
    } else if (token === "--min-samples") {
      out.minSamples = Math.max(1, Number(argv[index + 1] || out.minSamples));
      index += 1;
    } else if (token === "--progress-every") {
      out.progressEvery = Math.max(1, Number(argv[index + 1] || out.progressEvery));
      index += 1;
    } else if (token === "--out") {
      out.output = path.resolve(process.cwd(), argv[index + 1] || out.output);
      index += 1;
    }
  }

  return out;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function createProgressPrinter(totalEpisodes) {
  const startedAt = Date.now();
  let lastPrintedAt = 0;
  let lastLineLength = 0;

  return {
    update(completedEpisodes, force = false, stats = null) {
      const now = Date.now();
      if (!force && now - lastPrintedAt < 250) {
        return;
      }
      lastPrintedAt = now;
      const elapsedMs = now - startedAt;
      const rate = completedEpisodes > 0 ? completedEpisodes / Math.max(1, elapsedMs / 1000) : 0;
      const remainingEpisodes = Math.max(0, totalEpisodes - completedEpisodes);
      const etaMs = rate > 0 ? (remainingEpisodes / rate) * 1000 : 0;
      const percent = totalEpisodes > 0 ? (completedEpisodes / totalEpisodes) * 100 : 0;
      const line =
        `Progress ${percent.toFixed(1)}% | ${completedEpisodes}/${totalEpisodes} episodes` +
        ` | ${rate.toFixed(0)} eps/s | elapsed ${formatDuration(elapsedMs)}` +
        ` | eta ${formatDuration(etaMs)}` +
        (stats
          ? ` | states m:${stats.maker} tm:${stats.takerModes} t:${stats.taker}` +
            (stats.heapUsedMB ? ` | heap ${stats.heapUsedMB}MB` : "")
          : "");
      const padded = line.padEnd(lastLineLength, " ");
      lastLineLength = Math.max(lastLineLength, line.length);
      process.stdout.write(`\r${padded}`);
    },
    finish(completedEpisodes, stats = null) {
      this.update(completedEpisodes, true, stats);
      process.stdout.write("\n");
    },
  };
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
        progressEvery: config.progressEvery,
        minSamples: config.minSamples,
      },
    });

    worker.on("message", (message) => {
      if (message?.type === "progress") {
        config.onProgress?.(shardIndex, message);
        return;
      }
      if (message?.type === "result") {
        resolve(message.result);
      }
    });
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
  const shardProgress = new Array(config.workers).fill(0);
  const shardStats = new Array(config.workers).fill(null);
  const progress = createProgressPrinter(config.episodes);

  const shards = await Promise.all(
    Array.from({ length: config.workers }, (_, shardIndex) =>
      runWorkerShard(
        {
          alpha: config.alpha,
          epsilon: config.epsilon,
          episodes: shardEpisodes + (shardIndex < remainder ? 1 : 0),
          scenarioStride: config.workers,
          progressEvery: Math.max(1, Math.floor(config.progressEvery / Math.max(1, config.workers))),
          onProgress(progressShardIndex, message) {
            shardProgress[progressShardIndex] = message.completedEpisodes;
            shardStats[progressShardIndex] = message.stateCounts
              ? {
                  maker: message.stateCounts.maker,
                  takerModes: message.stateCounts.takerModes,
                  taker: message.stateCounts.taker,
                  heapUsedMB: message.heapUsedMB,
                }
              : null;
            const aggregateStats = shardStats.reduce(
              (acc, entry) => {
                if (!entry) {
                  return acc;
                }
                acc.maker += Number(entry.maker || 0);
                acc.takerModes += Number(entry.takerModes || 0);
                acc.taker += Number(entry.taker || 0);
                acc.heapUsedMB += Number(entry.heapUsedMB || 0);
                return acc;
              },
              { maker: 0, takerModes: 0, taker: 0, heapUsedMB: 0 }
            );
            progress.update(shardProgress.reduce((sum, value) => sum + value, 0), false, aggregateStats);
          },
        },
        shardIndex
      )
    )
  );

  const finalStats = shardStats.reduce(
    (acc, entry) => {
      if (!entry) {
        return acc;
      }
      acc.maker += Number(entry.maker || 0);
      acc.takerModes += Number(entry.takerModes || 0);
      acc.taker += Number(entry.taker || 0);
      acc.heapUsedMB += Number(entry.heapUsedMB || 0);
      return acc;
    },
    { maker: 0, takerModes: 0, taker: 0, heapUsedMB: 0 }
  );
  progress.finish(shardProgress.reduce((sum, value) => sum + value, 0), finalStats);
  return mergeCompressedShardOutputs(shards);
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const effectiveWorkers = Math.min(config.workers, Math.max(1, config.episodes));
  const progress = createProgressPrinter(config.episodes);
  const result =
    effectiveWorkers === 1
      ? runEpisodes({
          episodes: config.episodes,
          alpha: config.alpha,
          epsilon: config.epsilon,
          startOffset: 0,
          scenarioStride: 1,
          progressEvery: config.progressEvery,
          onProgress(message) {
            progress.update(message.completedEpisodes, false, {
              maker: message.stateCounts?.maker || 0,
              takerModes: message.stateCounts?.takerModes || 0,
              taker: message.stateCounts?.taker || 0,
              heapUsedMB: message.heapUsedMB || 0,
            });
          },
        })
      : await trainParallel({ ...config, workers: effectiveWorkers });

  if (effectiveWorkers === 1) {
    progress.finish(config.episodes, {
      maker: Object.keys(result.qMaker).length,
      takerModes: Object.keys(result.qTakerModes).length,
      taker: Object.keys(result.qTaker).length,
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
    });
  }

  const metadata = {
    version: 2,
    source: effectiveWorkers === 1 ? "self-play-q-learning" : "parallel-self-play-q-learning",
    episodes: config.episodes,
    workers: effectiveWorkers,
    scenarioCount: SCENARIO_COUNT,
    generatedAt: new Date().toISOString(),
  };

  const outputText =
    effectiveWorkers === 1
      ? exportModule(
          result.qMaker,
          result.qTakerModes,
          result.qTaker,
          result.countsMaker,
          result.countsTakerModes,
          result.countsTaker,
          metadata,
          config.minSamples
        )
      : exportCompressedPolicy(result, metadata);

  fs.writeFileSync(config.output, outputText, "utf8");

  console.log(`Wrote policy to ${config.output}`);
  console.log(`Workers: ${effectiveWorkers}`);
  console.log(`Scenario pool: ${SCENARIO_COUNT}`);
  if (effectiveWorkers === 1) {
    console.log(`States: maker=${Object.keys(result.qMaker).length}, taker=${Object.keys(result.qTaker).length}`);
  } else {
    console.log(
      `Shard states: maker=${result.rawStates.maker}, takerModes=${result.rawStates.takerModes}, taker=${result.rawStates.taker}`
    );
    console.log(
      `Exported states: maker=${Object.keys(result.maker.policy).length}, takerModes=${Object.keys(result.takerModes.policy).length}, taker=${Object.keys(result.taker.policy).length}`
    );
  }
  console.log(`Export min samples: ${config.minSamples}`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
