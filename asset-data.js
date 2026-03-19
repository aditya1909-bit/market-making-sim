(function () {
  const BASE_ASSETS = [
    { ticker: "AAPL", name: "Apple", sector: "Large Cap Technology", exchange: "NASDAQ", basePrice: 184, spread: 0.08, vol: 0.22 },
    { ticker: "MSFT", name: "Microsoft", sector: "Large Cap Technology", exchange: "NASDAQ", basePrice: 425, spread: 0.1, vol: 0.24 },
    { ticker: "NVDA", name: "NVIDIA", sector: "Semiconductors", exchange: "NASDAQ", basePrice: 78, spread: 0.2, vol: 0.62 },
    { ticker: "AMD", name: "Advanced Micro Devices", sector: "Semiconductors", exchange: "NASDAQ", basePrice: 179, spread: 0.15, vol: 0.54 },
    { ticker: "TSLA", name: "Tesla", sector: "Autos", exchange: "NASDAQ", basePrice: 151, spread: 0.22, vol: 0.67 },
    { ticker: "META", name: "Meta Platforms", sector: "Internet", exchange: "NASDAQ", basePrice: 495, spread: 0.11, vol: 0.31 },
    { ticker: "AMZN", name: "Amazon", sector: "Internet", exchange: "NASDAQ", basePrice: 181, spread: 0.09, vol: 0.29 },
    { ticker: "GOOGL", name: "Alphabet", sector: "Internet", exchange: "NASDAQ", basePrice: 168, spread: 0.09, vol: 0.26 },
    { ticker: "NFLX", name: "Netflix", sector: "Media", exchange: "NASDAQ", basePrice: 635, spread: 0.18, vol: 0.36 },
    { ticker: "JPM", name: "JPMorgan Chase", sector: "Banks", exchange: "NYSE", basePrice: 195, spread: 0.09, vol: 0.33 },
    { ticker: "GS", name: "Goldman Sachs", sector: "Banks", exchange: "NYSE", basePrice: 452, spread: 0.12, vol: 0.3 },
    { ticker: "XOM", name: "Exxon Mobil", sector: "Energy", exchange: "NYSE", basePrice: 114, spread: 0.07, vol: 0.28 },
    { ticker: "CVX", name: "Chevron", sector: "Energy", exchange: "NYSE", basePrice: 158, spread: 0.07, vol: 0.27 },
    { ticker: "UNH", name: "UnitedHealth", sector: "Healthcare", exchange: "NYSE", basePrice: 486, spread: 0.12, vol: 0.25 },
    { ticker: "LLY", name: "Eli Lilly", sector: "Healthcare", exchange: "NYSE", basePrice: 812, spread: 0.2, vol: 0.34 },
    { ticker: "SPY", name: "SPDR S&P 500 ETF", sector: "Index ETF", exchange: "NYSE Arca", basePrice: 528, spread: 0.04, vol: 0.3 },
    { ticker: "QQQ", name: "Invesco QQQ Trust", sector: "Index ETF", exchange: "NASDAQ", basePrice: 452, spread: 0.05, vol: 0.34 },
    { ticker: "IWM", name: "iShares Russell 2000 ETF", sector: "Index ETF", exchange: "NYSE Arca", basePrice: 205, spread: 0.05, vol: 0.38 },
    { ticker: "SMH", name: "VanEck Semiconductor ETF", sector: "Sector ETF", exchange: "NASDAQ", basePrice: 255, spread: 0.09, vol: 0.41 },
    { ticker: "XLF", name: "Financial Select Sector SPDR", sector: "Sector ETF", exchange: "NYSE Arca", basePrice: 42, spread: 0.03, vol: 0.21 },
  ];

  const ARCHETYPES = [
    { name: "Post-earnings drift", flowTone: "buyer-led", volBias: 0.18, spreadBias: 1.3, drift: 0.24, desc: "Earnings reaction continues to reprice the name upward.", note: "Selling too cheap is the main risk." },
    { name: "Gap-and-fade", flowTone: "seller-led", volBias: 0.16, spreadBias: 1.2, drift: -0.2, desc: "The open gap is being sold into as fast money unwinds.", note: "Do not warehouse inventory too quickly on the bid." },
    { name: "Calm institutional grind", flowTone: "balanced", volBias: -0.06, spreadBias: 0.9, drift: 0.08, desc: "Steady institutional participation with limited panic flow.", note: "Tighter, disciplined quoting is usually fine." },
    { name: "Macro headline whipsaw", flowTone: "two-way", volBias: 0.2, spreadBias: 1.45, drift: 0.0, desc: "Macro headlines are forcing quick repricings in both directions.", note: "Protect against adverse selection before chasing fills." },
    { name: "Index rebalance day", flowTone: "buyer-led", volBias: 0.08, spreadBias: 1.05, drift: 0.1, desc: "Program flow keeps returning at predictable times.", note: "The tape trades, but it can suddenly lean one-sided." },
    { name: "Mean-reversion session", flowTone: "two-way", volBias: 0.02, spreadBias: 1.0, drift: -0.02, desc: "Every push gets faded as the market snaps back toward fair.", note: "Quotes that chase too much get punished." },
    { name: "Commodity-linked trend", flowTone: "buyer-led", volBias: 0.04, spreadBias: 1.0, drift: 0.12, desc: "The stock is following a persistent move in the underlying commodity complex.", note: "Patience matters more than speed." },
    { name: "Risk-off liquidation", flowTone: "seller-led", volBias: 0.22, spreadBias: 1.5, drift: -0.24, desc: "Participants are reducing exposure aggressively into weakness.", note: "Bid-side fills can be dangerous if you do not widen fast enough." },
    { name: "Crowded momentum chase", flowTone: "buyer-led", volBias: 0.12, spreadBias: 1.25, drift: 0.2, desc: "Momentum accounts keep lifting offers as the name accelerates.", note: "A narrow ask looks attractive but can be expensive." },
    { name: "Quiet range day", flowTone: "balanced", volBias: -0.1, spreadBias: 0.85, drift: 0.0, desc: "The name is pinned in a narrow range with modest two-way flow.", note: "This is the spot to earn spread if you stay disciplined." },
  ];

  const DATE_VARIANTS = [
    "2024-01-12",
    "2024-02-22",
    "2024-03-08",
    "2024-03-14",
    "2024-04-12",
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

  function makePath(start, drift, noise, length, rng) {
    const out = [];
    let value = start;
    for (let i = 0; i < length; i += 1) {
      value += drift + (rng() - 0.5) * noise;
      out.push(round2(value));
    }
    return out;
  }

  const scenarios = [];

  BASE_ASSETS.forEach((asset) => {
    ARCHETYPES.forEach((archetype, archetypeIndex) => {
      DATE_VARIANTS.forEach((sessionDate, variantIndex) => {
        const seed = hashString(`${asset.ticker}-${archetype.name}-${sessionDate}`);
        const rng = mulberry32(seed);
        const realizedVol = round2(Math.max(0.16, asset.vol + archetype.volBias + (rng() - 0.5) * 0.08));
        const averageSpread = round2(Math.max(0.03, asset.spread * archetype.spreadBias * (0.92 + rng() * 0.2)));
        const start = asset.basePrice * (0.97 + rng() * 0.06);
        const drift = archetype.drift * Math.max(0.2, asset.basePrice * 0.0016);
        const recentPath = makePath(start, drift * 0.45, realizedVol * asset.basePrice * 0.007, 6, rng);
        const turnMarks = makePath(
          recentPath[recentPath.length - 1] + drift * 0.25,
          drift * 0.55,
          realizedVol * asset.basePrice * 0.008,
          11,
          rng
        );

        scenarios.push({
          id: `${asset.ticker}-${archetypeIndex}-${variantIndex}`,
          ticker: asset.ticker,
          name: asset.name,
          sector: asset.sector,
          exchange: asset.exchange,
          scenario: archetype.name,
          sessionDate,
          description: archetype.desc,
          strategyNote: archetype.note,
          averageSpread,
          realizedVol,
          flowTone: archetype.flowTone,
          recentPath,
          turnMarks,
        });
      });
    });
  });

  window.ASSET_SCENARIOS = scenarios;
})();
