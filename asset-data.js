(function () {
  const PLACES = [
    { name: "Chicago", regionType: "city", scale: 1.0, footfall: 1.0 },
    { name: "New York City", regionType: "city", scale: 1.6, footfall: 1.8 },
    { name: "Los Angeles", regionType: "city", scale: 1.25, footfall: 1.2 },
    { name: "London", regionType: "city", scale: 1.35, footfall: 1.45 },
    { name: "Paris", regionType: "city", scale: 1.15, footfall: 1.3 },
    { name: "Tokyo", regionType: "city", scale: 1.7, footfall: 1.9 },
    { name: "Toronto", regionType: "city", scale: 0.92, footfall: 0.95 },
    { name: "Singapore", regionType: "city", scale: 0.88, footfall: 1.05 },
    { name: "Austin", regionType: "city", scale: 0.68, footfall: 0.72 },
    { name: "Mumbai", regionType: "city", scale: 1.45, footfall: 1.55 },
  ];

  const MODIFIERS = [
    { name: "downtown core", scale: 0.42, clue: "The scope is concentrated in the busiest central district." },
    { name: "metro area", scale: 1.0, clue: "The scope includes the full metro footprint rather than one neighborhood." },
    { name: "tourist district", scale: 0.36, clue: "Foot traffic is elevated by visitors rather than residents alone." },
    { name: "university belt", scale: 0.22, clue: "Demand is concentrated around campus schedules and student habits." },
    { name: "airport corridor", scale: 0.3, clue: "Passenger flow and business travel matter more than resident population." },
    { name: "suburban ring", scale: 0.58, clue: "Lower density, but broader residential coverage." },
    { name: "business district", scale: 0.34, clue: "Weekday commuter flow dominates the estimate." },
    { name: "sports-event zone", scale: 0.18, clue: "Demand spikes around event attendance windows." },
    { name: "riverfront strip", scale: 0.16, clue: "The geography is narrow, visible, and heavily trafficked." },
    { name: "greater region", scale: 1.28, clue: "This scope goes beyond the core city and captures surrounding demand." },
  ];

  const FAMILIES = [
    {
      code: "CITYPOP",
      category: "Population",
      unitLabel: "millions of people",
      prompt: (place, modifier) => `Population of the ${modifier.name} of ${place.name}`,
      baseValue: 6.5,
      vol: 0.18,
      spread: 0.08,
      flow: "balanced",
      strategy: "Population contracts reward calm anchoring. Start with a plausible range, then tighten only if your clue updates are consistent.",
      clue: (place, modifier, estimate) => `A reasonable urban density benchmark points toward about ${estimate.toFixed(1)} ${place.regionType === "city" ? "million" : "units"} before scope adjustments.`,
    },
    {
      code: "COFFEE",
      category: "Consumer Demand",
      unitLabel: "hundreds of thousands of cups per weekday",
      prompt: (place, modifier) => `Cups of coffee sold on a weekday in the ${modifier.name} of ${place.name}`,
      baseValue: 9.0,
      vol: 0.26,
      spread: 0.12,
      flow: "buyer-led",
      strategy: "Coffee-flow contracts often trade fast when the scope is commute-heavy. Keep your ask honest if the clue set leans busy.",
      clue: (place, modifier, estimate) => `Commuter and office density suggest a weekday demand anchor around ${estimate.toFixed(1)} hundred-thousand cups.`,
    },
    {
      code: "TAXI",
      category: "Transport",
      unitLabel: "thousands of rides per day",
      prompt: (place, modifier) => `Taxi and rideshare pickups per day in the ${modifier.name} of ${place.name}`,
      baseValue: 72,
      vol: 0.33,
      spread: 0.15,
      flow: "two-way",
      strategy: "Transport counts can swing on scope assumptions. Quote a shape that leaves room for both local demand and transit substitution.",
      clue: (place, modifier, estimate) => `Trip-density comps point to roughly ${estimate.toFixed(0)} thousand daily pickups before special-event effects.`,
    },
    {
      code: "PIZZA",
      category: "Food",
      unitLabel: "hundreds of thousands of slices per week",
      prompt: (place, modifier) => `Pizza slices sold per week in the ${modifier.name} of ${place.name}`,
      baseValue: 5.8,
      vol: 0.24,
      spread: 0.11,
      flow: "buyer-led",
      strategy: "Food-estimate contracts reward intuition about foot traffic, repeat purchase rates, and late-night concentration.",
      clue: (place, modifier, estimate) => `Dense casual dining zones often settle near ${estimate.toFixed(1)} hundred-thousand slices per week.`,
    },
    {
      code: "BENCH",
      category: "Urban Objects",
      unitLabel: "count",
      prompt: (place, modifier) => `Public benches in the ${modifier.name} of ${place.name}`,
      baseValue: 2100,
      vol: 0.17,
      spread: 0.09,
      flow: "balanced",
      strategy: "Static-object contracts usually have lower vol. Tight spreads are fine if your scale estimate is grounded.",
      clue: (place, modifier, estimate) => `Street-grid and park-density analogs put this close to ${estimate.toFixed(0)} benches.`,
    },
    {
      code: "WINDOW",
      category: "Built Environment",
      unitLabel: "thousands of windows",
      prompt: (place, modifier) => `Windows visible across the ${modifier.name} office cluster in ${place.name}`,
      baseValue: 44,
      vol: 0.21,
      spread: 0.1,
      flow: "two-way",
      strategy: "This is a classic Fermi-style built-environment question. Floors, facades, and building count matter more than micro details.",
      clue: (place, modifier, estimate) => `A rough tower-count × floor-count heuristic lands around ${estimate.toFixed(0)} thousand windows.`,
    },
    {
      code: "UMBRELLA",
      category: "Retail",
      unitLabel: "hundreds of thousands of umbrellas per year",
      prompt: (place, modifier) => `Umbrellas sold per year across the ${modifier.name} around ${place.name}`,
      baseValue: 3.9,
      vol: 0.28,
      spread: 0.12,
      flow: "seller-led",
      strategy: "Weather-linked retail contracts can look obvious and still trap you on scope. Quote with room for seasonality uncertainty.",
      clue: (place, modifier, estimate) => `Rain frequency and replacement rates imply roughly ${estimate.toFixed(1)} hundred-thousand umbrellas annually.`,
    },
    {
      code: "BOOK",
      category: "Institutions",
      unitLabel: "thousands of books",
      prompt: (place, modifier) => `Books held across public libraries in the ${modifier.name} of ${place.name}`,
      baseValue: 58,
      vol: 0.16,
      spread: 0.08,
      flow: "balanced",
      strategy: "Library-book contracts are lower tempo. Inventory discipline matters more than trying to game every clue.",
      clue: (place, modifier, estimate) => `Branch count and typical catalog size give an estimate near ${estimate.toFixed(0)} thousand books.`,
    },
    {
      code: "BIKE",
      category: "Mobility",
      unitLabel: "thousands of bike trips per day",
      prompt: (place, modifier) => `Bike trips per day across the ${modifier.name} of ${place.name}`,
      baseValue: 34,
      vol: 0.3,
      spread: 0.13,
      flow: "buyer-led",
      strategy: "Bike-trip contracts are sensitive to density and culture. Narrow quotes are dangerous if you underweight local ridership habits.",
      clue: (place, modifier, estimate) => `Commuter cycling benchmarks support roughly ${estimate.toFixed(0)} thousand daily trips.`,
    },
    {
      code: "SEARCH",
      category: "Internet Behavior",
      unitLabel: "millions of searches per month",
      prompt: (place, modifier) => `Searches per month for local weather from the ${modifier.name} of ${place.name}`,
      baseValue: 2.8,
      vol: 0.22,
      spread: 0.1,
      flow: "two-way",
      strategy: "Behavioral contracts are noisy. Anchor on user base, then widen if the clue set suggests broad uncertainty.",
      clue: (place, modifier, estimate) => `Active-device counts and repeat search habits imply about ${estimate.toFixed(1)} million monthly searches.`,
    },
  ];

  function hashString(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t += 0x6d2b79f5;
      let x = Math.imul(t ^ (t >>> 15), 1 | t);
      x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  function buildSeries(start, target, noiseScale, count, rng) {
    const out = [];
    let current = start;
    for (let i = 0; i < count; i += 1) {
      const left = count - i;
      const drift = (target - current) / Math.max(1, left);
      current = current + drift * 0.9 + (rng() - 0.5) * noiseScale;
      out.push(round2(current));
    }
    return out;
  }

  const scenarios = [];

  for (const family of FAMILIES) {
    for (const place of PLACES) {
      for (const modifier of MODIFIERS) {
        const seed = hashString(`${family.code}-${place.name}-${modifier.name}`);
        const rng = mulberry32(seed);
        const scale = place.scale * modifier.scale * (0.9 + rng() * 0.24);
        const trueValue = round2(Math.max(0.5, family.baseValue * scale));
        const recentStart = trueValue * (0.9 + rng() * 0.18);
        const recentPath = buildSeries(recentStart, trueValue * (0.96 + rng() * 0.08), trueValue * 0.04, 6, rng);
        const turnMarks = buildSeries(recentPath[recentPath.length - 1], trueValue, trueValue * 0.035, 11, rng);
        const low = round2(trueValue * (0.72 - rng() * 0.04));
        const high = round2(trueValue * (1.28 + rng() * 0.05));
        const averageSpread = round2(family.spread * (0.9 + rng() * 0.25));
        const realizedVol = round2(family.vol * (0.88 + rng() * 0.28));
        const anchor = round2((low + high) / 2);
        const clueEstimate = round2(trueValue * (0.95 + rng() * 0.1));

        scenarios.push({
          id: `${family.code}-${place.name}-${modifier.name}`,
          ticker: family.code,
          name: family.prompt(place, modifier),
          sector: family.category,
          exchange: family.unitLabel,
          scenario: `${place.name} · ${modifier.name}`,
          sessionDate: `anchor ${anchor}`,
          description: `${family.prompt(place, modifier)}. Plausible range: ${low} to ${high} ${family.unitLabel}.`,
          strategyNote: family.strategy,
          averageSpread,
          realizedVol,
          flowTone: family.flow,
          recentPath,
          turnMarks,
          initialClue: modifier.clue,
          benchmarkText: family.clue(place, modifier, clueEstimate),
          valueRange: { low, high },
        });
      }
    }
  }

  window.ASSET_SCENARIOS = scenarios;
})();
