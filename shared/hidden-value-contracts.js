const VARIANTS = Object.freeze([
  {
    id: "baseline",
    scale: 1,
    rangeScale: 2.4,
    hiddenScale: 1,
    maxTurnsAdjust: 0,
    rationale:
      "This is the middle-of-distribution version of the prompt, so the settlement should stay close to the public benchmark rather than a holiday spike or outage case.",
  },
  {
    id: "busy",
    scale: 1.12,
    rangeScale: 2.7,
    hiddenScale: 1.15,
    maxTurnsAdjust: 1,
    rationale:
      "This version is meant to feel like a busier-but-still-normal operating window, so the anchor is shaded above the public benchmark without jumping to a one-off extreme.",
  },
  {
    id: "soft",
    scale: 0.9,
    rangeScale: 2.6,
    hiddenScale: 1.1,
    maxTurnsAdjust: 0,
    rationale:
      "This version assumes a softer operating window, so the anchor is pulled below the public benchmark without turning into a shutdown or strike scenario.",
  },
]);

const BASE_CONTRACTS = Object.freeze([
  {
    id: "nyc_subway_entries",
    family: "urban_transit",
    unitLabel: "entries",
    benchmarkValue: 3_400_000,
    uncertainty: 0.09,
    maxTurns: 8,
    sourceLabel: "MTA 2024 subway and bus ridership",
    sourceUrl: "https://www.mta.info/agency/new-york-city-transit/subway-bus-ridership-2024",
    sourceSummary: "The MTA says the subway handles about 3.4 million rides on a typical 2024 weekday.",
    contexts: {
      baseline: "Estimate how many paid entries the New York City subway records on a typical weekday.",
      busy: "Estimate how many paid entries the New York City subway records on a busy but non-holiday weekday.",
      soft: "Estimate how many paid entries the New York City subway records on a softer weekday with no systemwide disruption.",
    },
  },
  {
    id: "nyc_bus_boardings",
    family: "urban_transit",
    unitLabel: "boardings",
    benchmarkValue: 1_300_000,
    uncertainty: 0.1,
    maxTurns: 8,
    sourceLabel: "MTA 2024 subway and bus ridership",
    sourceUrl: "https://www.mta.info/agency/new-york-city-transit/subway-bus-ridership-2024",
    sourceSummary: "The MTA says New York City buses handle about 1.3 million rides per day in 2024.",
    contexts: {
      baseline: "Estimate how many bus boardings New York City records on a typical weekday.",
      busy: "Estimate how many bus boardings New York City records on a busy but still normal weekday.",
      soft: "Estimate how many bus boardings New York City records on a softer weekday outside major weather or event shocks.",
    },
  },
  {
    id: "nyc_tlc_trips",
    family: "urban_mobility",
    unitLabel: "trips",
    benchmarkValue: 1_000_000,
    uncertainty: 0.13,
    maxTurns: 8,
    sourceLabel: "NYC TLC factbook summary",
    sourceUrl: "https://www.nyc.gov/site/tlc/about/tlc-celebrates-2024-driver-pay-green-rides-accessibility.page",
    sourceSummary: "NYC says TLC-licensed vehicles complete about one million trips each day.",
    contexts: {
      baseline: "Estimate how many trips TLC-licensed vehicles complete in New York City on a typical day.",
      busy: "Estimate how many trips TLC-licensed vehicles complete in New York City on a busy weekday.",
      soft: "Estimate how many trips TLC-licensed vehicles complete in New York City on a softer day with normal operations.",
    },
  },
  {
    id: "usps_packages_daily",
    family: "logistics",
    unitLabel: "packages",
    benchmarkValue: 23_900_000,
    uncertainty: 0.06,
    maxTurns: 8,
    sourceLabel: "USPS Postal Facts 2024 packages per day",
    sourceUrl: "https://facts.usps.com/packages-processed-and-delivered-each-day/",
    sourceSummary: "USPS says it processed and delivered an average of 23.9 million packages a day in 2024.",
    contexts: {
      baseline: "Estimate how many packages USPS processes and delivers on a typical day.",
      busy: "Estimate how many packages USPS processes and delivers on a heavy but non-holiday day.",
      soft: "Estimate how many packages USPS processes and delivers on a softer day outside peak shopping periods.",
    },
  },
  {
    id: "usps_mail_per_minute",
    family: "logistics",
    unitLabel: "mailpieces",
    benchmarkValue: 257_813,
    uncertainty: 0.07,
    maxTurns: 8,
    sourceLabel: "USPS Postal Facts 2024 mailpieces per minute",
    sourceUrl: "https://facts.usps.com/piece-of-mail-processed-each-second-day-in-the-life/",
    sourceSummary: "USPS says it processes about 257,813 mailpieces per minute in 2024.",
    contexts: {
      baseline: "Estimate how many mailpieces USPS processes in one average minute.",
      busy: "Estimate how many mailpieces USPS processes in one heavy but normal minute.",
      soft: "Estimate how many mailpieces USPS processes in one softer minute away from peak sorting windows.",
    },
  },
  {
    id: "usps_address_changes",
    family: "consumer_flow",
    unitLabel: "changes",
    benchmarkValue: 27_201,
    uncertainty: 0.1,
    maxTurns: 8,
    sourceLabel: "USPS Postal Facts 2024 address changes",
    sourceUrl: "https://facts.usps.com/number-of-address-changes-daily-day-in-the-life/",
    sourceSummary: "USPS says it processed 27,201 address changes per day on average in 2024.",
    contexts: {
      baseline: "Estimate how many address changes USPS processes on a typical day.",
      busy: "Estimate how many address changes USPS processes on a busier moving-season day.",
      soft: "Estimate how many address changes USPS processes on a slower day outside peak moving periods.",
    },
  },
  {
    id: "atl_passengers_daily",
    family: "air_travel",
    unitLabel: "passengers",
    benchmarkValue: 296_164,
    uncertainty: 0.08,
    maxTurns: 8,
    sourceLabel: "ATL 2024 annual traffic summary",
    sourceUrl: "https://www.atl.com/media-center/press-releases/read?id=67c038d615a7f50014d0b5f7",
    sourceSummary: "ATL reported more than 108 million passengers in 2024, which is about 296,000 per day on average.",
    contexts: {
      baseline: "Estimate how many passengers move through Atlanta's airport on a typical day.",
      busy: "Estimate how many passengers move through Atlanta's airport on a busy but still normal day.",
      soft: "Estimate how many passengers move through Atlanta's airport on a softer day outside peak travel surges.",
    },
  },
  {
    id: "atl_flights_daily",
    family: "air_travel",
    unitLabel: "flights",
    benchmarkValue: 2_181,
    uncertainty: 0.08,
    maxTurns: 8,
    sourceLabel: "ATL 2024 annual traffic summary",
    sourceUrl: "https://www.atl.com/media-center/press-releases/read?id=67c038d615a7f50014d0b5f7",
    sourceSummary: "ATL reported 796,224 takeoffs and landings in 2024, or roughly 2,181 aircraft movements per day.",
    contexts: {
      baseline: "Estimate how many takeoffs and landings Atlanta's airport handles on a typical day.",
      busy: "Estimate how many takeoffs and landings Atlanta's airport handles on a busy but normal day.",
      soft: "Estimate how many takeoffs and landings Atlanta's airport handles on a softer day with no major weather event.",
    },
  },
  {
    id: "amtrak_trips_daily",
    family: "rail_travel",
    unitLabel: "trips",
    benchmarkValue: 89_900,
    uncertainty: 0.09,
    maxTurns: 8,
    sourceLabel: "Amtrak FY2024 company profile",
    sourceUrl:
      "https://www.amtrak.com/content/dam/projects/dotcom/english/public/documents/corporate/nationalfactsheets/Amtrak-Company-Profile-FY2024-032425.pdf",
    sourceSummary: "Amtrak says riders took nearly 89,900 trips on an average day in FY2024.",
    contexts: {
      baseline: "Estimate how many passenger trips Amtrak carries on an average day.",
      busy: "Estimate how many passenger trips Amtrak carries on a busy but non-holiday day.",
      soft: "Estimate how many passenger trips Amtrak carries on a softer day outside peak leisure travel windows.",
    },
  },
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundInt(value) {
  return Math.max(1, Math.round(value));
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildScenario(base, variant, scenarioIndex) {
  const benchmarkValue = roundInt(base.benchmarkValue * variant.scale);
  const rangeRatio = clamp(base.uncertainty * variant.rangeScale, 0.18, 0.36);
  const rangeLow = roundInt(benchmarkValue * (1 - rangeRatio));
  const rangeHigh = Math.max(rangeLow + 2, roundInt(benchmarkValue * (1 + rangeRatio)));

  return Object.freeze({
    scenarioIndex,
    baseId: base.id,
    variantId: variant.id,
    templateId: `${base.id}__${variant.id}`,
    prompt: base.contexts[variant.id],
    unitLabel: base.unitLabel,
    family: base.family,
    category: base.family,
    benchmarkValue,
    benchmarkSummary: base.sourceSummary,
    sourceLabel: base.sourceLabel,
    sourceUrl: base.sourceUrl,
    rangeLow,
    rangeHigh,
    maxTurns: clamp(base.maxTurns + variant.maxTurnsAdjust, 7, 10),
    hiddenVolatility: clamp(base.uncertainty * variant.hiddenScale, 0.04, 0.18),
    variantRationale: variant.rationale,
  });
}

const SCENARIO_CATALOG = Object.freeze(
  BASE_CONTRACTS.flatMap((base) =>
    VARIANTS.map((variant) => buildScenario(base, variant, 0))
  ).map((scenario, index) =>
    Object.freeze({
      ...scenario,
      scenarioIndex: index,
    })
  )
);

export const AUTHORED_CONTRACT_BANK = Object.freeze(
  SCENARIO_CATALOG.map((scenario) =>
    Object.freeze({
      baseId: scenario.baseId,
      variantId: scenario.variantId,
      templateId: scenario.templateId,
      prompt: scenario.prompt,
      unitLabel: scenario.unitLabel,
      family: scenario.family,
      category: scenario.category,
      benchmarkValue: scenario.benchmarkValue,
      rangeLow: scenario.rangeLow,
      rangeHigh: scenario.rangeHigh,
      maxTurns: scenario.maxTurns,
      sourceLabel: scenario.sourceLabel,
      sourceUrl: scenario.sourceUrl,
    })
  )
);

export const SCENARIO_COUNT = SCENARIO_CATALOG.length;

export function scenarioAt(index) {
  const normalized = ((index % SCENARIO_COUNT) + SCENARIO_COUNT) % SCENARIO_COUNT;
  return SCENARIO_CATALOG[normalized];
}

function answerRationaleForScenario(scenario, hiddenValue) {
  return `${scenario.sourceLabel}: ${scenario.benchmarkSummary} ${scenario.variantRationale} That puts ${formatNumber(scenario.benchmarkValue)} ${scenario.unitLabel} at the center of the interview answer band, and this round settles at ${formatNumber(hiddenValue)} ${scenario.unitLabel}.`;
}

function hiddenValueForScenario(scenario) {
  const centered = randomInt(-10_000, 10_000) / 10_000;
  return clamp(
    roundInt(scenario.benchmarkValue * (1 + centered * scenario.hiddenVolatility)),
    scenario.rangeLow,
    scenario.rangeHigh
  );
}

function finalizeContract(scenario, hiddenValue) {
  return {
    id: crypto.randomUUID(),
    scenarioIndex: scenario.scenarioIndex,
    templateId: scenario.templateId,
    prompt: scenario.prompt,
    unitLabel: scenario.unitLabel,
    family: scenario.family,
    category: scenario.category,
    benchmarkValue: scenario.benchmarkValue,
    rangeLow: scenario.rangeLow,
    rangeHigh: scenario.rangeHigh,
    maxTurns: scenario.maxTurns,
    sourceLabel: scenario.sourceLabel,
    sourceUrl: scenario.sourceUrl,
    answerRationale: answerRationaleForScenario(scenario, hiddenValue),
    hiddenValue,
  };
}

export function sampleScenarioIndex() {
  return randomInt(0, SCENARIO_COUNT - 1);
}

export function contractFromScenarioIndex(index) {
  const scenario = scenarioAt(index);
  return finalizeContract(scenario, hiddenValueForScenario(scenario));
}

export function sampleContract() {
  return contractFromScenarioIndex(sampleScenarioIndex());
}
