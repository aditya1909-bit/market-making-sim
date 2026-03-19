const SUBJECTS = [
  { id: "homework_chars", text: "characters in a homework document", unitLabel: "characters", rangeLow: 2400, rangeHigh: 14800, maxTurns: 8 },
  { id: "research_words", text: "words in a research abstract packet", unitLabel: "words", rangeLow: 300, rangeHigh: 2200, maxTurns: 8 },
  { id: "spreadsheet_cells", text: "non-empty cells in a budgeting spreadsheet", unitLabel: "cells", rangeLow: 140, rangeHigh: 2200, maxTurns: 8 },
  { id: "slide_chars", text: "characters across a consulting slide deck", unitLabel: "characters", rangeLow: 1800, rangeHigh: 12000, maxTurns: 8 },
  { id: "resume_chars", text: "characters in a one-page resume", unitLabel: "characters", rangeLow: 1700, rangeHigh: 5600, maxTurns: 8 },
  { id: "form_entries", text: "filled entries in an application form bundle", unitLabel: "entries", rangeLow: 40, rangeHigh: 480, maxTurns: 8 },
  { id: "code_lines", text: "logical lines in a coding assignment submission", unitLabel: "lines", rangeLow: 80, rangeHigh: 2400, maxTurns: 8 },
  { id: "exam_points", text: "total points on a midterm packet", unitLabel: "points", rangeLow: 40, rangeHigh: 320, maxTurns: 8 },
  { id: "loop_people", text: "people in Chicago's Loop at 8:30 a.m.", unitLabel: "people", rangeLow: 12000, rangeHigh: 220000, maxTurns: 8 },
  { id: "park_bikes", text: "bike trips that pass through a city park in one day", unitLabel: "trips", rangeLow: 120, rangeHigh: 14000, maxTurns: 8 },
  { id: "coffee_cups", text: "coffee cups sold by a downtown kiosk on a weekday", unitLabel: "cups", rangeLow: 60, rangeHigh: 2200, maxTurns: 8 },
  { id: "airport_bags", text: "checked bags loaded onto a domestic flight bank", unitLabel: "bags", rangeLow: 200, rangeHigh: 5200, maxTurns: 8 },
  { id: "stadium_hotdogs", text: "hot dogs sold during a baseball game", unitLabel: "hot dogs", rangeLow: 600, rangeHigh: 18000, maxTurns: 8 },
  { id: "library_books", text: "books checked out from a university library in a day", unitLabel: "books", rangeLow: 50, rangeHigh: 4200, maxTurns: 8 },
  { id: "subway_entries", text: "subway station entries during the morning rush", unitLabel: "entries", rangeLow: 800, rangeHigh: 54000, maxTurns: 8 },
  { id: "warehouse_boxes", text: "boxes shipped from a regional warehouse in one shift", unitLabel: "boxes", rangeLow: 400, rangeHigh: 24000, maxTurns: 8 },
  { id: "food_orders", text: "delivery orders accepted by a neighborhood restaurant on Friday night", unitLabel: "orders", rangeLow: 40, rangeHigh: 1800, maxTurns: 8 },
  { id: "app_pushes", text: "push notifications sent by a consumer app in one hour", unitLabel: "notifications", rangeLow: 500, rangeHigh: 250000, maxTurns: 8 },
  { id: "hotel_towels", text: "clean towels used by a convention hotel in a day", unitLabel: "towels", rangeLow: 200, rangeHigh: 9000, maxTurns: 8 },
  { id: "taxi_rides", text: "taxi rides starting in Midtown during one evening", unitLabel: "rides", rangeLow: 300, rangeHigh: 18000, maxTurns: 8 },
];

const CONTEXTS = [
  { id: "typical_day", text: "on a typical weekday", scale: 1.0, turnAdjust: 0 },
  { id: "holiday_runup", text: "during a holiday run-up", scale: 1.18, turnAdjust: 0 },
  { id: "summer_lull", text: "during a summer lull", scale: 0.86, turnAdjust: 0 },
  { id: "storm_day", text: "during a storm-disrupted day", scale: 0.72, turnAdjust: 1 },
  { id: "conference_week", text: "during conference week", scale: 1.14, turnAdjust: 0 },
  { id: "month_end", text: "near month-end", scale: 1.09, turnAdjust: 0 },
  { id: "quiet_monday", text: "on a quiet Monday", scale: 0.82, turnAdjust: 0 },
  { id: "peak_friday", text: "on a peak Friday", scale: 1.16, turnAdjust: 0 },
  { id: "event_day", text: "on a major event day", scale: 1.24, turnAdjust: 1 },
  { id: "maintenance_window", text: "during a maintenance window", scale: 0.66, turnAdjust: 1 },
  { id: "open_close", text: "around the open-to-close interval", scale: 1.04, turnAdjust: 0 },
  { id: "reduced_staff", text: "with reduced staffing", scale: 0.78, turnAdjust: 0 },
  { id: "back_to_school", text: "during back-to-school season", scale: 1.12, turnAdjust: 0 },
  { id: "launch_week", text: "during launch week", scale: 1.21, turnAdjust: 1 },
  { id: "holiday_weekend", text: "on a holiday weekend", scale: 0.88, turnAdjust: 0 },
  { id: "cold_snap", text: "during a cold snap", scale: 0.81, turnAdjust: 0 },
  { id: "heat_wave", text: "during a heat wave", scale: 0.93, turnAdjust: 0 },
  { id: "sports_playoffs", text: "during playoff season", scale: 1.19, turnAdjust: 1 },
  { id: "campus_break", text: "during campus break", scale: 0.76, turnAdjust: 0 },
  { id: "tourist_peak", text: "during tourist peak season", scale: 1.17, turnAdjust: 0 },
];

const FRAMINGS = [
  { id: "estimate", prefix: "Estimated ", low: 0.94, high: 1.06, hidden: 1.0 },
  { id: "desk_guess", prefix: "Desk estimate for ", low: 0.92, high: 1.08, hidden: 1.0 },
  { id: "interview_case", prefix: "Interview case: ", low: 0.9, high: 1.1, hidden: 1.0 },
  { id: "operations_case", prefix: "Operations case: ", low: 0.9, high: 1.12, hidden: 1.0 },
  { id: "capacity_case", prefix: "Capacity estimate for ", low: 0.88, high: 1.15, hidden: 1.0 },
  { id: "footfall_case", prefix: "Footfall estimate for ", low: 0.89, high: 1.13, hidden: 1.0 },
  { id: "sizing_case", prefix: "Sizing exercise: ", low: 0.9, high: 1.1, hidden: 1.0 },
  { id: "market_sizing", prefix: "Market-sizing prompt: ", low: 0.88, high: 1.16, hidden: 1.0 },
  { id: "trading_prompt", prefix: "Trading prompt: ", low: 0.92, high: 1.08, hidden: 1.0 },
  { id: "analyst_prompt", prefix: "Analyst prompt: ", low: 0.9, high: 1.12, hidden: 1.0 },
  { id: "stress_case", prefix: "Stress-case estimate for ", low: 0.84, high: 1.18, hidden: 0.96 },
  { id: "bull_case", prefix: "High-side estimate for ", low: 0.95, high: 1.22, hidden: 1.08 },
  { id: "bear_case", prefix: "Low-side estimate for ", low: 0.78, high: 1.02, hidden: 0.9 },
  { id: "opening_line", prefix: "Opening line for ", low: 0.9, high: 1.1, hidden: 1.0 },
  { id: "reserve_guess", prefix: "Reserve estimate for ", low: 0.87, high: 1.14, hidden: 1.0 },
  { id: "range_trade", prefix: "Range trade on ", low: 0.86, high: 1.16, hidden: 1.0 },
  { id: "scenario_mid", prefix: "Scenario midpoint for ", low: 0.9, high: 1.1, hidden: 1.0 },
  { id: "event_pricing", prefix: "Event pricing case: ", low: 0.88, high: 1.14, hidden: 1.02 },
  { id: "capacity_stress", prefix: "Capacity stress test for ", low: 0.82, high: 1.2, hidden: 0.98 },
  { id: "utilization_case", prefix: "Utilization estimate for ", low: 0.88, high: 1.14, hidden: 1.0 },
  { id: "throughput_case", prefix: "Throughput estimate for ", low: 0.9, high: 1.12, hidden: 1.0 },
  { id: "coverage_case", prefix: "Coverage estimate for ", low: 0.89, high: 1.13, hidden: 1.0 },
  { id: "back_of_envelope", prefix: "Back-of-envelope estimate for ", low: 0.86, high: 1.18, hidden: 1.0 },
  { id: "hiring_case", prefix: "Hiring-round prompt: ", low: 0.9, high: 1.1, hidden: 1.0 },
  { id: "bluff_game", prefix: "Bluffing game on ", low: 0.9, high: 1.12, hidden: 1.0 },
];

export const SCENARIO_COUNT = SUBJECTS.length * CONTEXTS.length * FRAMINGS.length;

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function scenarioAt(index) {
  const normalized = ((index % SCENARIO_COUNT) + SCENARIO_COUNT) % SCENARIO_COUNT;
  const subjectIndex = normalized % SUBJECTS.length;
  const contextIndex = Math.floor(normalized / SUBJECTS.length) % CONTEXTS.length;
  const framingIndex = Math.floor(normalized / (SUBJECTS.length * CONTEXTS.length)) % FRAMINGS.length;

  const subject = SUBJECTS[subjectIndex];
  const context = CONTEXTS[contextIndex];
  const framing = FRAMINGS[framingIndex];

  const rangeLow = Math.max(1, Math.round(subject.rangeLow * context.scale * framing.low));
  const rangeHigh = Math.max(rangeLow + 2, Math.round(subject.rangeHigh * context.scale * framing.high));
  const maxTurns = clamp(subject.maxTurns + context.turnAdjust, 6, 10);

  return {
    scenarioIndex: normalized,
    templateId: `${subject.id}__${context.id}__${framing.id}`,
    prompt: `${framing.prefix}${subject.text} ${context.text}`,
    unitLabel: subject.unitLabel,
    rangeLow,
    rangeHigh,
    maxTurns,
    hiddenScale: framing.hidden,
  };
}

export function sampleScenarioIndex() {
  return randomInt(0, SCENARIO_COUNT - 1);
}

export function contractFromScenarioIndex(index) {
  const scenario = scenarioAt(index);
  const midpoint = (scenario.rangeLow + scenario.rangeHigh) / 2;
  const hiddenValue = clamp(
    Math.round(midpoint + (randomInt(-5000, 5000) / 5000) * (scenario.rangeHigh - scenario.rangeLow) * 0.32 * scenario.hiddenScale),
    scenario.rangeLow,
    scenario.rangeHigh
  );

  return {
    id: crypto.randomUUID(),
    scenarioIndex: scenario.scenarioIndex,
    templateId: scenario.templateId,
    prompt: scenario.prompt,
    unitLabel: scenario.unitLabel,
    rangeLow: scenario.rangeLow,
    rangeHigh: scenario.rangeHigh,
    maxTurns: scenario.maxTurns,
    hiddenValue,
  };
}

export function sampleContract() {
  return contractFromScenarioIndex(sampleScenarioIndex());
}
