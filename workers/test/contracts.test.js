import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTHORED_CONTRACT_BANK,
  SCENARIO_COUNT,
  contractFromScenarioIndex,
  scenarioAt,
} from "../src/contracts.js";

const BANNED_PHRASES = [
  "bluffing game",
  "launch week",
  "homework document",
  "research abstract packet",
  "budgeting spreadsheet",
  "consulting slide deck",
  "application form bundle",
];

test("authored contract bank has realistic metadata and sane ranges", () => {
  assert.equal(AUTHORED_CONTRACT_BANK.length, SCENARIO_COUNT);
  assert.ok(SCENARIO_COUNT >= 24);

  AUTHORED_CONTRACT_BANK.forEach((entry) => {
    assert.match(entry.templateId, /__/);
    assert.ok(entry.prompt.startsWith("Estimate "));
    assert.ok(entry.prompt.endsWith("."));
    assert.ok(entry.unitLabel.length > 0);
    assert.ok(entry.family.length > 0);
    assert.ok(entry.category.length > 0);
    assert.ok(entry.benchmarkValue > 0);
    assert.ok(entry.rangeLow > 0);
    assert.ok(entry.rangeHigh > entry.rangeLow);
    assert.ok(entry.rangeLow <= entry.benchmarkValue);
    assert.ok(entry.rangeHigh >= entry.benchmarkValue);
    assert.ok(entry.maxTurns >= 7 && entry.maxTurns <= 10);
    assert.ok(entry.sourceLabel.length > 0);
    assert.match(entry.sourceUrl, /^https?:\/\//);
    assert.equal(entry.prompt.includes("  "), false);

    const promptLower = entry.prompt.toLowerCase();
    BANNED_PHRASES.forEach((phrase) => {
      assert.equal(promptLower.includes(phrase), false);
    });
  });
});

test("scenario indexing is deterministic and wraps correctly", () => {
  const first = scenarioAt(0);
  const wrapped = scenarioAt(SCENARIO_COUNT);
  const negativeWrapped = scenarioAt(-SCENARIO_COUNT);

  assert.deepEqual(first, wrapped);
  assert.deepEqual(first, negativeWrapped);
  assert.notDeepEqual(scenarioAt(0), scenarioAt(1));
});

test("generated contracts keep the hidden value inside the authored interview band", () => {
  for (let scenarioIndex = 0; scenarioIndex < SCENARIO_COUNT; scenarioIndex += 1) {
    for (let sample = 0; sample < 12; sample += 1) {
      const contract = contractFromScenarioIndex(scenarioIndex);
      assert.ok(contract.hiddenValue >= contract.rangeLow);
      assert.ok(contract.hiddenValue <= contract.rangeHigh);
      assert.ok(contract.answerRationale.includes(String(contract.hiddenValue.toLocaleString("en-US"))));
      assert.ok(contract.answerRationale.includes(contract.sourceLabel));
    }
  }
});
