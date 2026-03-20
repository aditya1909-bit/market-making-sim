import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RL_POLICY } from "../workers/src/rl-policy-data.js";
import { RL_POLICY_MIN_SUPPORT } from "../workers/src/rl-policy-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    output: path.resolve(__dirname, "../workers/src/rl-policy-data.js"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--out") {
      out.output = path.resolve(process.cwd(), argv[index + 1] || out.output);
      index += 1;
    }
  }

  return out;
}

function filterTable(policyTable, supportTable, minSupport) {
  const filtered = {};
  for (const [stateKey, actionIndex] of Object.entries(policyTable || {})) {
    if (Number(supportTable?.[stateKey] || 0) < minSupport) {
      continue;
    }
    filtered[stateKey] = actionIndex;
  }
  return filtered;
}

function buildCompactPolicy() {
  const maker = filterTable(RL_POLICY.maker, RL_POLICY.counts?.maker, RL_POLICY_MIN_SUPPORT.maker);
  const takerModes = filterTable(RL_POLICY.takerModes, RL_POLICY.counts?.takerModes, RL_POLICY_MIN_SUPPORT.takerModes);
  const taker = filterTable(RL_POLICY.taker, RL_POLICY.counts?.taker, RL_POLICY_MIN_SUPPORT.taker);

  return {
    metadata: {
      ...RL_POLICY.metadata,
      compactedAt: new Date().toISOString(),
      liveMinSupport: RL_POLICY_MIN_SUPPORT,
      exportedMakerStates: Object.keys(maker).length,
      exportedTakerModeStates: Object.keys(takerModes).length,
      exportedTakerStates: Object.keys(taker).length,
    },
    maker,
    takerModes,
    taker,
  };
}

function main() {
  const config = parseArgs(process.argv.slice(2));
  const compactPolicy = buildCompactPolicy();
  const output = `export const RL_POLICY=${JSON.stringify(compactPolicy)};\n`;
  fs.writeFileSync(config.output, output, "utf8");
  console.log(`Wrote compact live policy to ${config.output}`);
  console.log(`maker states: ${Object.keys(compactPolicy.maker).length}`);
  console.log(`taker mode states: ${Object.keys(compactPolicy.takerModes).length}`);
  console.log(`taker states: ${Object.keys(compactPolicy.taker).length}`);
}

main();
