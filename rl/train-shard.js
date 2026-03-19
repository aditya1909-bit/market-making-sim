import { parentPort, workerData } from "node:worker_threads";
import { compressShardResult, runEpisodes } from "./train-lib.js";

const result = runEpisodes({
  ...workerData,
  onProgress(progress) {
    parentPort.postMessage({
      type: "progress",
      ...progress,
    });
  },
});

parentPort.postMessage({
  type: "result",
  result: compressShardResult(result, workerData.minSamples),
});
