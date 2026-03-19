const CONTRACT_TEMPLATES = [
  {
    id: "doc_chars",
    prompt: "Number of characters in a homework document",
    unitLabel: "characters",
    rangeLow: 2400,
    rangeHigh: 14800,
    maxTurns: 8,
  },
  {
    id: "doc_words",
    prompt: "Number of words in a research abstract packet",
    unitLabel: "words",
    rangeLow: 300,
    rangeHigh: 2200,
    maxTurns: 8,
  },
  {
    id: "spreadsheet_cells",
    prompt: "Non-empty cells in a budgeting spreadsheet",
    unitLabel: "cells",
    rangeLow: 140,
    rangeHigh: 2200,
    maxTurns: 8,
  },
  {
    id: "slide_deck_chars",
    prompt: "Characters across a consulting slide deck",
    unitLabel: "characters",
    rangeLow: 1800,
    rangeHigh: 12000,
    maxTurns: 8,
  },
  {
    id: "resume_chars",
    prompt: "Characters in a one-page resume",
    unitLabel: "characters",
    rangeLow: 1700,
    rangeHigh: 5600,
    maxTurns: 8,
  },
  {
    id: "form_entries",
    prompt: "Filled entries in an application form bundle",
    unitLabel: "entries",
    rangeLow: 40,
    rangeHigh: 480,
    maxTurns: 8,
  },
  {
    id: "code_lines",
    prompt: "Logical lines in a coding assignment submission",
    unitLabel: "lines",
    rangeLow: 80,
    rangeHigh: 2400,
    maxTurns: 8,
  },
  {
    id: "exam_points",
    prompt: "Total points on a midterm packet",
    unitLabel: "points",
    rangeLow: 40,
    rangeHigh: 320,
    maxTurns: 8,
  },
];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sampleContract() {
  const template = CONTRACT_TEMPLATES[randomInt(0, CONTRACT_TEMPLATES.length - 1)];
  const hiddenValue = randomInt(template.rangeLow, template.rangeHigh);
  return {
    id: crypto.randomUUID(),
    templateId: template.id,
    prompt: template.prompt,
    unitLabel: template.unitLabel,
    rangeLow: template.rangeLow,
    rangeHigh: template.rangeHigh,
    maxTurns: template.maxTurns,
    hiddenValue,
  };
}
