import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RL_POLICY } from "../workers/src/rl-policy-data.js";
import { RL_POLICY_KV_BINDING, RL_POLICY_KV_KEYS } from "../workers/src/rl-policy-kv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workersDir = path.resolve(__dirname, "../workers");

function parseArgs(argv) {
  const out = {
    binding: RL_POLICY_KV_BINDING,
    outputDir: path.resolve(os.tmpdir(), "market-making-sim-rl-policy-kv"),
    apply: false,
    preview: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--binding") {
      out.binding = String(argv[index + 1] || out.binding);
      index += 1;
    } else if (token === "--out-dir") {
      out.outputDir = path.resolve(process.cwd(), argv[index + 1] || out.outputDir);
      index += 1;
    } else if (token === "--apply") {
      out.apply = true;
    } else if (token === "--preview") {
      out.preview = true;
    }
  }

  return out;
}

function writeJson(filePath, value) {
  const text = JSON.stringify(value);
  fs.writeFileSync(filePath, text, "utf8");
  return Buffer.byteLength(text);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KiB`;
  }
  return `${bytes} B`;
}

function buildEntries(outputDir) {
  return [
    {
      key: RL_POLICY_KV_KEYS.metadata,
      file: path.join(outputDir, "policy-metadata.json"),
      value: RL_POLICY.metadata,
    },
    {
      key: RL_POLICY_KV_KEYS.maker,
      file: path.join(outputDir, "policy-maker.json"),
      value: RL_POLICY.maker,
    },
    {
      key: RL_POLICY_KV_KEYS.takerModes,
      file: path.join(outputDir, "policy-taker-modes.json"),
      value: RL_POLICY.takerModes,
    },
    {
      key: RL_POLICY_KV_KEYS.taker,
      file: path.join(outputDir, "policy-taker.json"),
      value: RL_POLICY.taker,
    },
  ];
}

function uploadEntries(entries, binding, preview) {
  entries.forEach((entry) => {
    const args = [
      "wrangler",
      "kv",
      "key",
      "put",
      entry.key,
      "--binding",
      binding,
      "--path",
      entry.file,
      "--remote",
    ];
    if (preview) {
      args.push("--preview");
    }
    execFileSync("npx", args, {
      cwd: workersDir,
      stdio: "inherit",
    });
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.outputDir, { recursive: true });

  const entries = buildEntries(options.outputDir);
  const sizes = entries.map((entry) => ({
    ...entry,
    bytes: writeJson(entry.file, entry.value),
  }));

  console.log(`Wrote KV payloads to ${options.outputDir}`);
  sizes.forEach((entry) => {
    console.log(`${entry.key}: ${formatBytes(entry.bytes)} -> ${entry.file}`);
  });

  if (!options.apply) {
    console.log("");
    console.log("Next step:");
    console.log(`cd ${workersDir}`);
    console.log("npx wrangler kv namespace create RL_POLICY_KV --binding RL_POLICY_KV --update-config");
    console.log(`node ${path.resolve(__dirname, "upload-policy-to-kv.js")} --apply${options.preview ? " --preview" : ""}`);
    return;
  }

  uploadEntries(entries, options.binding, options.preview);
  console.log("");
  console.log(`Uploaded policy entries to binding ${options.binding}${options.preview ? " (preview namespace)" : ""}.`);
}

main();
