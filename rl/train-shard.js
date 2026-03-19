import { parentPort, workerData } from "node:worker_threads";
import { runEpisodes } from "./train-lib.js";

const result = runEpisodes(workerData);
parentPort.postMessage(result);
