(function () {
  const DEPLOYED_BACKEND_URL = "https://market-making-sim-backend.adityasdutta.workers.dev";

  const STORAGE_KEYS = {
    backendUrl: "market-making-sim.backend-url",
    playerName: "market-making-sim.player-name",
    selectedGameType: "market-making-sim.selected-game-type",
    session: "market-making-sim.session",
    clientId: "market-making-sim.client-id",
  };

  const elements = {
    heroSection: document.getElementById("hero-section"),
    modeSection: document.getElementById("mode-section"),
    setupSection: document.getElementById("setup-section"),
    sessionSection: document.getElementById("session-section"),
    gameSection: document.getElementById("game-section"),
    lowerSection: document.getElementById("lower-section"),
    connectionStatus: document.getElementById("connection-status"),
    sessionConnectionStatus: document.getElementById("session-connection-status"),
    sessionConnectionDetail: document.getElementById("session-connection-detail"),
    playerName: document.getElementById("player-name"),
    heroTitle: document.getElementById("hero-title"),
    heroText: document.getElementById("hero-text"),
    modeDescription: document.getElementById("mode-description"),
    toggleHiddenValue: document.getElementById("toggle-hidden-value"),
    toggleCardMarket: document.getElementById("toggle-card-market"),
    setupMessage: document.getElementById("setup-message"),
    reloadApp: document.getElementById("reload-app"),
    createRoom: document.getElementById("create-room"),
    joinCode: document.getElementById("join-code"),
    joinRoom: document.getElementById("join-room"),
    roomActionMessage: document.getElementById("room-action-message"),
    profileCard: document.getElementById("profile-card"),
    privateRoomCard: document.getElementById("private-room-card"),
    randomMatchCard: document.getElementById("random-match-card"),
    queueMatch: document.getElementById("queue-match"),
    cancelQueue: document.getElementById("cancel-queue"),
    queueStatus: document.getElementById("queue-status"),
    queueTitle: document.getElementById("queue-title"),
    playBotMaker: document.getElementById("play-bot-maker"),
    playBotTaker: document.getElementById("play-bot-taker"),
    rlBotCard: document.getElementById("rl-bot-card"),
    botTitle: document.getElementById("bot-title"),
    cardMarketInfoCard: document.getElementById("card-market-info-card"),
    cardInfoTitle: document.getElementById("card-info-title"),
    cardInfoPrivate: document.getElementById("card-info-private"),
    cardInfoTrading: document.getElementById("card-info-trading"),
    cardInfoTiming: document.getElementById("card-info-timing"),
    roomCodeDisplay: document.getElementById("room-code-display"),
    copyRoomCode: document.getElementById("copy-room-code"),
    readyToggle: document.getElementById("ready-toggle"),
    requestRematch: document.getElementById("request-rematch"),
    retryConnection: document.getElementById("retry-connection"),
    leaveRoom: document.getElementById("leave-room"),
    roleLabel: document.getElementById("role-label"),
    gameStatus: document.getElementById("game-status"),
    turnLabel: document.getElementById("turn-label"),
    activeActor: document.getElementById("active-actor"),
    gameTypeLabel: document.getElementById("game-type-label"),
    turnCaption: document.getElementById("turn-caption"),
    activeCaption: document.getElementById("active-caption"),
    matchType: document.getElementById("match-type"),
    gameNumber: document.getElementById("game-number"),
    playersList: document.getElementById("players-list"),
    cardBotPanel: document.getElementById("card-bot-panel"),
    cardBotStatus: document.getElementById("card-bot-status"),
    cardBotCount: document.getElementById("card-bot-count"),
    addCardBots: document.getElementById("add-card-bots"),
    cardBotList: document.getElementById("card-bot-list"),
    contractPrompt: document.getElementById("contract-prompt"),
    contractCaption: document.getElementById("contract-caption"),
    contractUnit: document.getElementById("contract-unit"),
    contractRange: document.getElementById("contract-range"),
    roleHeadline: document.getElementById("role-headline"),
    turnPrompt: document.getElementById("turn-prompt"),
    roleSummaryTitle: document.getElementById("role-summary-title"),
    sideInstructions: document.getElementById("side-instructions"),
    bluffSummary: document.getElementById("bluff-summary"),
    resolutionSummary: document.getElementById("resolution-summary"),
    quoteCard: document.getElementById("quote-card"),
    quoteCardCaption: document.getElementById("quote-card-caption"),
    quoteCardTitle: document.getElementById("quote-card-title"),
    takerCard: document.getElementById("taker-card"),
    bidInput: document.getElementById("bid-input"),
    askInput: document.getElementById("ask-input"),
    sizeInput: document.getElementById("size-input"),
    submitQuote: document.getElementById("submit-quote"),
    takerQuoteBid: document.getElementById("taker-quote-bid"),
    takerQuoteAsk: document.getElementById("taker-quote-ask"),
    takerQuoteSize: document.getElementById("taker-quote-size"),
    currentQuoteBid: document.getElementById("current-quote-bid"),
    currentQuoteAsk: document.getElementById("current-quote-ask"),
    currentQuoteSize: document.getElementById("current-quote-size"),
    previousQuote: document.getElementById("previous-quote"),
    quoteContext: document.getElementById("quote-context"),
    takerBuy: document.getElementById("taker-buy"),
    takerSell: document.getElementById("taker-sell"),
    takerPass: document.getElementById("taker-pass"),
    cardStateCard: document.getElementById("card-state-card"),
    cardQuotesCard: document.getElementById("card-quotes-card"),
    marketCard: document.getElementById("market-card"),
    cardMakerBadge: document.getElementById("card-maker-badge"),
    privateHand: document.getElementById("private-hand"),
    handUpdate: document.getElementById("hand-update"),
    boardCards: document.getElementById("board-cards"),
    cardResponseStatus: document.getElementById("card-response-status"),
    requestNextReveal: document.getElementById("request-next-reveal"),
    cardQuotesList: document.getElementById("card-quotes-list"),
    classicPositionCard: document.getElementById("classic-position-card"),
    positionsCard: document.getElementById("positions-card"),
    positionsList: document.getElementById("positions-list"),
    youCash: document.getElementById("you-cash"),
    youInventory: document.getElementById("you-inventory"),
    youPnl: document.getElementById("you-pnl"),
    oppCash: document.getElementById("opp-cash"),
    oppInventory: document.getElementById("opp-inventory"),
    settlementValue: document.getElementById("settlement-value"),
    historyList: document.getElementById("history-list"),
  };

  const state = {
    backendUrl: "",
    playerName: "",
    selectedGameType: "hidden_value",
    roomId: null,
    roomCode: null,
    playerId: null,
    roomState: null,
    ws: null,
    queueTicketId: null,
    queuePollHandle: null,
    queueJoinPending: false,
    restoring: false,
    manualClose: false,
    reconnectHandle: null,
    reconnectAttempts: 0,
    reconnecting: false,
    connectionState: "idle",
    connectionDetail: "Create, join, or queue into a room to start playing.",
    socketSessionId: 0,
    reloadRequired: false,
    lastActivityPingAt: 0,
    setupMessage: "",
    setupMessageIsError: false,
    actionMessage: "",
    actionMessageIsError: false,
    botControlMessage: "",
    botControlMessageIsError: false,
    cardBotCountDraft: "1",
    queueMessage: "",
    queueMessageIsError: false,
  };

  function defaultBackendUrl() {
    const params = new URLSearchParams(window.location.search);
    const urlParam = normalizeBackendUrl(params.get("backend"));
    if (urlParam) {
      return urlParam;
    }
    const stored = safeStorageGet(STORAGE_KEYS.backendUrl);
    if (stored) {
      return stored;
    }
    if (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") {
      return "http://127.0.0.1:8787";
    }
    return DEPLOYED_BACKEND_URL;
  }

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // ignore storage failures
    }
  }

  function safeStorageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore storage failures
    }
  }

  function setBackendUrl(url, options = {}) {
    const normalized = normalizeBackendUrl(url);
    state.backendUrl = normalized;
    if (normalized && options.persist !== false) {
      safeStorageSet(STORAGE_KEYS.backendUrl, normalized);
    }
    return normalized;
  }

  function capWords(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "-";
    }
    return text
      .split(/[_\s-]+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function format(value, digits = 2) {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return "-";
    }
    return Number(value).toFixed(digits);
  }

  function formatGameType(value) {
    if (value === "card_market") {
      return "Card Market";
    }
    return "Hidden Value";
  }

  function formatRoleLabel(role, gameType, seatStatus = "") {
    if (gameType === "card_market") {
      if (seatStatus === "active_round") {
        return "Seated This Round";
      }
      if (seatStatus === "waiting_next_round") {
        return "Waiting Next Round";
      }
      if (seatStatus === "lobby_member") {
        return "Lobby Seat";
      }
      if (role === "spectator") {
        return "Observer";
      }
    }
    return capWords(role);
  }

  function suitSymbol(card) {
    const suitMap = {
      S: "♠",
      H: "♥",
      D: "♦",
      C: "♣",
    };
    return suitMap[card?.suit] || card?.suit || "";
  }

  function formatCard(card) {
    if (!card) {
      return "-";
    }
    return `${card.rank}${suitSymbol(card)}`;
  }

  function formatCards(cards) {
    if (!cards?.length) {
      return "None shown.";
    }
    return cards.map((card) => formatCard(card)).join("  ");
  }

  function cardColorClass(card) {
    return card?.color === "red" ? "card-red" : "card-black";
  }

  function renderCardRack(node, cards, emptyText) {
    if (!node) {
      return;
    }
    node.innerHTML = "";
    if (!cards?.length) {
      const empty = document.createElement("span");
      empty.className = "card-rack-empty";
      empty.textContent = emptyText;
      node.appendChild(empty);
      return;
    }

    cards.forEach((card) => {
      const face = document.createElement("div");
      face.className = `playing-card ${cardColorClass(card)}`;

      const pip = document.createElement("div");
      pip.className = "playing-card-pip";
      pip.textContent = suitSymbol(card);

      const corner = document.createElement("div");
      corner.className = "playing-card-corner";
      corner.textContent = formatCard(card);

      const meta = document.createElement("div");
      meta.className = "playing-card-meta";
      meta.textContent = card.suitName;

      face.appendChild(pip);
      face.appendChild(corner);
      face.appendChild(meta);
      node.appendChild(face);
    });
  }

  function describeHandUpdate(update) {
    return "Your 2-card hand stays fixed for the full round.";
  }

  function formatDuration(ms) {
    if (ms === null || ms === undefined) {
      return "-";
    }
    const totalSeconds = Math.max(Math.ceil(ms / 1000), 0);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function selectedGameType() {
    return state.selectedGameType === "card_market" ? "card_market" : "hidden_value";
  }

  function activeVisualGameType() {
    if (state.roomState?.gameType) {
      return state.roomState.gameType;
    }
    return selectedGameType();
  }

  function applyTheme() {
    document.body.classList.toggle("card-theme", activeVisualGameType() === "card_market");
  }

  function setSelectedGameType(gameType) {
    state.selectedGameType = gameType === "card_market" ? "card_market" : "hidden_value";
    safeStorageSet(STORAGE_KEYS.selectedGameType, state.selectedGameType);
    applyTheme();
    renderModeSelection();
    render();
  }

  function renderModeSelection() {
    const isCardGame = selectedGameType() === "card_market";
    const hasRoom = Boolean(state.roomCode);
    const currentRoomGameType = state.roomState?.gameType || null;
    const selectedLabel = isCardGame ? "Card Market" : "Hidden Value";
    const currentLabel = currentRoomGameType === "card_market" ? "Card Market" : "Hidden Value";

    elements.toggleHiddenValue.classList.toggle("mode-toggle-active", !isCardGame);
    elements.toggleCardMarket.classList.toggle("mode-toggle-active", isCardGame);

    setText(elements.heroTitle, isCardGame ? "Public tables. Private cards. Live markets." : "One hidden value. One market.");
    setText(
      elements.heroText,
      isCardGame
        ? "Join the next public card table or build a private room. Ready players get seated into each round, late joins wait for the next deal, and the board reveals over time."
        : "Create a private room, join by code, or queue into a random match. The maker quotes a market, the taker chooses buy, sell, or pass, and settlement stays hidden until the round ends."
    );
    setText(
      elements.modeDescription,
      hasRoom
        ? currentRoomGameType === selectedGameType()
          ? `${currentLabel} is the current room mode. You can switch this selector at any time; it only changes what you create, join, or queue into after leaving the room.`
          : `Current room: ${currentLabel}. Next selected mode: ${selectedLabel}. Leave this room when you want to create, join, or queue into the selected mode instead.`
        : isCardGame
          ? "Card Market is now a real table mode: public lobbies, private rooms, active-round seating, auto-start countdowns, and persistent tables."
          : "Hidden Value is the current polished mode: a fast 1v1 market-making game with private settlement, reconnect support, and authoritative multiplayer state."
    );
    setText(elements.queueTitle, isCardGame ? "Join the next public card table" : "Queue into the next game");
    setText(elements.botTitle, "Play the trained model");
    setText(elements.cardInfoTitle, "How this game runs");
    setText(elements.cardInfoPrivate, "Each player starts with 2 private cards from a standard 52-card deck. Your hand stays fixed for the full round.");
    setText(elements.cardInfoTrading, "Only seated players for the current deal can quote, trade, and vote reveal. Players who join late wait for the next round.");
    setText(elements.cardInfoTiming, "As soon as at least 2 connected players are ready, an 8 second countdown starts. If a seated player leaves mid-round, the table resets to lobby and redeals.");
    elements.profileCard.classList.remove("hidden");
    elements.privateRoomCard.classList.remove("hidden");
    elements.randomMatchCard.classList.remove("hidden");
    elements.rlBotCard.classList.toggle("hidden", isCardGame);
    elements.cardMarketInfoCard.classList.toggle("hidden", !isCardGame);
  }

  function normalizeBackendUrl(input) {
    return String(input || "")
      .trim()
      .replace(/\/+$/, "");
  }

  function getOrCreateClientId() {
    const existing = safeStorageGet(STORAGE_KEYS.clientId);
    if (existing) {
      return existing;
    }
    const created = window.crypto?.randomUUID ? window.crypto.randomUUID() : `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    safeStorageSet(STORAGE_KEYS.clientId, created);
    return created;
  }

  function formatQuote(quote) {
    if (!quote) {
      return "-";
    }
    return `${format(quote.bid)} / ${format(quote.ask)} x ${quote.size}`;
  }

  function quoteMid(quote) {
    if (!quote) {
      return null;
    }
    return (Number(quote.bid) + Number(quote.ask)) / 2;
  }

  function buildRoleHeadline(role, roomState, game) {
    if (roomState?.gameType === "card_market") {
      if (roomState?.status === "live" && roomState?.cardSeatStatus === "active_round") {
        return "You are seated in the live round. Quote carefully and trade the board as it reveals.";
      }
      if (roomState?.status === "live") {
        return "You joined after the deal started. Watch this round and you will be eligible for the next one.";
      }
      return roomState?.roomVisibility === "public_table"
        ? "You are in a persistent public table. Ready up to get seated into the next live round."
        : "You are in a private card room. Ready players will be seated into the next deal.";
    }
    if (role === "market_maker") {
      return "You set the market and decide how much edge to show.";
    }
    if (role === "market_taker") {
      return "You decide whether to buy, sell, or wait.";
    }
    if (roomState?.players?.length === 1) {
      return "You have the room. Share the code and wait for the second seat.";
    }
    return "Join a room to get a seat.";
  }

  function buildTurnPrompt(role, roomState, game) {
    if (!roomState || !game) {
      return "No active turn.";
    }
    if (roomState.gameType === "card_market") {
      if (roomState.status === "lobby") {
        if (game?.previousSummary?.kind === "finished") {
          const readyHumans = roomState?.table?.readyHumanCount || 0;
          const readyThreshold = roomState?.table?.readyThreshold || 1;
          if (game?.msUntilStart !== null && game?.msUntilStart !== undefined) {
            return `Next deal starts in ${formatDuration(game.msUntilStart)}. ${readyHumans} of ${readyThreshold} required human votes are in.`;
          }
          return `Round settled. ${readyHumans} of ${readyThreshold} required human votes are in for the next deal.`;
        }
        if (game?.msUntilStart !== null && game?.msUntilStart !== undefined) {
          return `Countdown live. Next round starts in ${formatDuration(game.msUntilStart)} if the table stays ready.`;
        }
        return (roomState?.table?.playerCount || 0) < 2
          ? "Waiting for at least two players to join the table."
          : "Need enough human opt-in before the countdown can start.";
      }
      if (roomState?.cardSeatStatus === "waiting_next_round") {
        return "This round is locked. Watch the market and wait for the next deal.";
      }
      const msRemaining = game?.endsAt ? Math.max(game.endsAt - Date.now(), 0) : game?.msRemaining;
      const msUntilNextReveal = game?.nextRevealAt ? Math.max(game.nextRevealAt - Date.now(), 0) : game?.msUntilNextReveal;
      return `Time left ${formatDuration(msRemaining)}. Next reveal ${formatDuration(msUntilNextReveal)}.`;
    }
    if (roomState.status === "finished") {
      return "The round is settled. Review the tape and request a rematch if you want the other side.";
    }
    if (roomState.status === "lobby") {
      if ((roomState.players || []).length < 2) {
        return "Waiting for a second player to join the room.";
      }
      if (!roomState.ready) {
        return "Both seats are filled. Mark ready when you want to start.";
      }
      return roomState.matchType === "bot"
        ? "The bot room is preparing the next round."
        : "You are ready. Waiting for the other player.";
    }
    if (role === "market_maker") {
      return game.activeActor === "maker"
        ? "Post your next two-sided market."
        : "Waiting for the taker to respond.";
    }
    if (role === "market_taker") {
      return game.activeActor === "taker"
        ? "Read the quote and respond."
        : "Waiting for the next quote.";
    }
    return "Watching the room.";
  }

  function buildSideInstructions(role, roomState, game) {
    if (!roomState || !game) {
      return "Create, join, or resume a room to receive a role.";
    }
    if (roomState.gameType === "card_market") {
      if (roomState.status === "lobby") {
        if (game?.previousSummary?.kind === "finished") {
          return roomState.ready
            ? "You are opted into the next deal. The lobby will wait until enough human players agree to continue."
            : "Review the standings, then mark ready when you want to join the next deal.";
        }
        return roomState.ready
          ? "You are ready. Stay connected so the countdown can complete."
          : "Mark ready when you want a seat in the next deal.";
      }
      if (roomState.cardSeatStatus === "waiting_next_round") {
        return "Live rounds are seat-locked. You can observe now and join automatically once the table returns to lobby.";
      }
      if (roomState.status === "live") {
        return "Only seated players can quote, trade, and vote reveal. Quotes expire quickly, so manage your timing.";
      }
      return "The timed card market starts once the countdown finishes.";
    }
    if (roomState.status === "lobby" && (roomState.players || []).length < 2) {
      return "Share the room code. The round contract appears once the second player joins.";
    }
    if (roomState.status === "lobby" && !roomState.ready) {
      return "Mark ready once you are set. The server starts the round automatically when both players are ready.";
    }
    if (role === "market_maker") {
      return "Quote both sides and manage your inventory.";
    }
    if (role === "market_taker") {
      return "Trade only when the market looks off.";
    }
    return "This game only becomes active once you are assigned maker or taker.";
  }

  function buildBluffSummary(role, game) {
    if (game?.mode === "card_market") {
      if (game?.previousSummary?.kind === "cancelled") {
        return game.previousSummary.text;
      }
      if (game?.previousSummary?.kind === "finished") {
        const leader = (game.previousSummary.ranking || [])[0];
        return leader ? `${game.previousSummary.text} Winner: ${leader.name} ${format(leader.pnl)}.` : game.previousSummary.text;
      }
      if (!(game?.liveQuotes || []).length) {
        return "No live quotes yet. Private information still dominates.";
      }
      return `${game.liveQuotes.length} live quote${game.liveQuotes.length === 1 ? "" : "s"} in the room.`;
    }
    if (!game?.previousQuote && !game?.currentQuote) {
      return "No quote pressure yet.";
    }
    const current = game?.currentQuote || null;
    const previous = game?.previousQuote || null;
    const lastAction = game?.lastResolution?.action || null;

    if (!previous && current) {
      return role === "market_taker"
        ? "This is the first market of the round. Start by reading width and skew."
        : "Opening markets set the tone. Keep your first quote intentional.";
    }
    if (!previous) {
      return "No quote sequence yet.";
    }

    const currentMid = quoteMid(current);
    const previousMid = quoteMid(previous);
    const currentSpread = current ? Number(current.ask) - Number(current.bid) : null;
    const previousSpread = Number(previous.ask) - Number(previous.bid);
    const movedUp = currentMid !== null && previousMid !== null && currentMid > previousMid + 0.001;
    const movedDown = currentMid !== null && previousMid !== null && currentMid < previousMid - 0.001;
    const widened = currentSpread !== null && currentSpread > previousSpread * 1.08;
    const tightened = currentSpread !== null && currentSpread < previousSpread * 0.92;

    if (lastAction === "buy" && widened) {
      return "The maker was lifted and widened out. That usually means they felt pressure on the offer.";
    }
    if (lastAction === "sell" && widened) {
      return "The maker got sold to and widened out. That usually means they did not love their bid.";
    }
    if (tightened && movedUp) {
      return "The market tightened and shifted up. That reads like growing confidence on the high side.";
    }
    if (tightened && movedDown) {
      return "The market tightened and shifted down. That reads like growing confidence on the low side.";
    }
    if (widened) {
      return "The quote widened. The other side is trying to show less information.";
    }
    if (movedUp) {
      return "The quote moved up without much extra width. That can be a real view or a nudge.";
    }
    if (movedDown) {
      return "The quote moved down without much extra width. That can be a real view or a nudge.";
    }
    return "The market barely changed. The other side may be defending the same estimate.";
  }

  function buildQuoteContext(game) {
    if (game?.mode === "card_market") {
      if (!(game?.liveQuotes || []).length) {
        return game?.msUntilStart !== null && game?.msUntilStart !== undefined
          ? "The table is in countdown. Seats are locked once the round begins."
          : "Waiting for the first live quote.";
      }
      const best = game.liveQuotes[0];
      return `${best.playerName} is quoting ${format(best.bid)} / ${format(best.ask)} x ${best.size}.`;
    }
    if (!game?.previousQuote && !game?.currentQuote) {
      return "No quote sequence yet.";
    }
    if (!game?.previousQuote || !game?.currentQuote) {
      return "Only one public quote is available so far.";
    }

    const currentMid = quoteMid(game.currentQuote);
    const previousMid = quoteMid(game.previousQuote);
    const currentSpread = Number(game.currentQuote.ask) - Number(game.currentQuote.bid);
    const previousSpread = Number(game.previousQuote.ask) - Number(game.previousQuote.bid);
    const drift = currentMid - previousMid;
    const spreadDelta = currentSpread - previousSpread;
    const driftText = Math.abs(drift) < 0.005 ? "The midpoint is roughly unchanged." : drift > 0 ? "The midpoint moved up." : "The midpoint moved down.";
    const spreadText =
      Math.abs(spreadDelta) < 0.005 ? "The spread is roughly unchanged." : spreadDelta > 0 ? "The spread widened." : "The spread tightened.";
    return `${driftText} ${spreadText}`;
  }

  function quoteDraft() {
    const bid = Number(elements.bidInput.value);
    const ask = Number(elements.askInput.value);
    const size = Number(elements.sizeInput.value);
    const hasBid = elements.bidInput.value !== "";
    const hasAsk = elements.askInput.value !== "";
    const hasSize = elements.sizeInput.value !== "";

    if (!hasBid || !hasAsk) {
      return { valid: false, message: "Enter both bid and ask." };
    }
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
      return { valid: false, message: "Bid and ask must be numeric." };
    }
    if (ask <= bid) {
      return { valid: false, message: "Ask must be above bid." };
    }
    if (!hasSize || !Number.isFinite(size) || size < 1 || size > 10) {
      return { valid: false, message: "Size must be between 1 and 10." };
    }

    return {
      valid: true,
      bid,
      ask,
      size,
      message: "Quote is ready to send.",
    };
  }

  function connectionStatusLabel() {
    switch (state.connectionState) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Connecting";
      case "reconnecting":
        return "Reconnecting";
      case "failed":
        return "Retry needed";
      case "disconnected":
        return "Disconnected";
      default:
        return "Not connected";
    }
  }

  function requireBackendUrl() {
    const backendUrl = setBackendUrl(state.backendUrl || defaultBackendUrl());
    if (!backendUrl) {
      throw new Error("Backend URL is not configured.");
    }
    return backendUrl;
  }

  function requirePlayerName() {
    state.playerName = (elements.playerName.value || "").trim();
    if (!state.playerName) {
      throw new Error("Enter a player name first.");
    }
    safeStorageSet(STORAGE_KEYS.playerName, state.playerName);
    return state.playerName;
  }

  function persistSession() {
    if (!state.roomCode || !state.playerId) {
      return;
    }
    safeStorageSet(
      STORAGE_KEYS.session,
      JSON.stringify({
        backendUrl: normalizeBackendUrl(state.backendUrl || defaultBackendUrl()),
        roomCode: state.roomCode,
        roomId: state.roomId,
        playerId: state.playerId,
      })
    );
  }

  function clearSession() {
    safeStorageRemove(STORAGE_KEYS.session);
  }

  function readStoredSession() {
    const raw = safeStorageGet(STORAGE_KEYS.session);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed?.roomCode || !parsed?.playerId) {
        return null;
      }
      return {
        backendUrl: normalizeBackendUrl(parsed.backendUrl),
        roomCode: String(parsed.roomCode),
        roomId: parsed.roomId || null,
        playerId: String(parsed.playerId),
      };
    } catch {
      return null;
    }
  }

  function sessionBackendUrl(session) {
    return normalizeBackendUrl(session?.backendUrl) || defaultBackendUrl();
  }

  function applyStoredSession(session) {
    if (!session) {
      return null;
    }
    setBackendUrl(sessionBackendUrl(session));
    state.roomCode = session.roomCode;
    state.roomId = session.roomId || null;
    state.playerId = session.playerId;
    return session;
  }

  function isFatalStoredSessionError(error) {
    return /Unknown player|Room code not found/i.test(error?.message || "");
  }

  async function api(path, options = {}) {
    const base = options.baseUrl ? normalizeBackendUrl(options.baseUrl) : requireBackendUrl();
    if (!base) {
      throw new Error("Backend URL is not configured.");
    }
    const response = await fetch(`${base}${path}`, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Request failed.");
    }
    return payload;
  }

  function toWebSocketUrl(httpUrl) {
    if (!state.playerId || !state.roomCode) {
      throw new Error("Missing room connection state.");
    }
    const url = new URL(httpUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = `?roomCode=${encodeURIComponent(state.roomCode)}&playerId=${encodeURIComponent(state.playerId)}`;
    return url.toString();
  }

  function setText(node, text) {
    if (node) {
      node.textContent = text;
    }
  }

  function setActionMessage(message, isError = false) {
    state.actionMessage = String(message || "");
    state.actionMessageIsError = Boolean(isError);
  }

  function setBotControlMessage(message, isError = false) {
    state.botControlMessage = String(message || "");
    state.botControlMessageIsError = Boolean(isError);
  }

  function setQueueStatus(message, isError = false) {
    state.queueMessage = String(message || "");
    state.queueMessageIsError = Boolean(isError);
  }

  function setSetupMessage(message, isError = false) {
    state.setupMessage = String(message || "");
    state.setupMessageIsError = Boolean(isError);
  }

  function defaultSetupMessage() {
    return selectedGameType() === "card_market"
      ? "Public card tables stay open in lobby state, auto-start after a short countdown, and lock the current seats once the round goes live."
      : "The site connects to the live game server automatically. Refreshing the page restores your room when possible.";
  }

  function defaultRoomActionMessage() {
    return selectedGameType() === "card_market"
      ? "Private card rooms work best for specific groups; public queue drops you into the next open table."
      : "Private rooms are best for playing a specific friend.";
  }

  function defaultQueueMessage() {
    return selectedGameType() === "card_market" ? "Not queued. Join the next open public card table when ready." : "Not in matchmaking queue.";
  }

  function defaultBotControlMessage(roomState) {
    if (!roomState || roomState.gameType !== "card_market" || roomState.roomVisibility !== "private_room" || !roomState.isHost) {
      return "";
    }
    const maxPlayers = Number(roomState?.table?.maxPlayers || 0);
    const playerCount = Number(roomState?.players?.length || 0);
    const remainingSeats = Math.max(0, maxPlayers - playerCount);
    if (remainingSeats <= 0) {
      return "No open seats remain for additional bots.";
    }
    return `Add RL bots to open seats in this private card room. ${remainingSeats} seat${remainingSeats === 1 ? "" : "s"} open.`;
  }

  function renderStatusMessage(node, message, isError) {
    node.textContent = message;
    node.style.color = isError ? "var(--red)" : "";
  }

  function copyText(text) {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error("Clipboard unavailable"));
  }

  function clearQueuePolling() {
    if (state.queuePollHandle) {
      window.clearInterval(state.queuePollHandle);
      state.queuePollHandle = null;
    }
  }

  function clearReconnectTimer() {
    if (state.reconnectHandle) {
      window.clearTimeout(state.reconnectHandle);
      state.reconnectHandle = null;
    }
  }

  function setReloadRequired(message) {
    clearReconnectTimer();
    state.reconnecting = false;
    state.reconnectAttempts = 0;
    state.reloadRequired = true;
    state.connectionState = "failed";
    state.connectionDetail = message;
    state.roomId = null;
    state.roomCode = null;
    state.playerId = null;
    state.roomState = null;
    clearSession();
    setSetupMessage(message, true);
    setActionMessage(message, true);
    setQueueStatus("Reload required before you can queue again.", true);
    render();
  }

  function resetConnectionState() {
    state.reconnecting = false;
    state.reconnectAttempts = 0;
    if (state.reloadRequired) {
      state.connectionState = "failed";
      state.connectionDetail = "You were removed from the room. Reload to play again.";
      return;
    }
    state.connectionState = state.roomId ? "disconnected" : "idle";
    state.connectionDetail = state.roomId
      ? "You are not connected to the room right now."
      : "Create, join, or queue into a room to start playing.";
  }

  function fetchRoomState(roomCode = state.roomCode, playerId = state.playerId, backendUrl = null) {
    return api(`/api/rooms/${encodeURIComponent(roomCode)}/state?playerId=${encodeURIComponent(playerId)}`, {
      baseUrl: backendUrl,
    });
  }

  function queueStatusMessage(ticket) {
    const gameType = ticket?.gameType === "card_market" ? "card_market" : "hidden_value";
    if (ticket?.status === "matched") {
      return gameType === "card_market" ? `Joined public table ${ticket.roomCode}.` : `Matched into room ${ticket.roomCode}.`;
    }
    return gameType === "card_market" ? "Joining the next public card table..." : "Searching for opponent...";
  }

  function sendPresencePing(force = false) {
    if (state.reloadRequired) {
      return;
    }
    const now = Date.now();
    if (!force && now - state.lastActivityPingAt < 15000) {
      return;
    }
    if (!state.ws || state.ws.readyState !== 1) {
      return;
    }
    state.lastActivityPingAt = now;
    try {
      state.ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      // no-op
    }
  }

  function recordUserActivity() {
    sendPresencePing(false);
  }

  function reconnectDelay(attemptNumber) {
    return Math.min(700 * 2 ** Math.max(attemptNumber - 1, 0), 4000);
  }

  function handleReconnectFailure(message, options = {}) {
    const clearRoom = Boolean(options.clearRoom);
    clearReconnectTimer();
    state.reconnecting = false;
    state.connectionState = "failed";
    state.connectionDetail = message;

    if (clearRoom) {
      closeSocket();
      state.roomId = null;
      state.roomCode = null;
      state.playerId = null;
      state.roomState = null;
      clearSession();
      setSetupMessage(message, true);
      resetConnectionState();
    } else {
      setActionMessage(message, true);
    }

    render();
  }

  function scheduleReconnect() {
    clearReconnectTimer();
    if (!state.roomCode || !state.playerId) {
      resetConnectionState();
      render();
      return;
    }

    const nextAttempt = state.reconnectAttempts + 1;
    state.reconnecting = true;
    state.connectionState = "reconnecting";
    state.connectionDetail =
      nextAttempt === 1
        ? "Connection dropped. Reconnecting to the room now."
        : `Connection dropped. Retry ${nextAttempt} will start in ${Math.ceil(reconnectDelay(nextAttempt) / 1000)}s.`;

    state.reconnectHandle = window.setTimeout(() => {
      attemptReconnect();
    }, reconnectDelay(nextAttempt));
  }

  async function attemptReconnect() {
    clearReconnectTimer();
    if (!state.roomCode || !state.playerId) {
      handleReconnectFailure("Your room session is no longer available.", { clearRoom: true });
      return;
    }

    state.reconnectAttempts += 1;
    state.reconnecting = true;
    state.connectionState = "reconnecting";
    state.connectionDetail = `Trying to reconnect to room ${state.roomCode}.`;
    render();

    try {
      const payload = await fetchRoomState();
      state.roomId = payload.roomId;
      state.roomCode = payload.roomCode;
      state.playerId = payload.playerId;
      state.roomState = payload.view || state.roomState;
      persistSession();
      await openSocket({ reconnecting: true });
    } catch (error) {
      const fatal = /Unknown player|Room code not found/i.test(error.message || "");
      if (fatal) {
        handleReconnectFailure("Your room session expired. Join or create a new room.", { clearRoom: true });
        return;
      }
      if (state.reconnectAttempts >= 4) {
        handleReconnectFailure("Could not reconnect automatically. Use Reconnect to try again.");
        return;
      }
      scheduleReconnect();
      render();
    }
  }

  async function connectToRoom(joinPayload, options = {}) {
    clearQueuePolling();
    clearReconnectTimer();
    state.reconnecting = false;
    state.reconnectAttempts = 0;
    state.queueTicketId = null;
    closeSocket({ manual: true });
    if (options.backendUrl) {
      setBackendUrl(options.backendUrl);
    }
    state.roomId = joinPayload.roomId;
    state.roomCode = joinPayload.roomCode;
    state.playerId = joinPayload.playerId;
    state.roomState = joinPayload.view || null;
    state.reloadRequired = false;
    state.lastActivityPingAt = 0;
    state.connectionState = "connecting";
    state.connectionDetail = `Connecting to room ${state.roomCode}.`;
    persistSession();
    await openSocket(options);
    render();
  }

  async function openSocket(options = {}) {
    if (!state.playerId) {
      return;
    }
    const socketSessionId = state.socketSessionId + 1;
    state.socketSessionId = socketSessionId;
    const ws = new WebSocket(toWebSocketUrl(requireBackendUrl()));
    state.ws = ws;
    state.manualClose = false;
    state.connectionState = options.reconnecting ? "reconnecting" : "connecting";
    state.connectionDetail = options.reconnecting ? `Rejoining room ${state.roomCode}.` : `Connecting to room ${state.roomCode}.`;
    render();

    ws.addEventListener("open", () => {
      if (socketSessionId !== state.socketSessionId) {
        return;
      }
      clearReconnectTimer();
      state.reconnecting = false;
      state.reconnectAttempts = 0;
      state.connectionState = "connected";
      state.connectionDetail =
        state.roomState?.status === "live"
          ? "Connected. The room is live."
          : "Connected. Wait for the other seat or mark ready when both players are in.";
      if (options.restored) {
        setSetupMessage(`Restored room ${state.roomCode}.`);
      }
      if (options.reconnecting) {
        setActionMessage(`Reconnected to room ${state.roomCode}.`);
      }
      sendPresencePing(true);
      render();
    });

    ws.addEventListener("message", (event) => {
      if (socketSessionId !== state.socketSessionId) {
        return;
      }
      const message = JSON.parse(event.data);
      if (message.type === "room_state") {
        state.roomState = message.payload;
        state.roomId = message.payload.roomId;
        state.roomCode = message.payload.roomCode;
        persistSession();
        if (state.connectionState !== "connected") {
          state.connectionState = "connected";
          state.connectionDetail =
            state.roomState?.status === "live"
              ? "Connected. The room is live."
              : "Connected. Wait for the other seat or mark ready when both players are in.";
        }
        render();
        return;
      }
      if (message.type === "pong") {
        return;
      }
      if (message.type === "error") {
        setActionMessage(message.error || "Server error.", true);
      }
    });

    ws.addEventListener("close", (event) => {
      if (socketSessionId !== state.socketSessionId) {
        return;
      }
      state.ws = null;
      if (event.code === 4001) {
        setReloadRequired("Removed after 5 minutes of inactivity. Reload to play again.");
        return;
      }
      if (state.manualClose) {
        state.manualClose = false;
        resetConnectionState();
        render();
        return;
      }
      if (state.roomId && state.playerId) {
        scheduleReconnect();
      } else {
        resetConnectionState();
      }
      render();
    });

    ws.addEventListener("error", () => {
      if (socketSessionId !== state.socketSessionId) {
        return;
      }
      state.connectionState = "reconnecting";
      state.connectionDetail = `Network issue while connected to room ${state.roomCode}.`;
      render();
    });
  }

  function closeSocket(options = {}) {
    const manual = options.manual !== false;
    clearReconnectTimer();
    if (state.ws) {
      state.manualClose = manual;
      state.ws.close();
    }
    state.ws = null;
  }

  function sendMessage(type, payload = {}) {
    if (!state.ws || state.ws.readyState !== 1) {
      throw new Error("Socket is not connected.");
    }
    state.ws.send(JSON.stringify({ type, ...payload }));
  }

  async function createRoom() {
    if (state.reloadRequired) {
      setSetupMessage("Reload to play again after inactivity removal.", true);
      return;
    }
    try {
      const name = requirePlayerName();
      const gameType = selectedGameType();
      const payload = await api("/api/rooms", { method: "POST", body: { name, gameType } });
      setActionMessage(`Created room ${payload.roomCode}.`);
      await connectToRoom(payload);
    } catch (error) {
      setActionMessage(error.message, true);
    }
  }

  async function createBotRoom(humanRole) {
    if (state.reloadRequired) {
      setSetupMessage("Reload to play again after inactivity removal.", true);
      return;
    }
    if (selectedGameType() === "card_market") {
      setActionMessage("Bot rooms are only available for Hidden Value.", true);
      return;
    }
    try {
      const name = requirePlayerName();
      const payload = await api("/api/bot-rooms", { method: "POST", body: { name, humanRole } });
      setActionMessage(`Started bot room ${payload.roomCode}.`);
      await connectToRoom(payload);
    } catch (error) {
      setActionMessage(error.message, true);
    }
  }

  async function joinRoom() {
    if (state.reloadRequired) {
      setSetupMessage("Reload to play again after inactivity removal.", true);
      return;
    }
    try {
      const name = requirePlayerName();
      const code = (elements.joinCode.value || "").trim().toUpperCase();
      if (!code) {
        throw new Error("Enter a room code first.");
      }
      const payload = await api(`/api/rooms/${encodeURIComponent(code)}/join`, { method: "POST", body: { name } });
      setActionMessage(`Joined room ${payload.roomCode}.`);
      await connectToRoom(payload);
    } catch (error) {
      setActionMessage(error.message, true);
    }
  }

  async function queueRandomMatch() {
    if (state.reloadRequired) {
      setQueueStatus("Reload to play again after inactivity removal.", true);
      return;
    }
    if (state.queueTicketId || state.queueJoinPending) {
      return;
    }
    try {
      state.queueJoinPending = true;
      render();
      const name = requirePlayerName();
      const gameType = selectedGameType();
      const payload = await api("/api/matchmaking/join", { method: "POST", body: { name, clientId: state.clientId, gameType } });
      state.queueTicketId = payload.ticketId || null;

      if (payload.status === "matched") {
        setQueueStatus(queueStatusMessage(payload));
        await connectToRoom({
          roomId: payload.roomId,
          roomCode: payload.roomCode,
          playerId: payload.playerId,
          view: null,
        });
        return;
      }

      setQueueStatus(queueStatusMessage(payload));
      clearQueuePolling();
      state.queuePollHandle = window.setInterval(async () => {
        try {
          if (!state.queueTicketId) {
            return;
          }
          const ticket = await api(`/api/matchmaking/${encodeURIComponent(state.queueTicketId)}`);
          if (ticket.status !== "matched") {
            return;
          }
          clearQueuePolling();
          state.queueTicketId = null;
          setQueueStatus(queueStatusMessage(ticket));
          await connectToRoom({
            roomId: ticket.roomId,
            roomCode: ticket.roomCode,
            playerId: ticket.playerId,
            view: null,
          });
        } catch (error) {
          clearQueuePolling();
          state.queueTicketId = null;
          setQueueStatus(error.message, true);
          render();
        }
      }, 1200);
    } catch (error) {
      setQueueStatus(error.message, true);
    } finally {
      state.queueJoinPending = false;
      render();
    }
  }

  async function cancelQueue() {
    if (!state.queueTicketId) {
      return;
    }
    try {
      const payload = await api(`/api/matchmaking/${encodeURIComponent(state.queueTicketId)}`, { method: "DELETE" });
      clearQueuePolling();
      state.queueTicketId = null;
      if (payload.status === "matched") {
        setQueueStatus(queueStatusMessage(payload));
        await connectToRoom({
          roomId: payload.roomId,
          roomCode: payload.roomCode,
          playerId: payload.playerId,
          view: null,
        });
        return;
      }
      setQueueStatus("Queue cancelled.");
    } catch (error) {
      setQueueStatus(error.message, true);
      clearQueuePolling();
      state.queueTicketId = null;
    }
    render();
  }

  function clearRoomConnectionState() {
    state.roomId = null;
    state.roomCode = null;
    state.playerId = null;
    state.roomState = null;
    setBotControlMessage("");
  }

  function setStoredSessionRestoreFailure(message) {
    state.connectionState = "failed";
    state.connectionDetail = message;
    setSetupMessage(message, true);
    render();
  }

  function clearStoredSessionState() {
    clearSession();
    clearRoomConnectionState();
    resetConnectionState();
    render();
  }

  function leaveRoom() {
    clearQueuePolling();
    clearReconnectTimer();
    state.reconnecting = false;
    state.reconnectAttempts = 0;
    state.queueTicketId = null;
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: "leave_room" }));
    }
    closeSocket({ manual: true });
    clearRoomConnectionState();
    state.reloadRequired = false;
    clearSession();
    resetConnectionState();
    setSetupMessage("Disconnected from the room.");
    render();
  }

  function retryConnection() {
    if (state.reloadRequired) {
      setSetupMessage("Reload to play again after inactivity removal.", true);
      return;
    }
    if (state.reconnecting) {
      return;
    }
    const session = readStoredSession();
    if (session) {
      applyStoredSession(session);
    }
    if (!state.roomCode || !state.playerId) {
      if (!session) {
        setSetupMessage("No saved room session is available to reconnect.", true);
        return;
      }
    }
    attemptReconnect();
  }

  function toggleReady() {
    if (!state.roomState) {
      return;
    }
    try {
      sendMessage("ready", { ready: !state.roomState.ready });
    } catch (error) {
      setActionMessage(error.message, true);
    }
  }

  function requestRematch() {
    try {
      sendMessage("request_rematch");
      setActionMessage("Rematch requested.");
    } catch (error) {
      setActionMessage(error.message, true);
    }
  }

  function submitQuote() {
    try {
      const draft = quoteDraft();
      if (!draft.valid) {
        throw new Error(draft.message);
      }
      sendMessage("submit_quote", {
        payload: {
          bid: draft.bid,
          ask: draft.ask,
          size: draft.size,
        },
      });
    } catch (error) {
      setActionMessage(error.message, true);
    }
  }

  function takerAction(action) {
    try {
      sendMessage("taker_action", { payload: { action } });
    } catch (error) {
      setActionMessage(error.message, true);
    }
  }

  function takeCardQuote(targetPlayerId, action) {
    try {
      sendMessage("taker_action", { payload: { action, targetPlayerId } });
    } catch (error) {
      setActionMessage(error.message, true);
    }
  }

  function requestNextReveal() {
    try {
      sendMessage("request_next_reveal");
    } catch (error) {
      setActionMessage(error.message, true);
    }
  }

  async function addCardBots() {
    if (!state.roomCode || !state.playerId) {
      setBotControlMessage("Join a room before adding bots.", true);
      return;
    }
    try {
      const { remainingSeats, nextValue } = clampCardBotCount(state.roomState);
      if (remainingSeats <= 0) {
        throw new Error("No seats are available for additional bots.");
      }
      const payload = await api(`/api/rooms/${encodeURIComponent(state.roomCode)}/card-bots`, {
        method: "POST",
        body: {
          playerId: state.playerId,
          count: nextValue,
        },
      });
      const addedCount = Array.isArray(payload?.added) ? payload.added.length : nextValue;
      setBotControlMessage(`Added ${addedCount} RL bot${addedCount === 1 ? "" : "s"}.`);
      state.cardBotCountDraft = "1";
      render();
    } catch (error) {
      setBotControlMessage(error.message, true);
      render();
    }
  }

  async function removeCardBot(botPlayerId) {
    if (!state.roomCode || !state.playerId) {
      setBotControlMessage("Join a room before removing bots.", true);
      return;
    }
    try {
      const payload = await api(`/api/rooms/${encodeURIComponent(state.roomCode)}/card-bots/${encodeURIComponent(botPlayerId)}`, {
        method: "DELETE",
        body: {
          playerId: state.playerId,
        },
      });
      setBotControlMessage(payload?.deferred ? "Bot marked for removal after the current round." : "Removed RL bot.");
      render();
    } catch (error) {
      setBotControlMessage(error.message, true);
      render();
    }
  }

  async function resumePreviousSession() {
    const session = readStoredSession();
    if (!session) {
      return;
    }

    state.restoring = true;
    try {
      applyStoredSession(session);
      const payload = await fetchRoomState(session.roomCode, session.playerId, state.backendUrl);
      await connectToRoom(payload, { restored: true, backendUrl: state.backendUrl });
    } catch (error) {
      if (isFatalStoredSessionError(error)) {
        clearStoredSessionState();
        setSetupMessage("Saved room session expired. Create or join a new room.", true);
        return;
      }
      setStoredSessionRestoreFailure("Could not restore your saved room automatically. Use Reconnect to try again.");
    } finally {
      state.restoring = false;
      render();
    }
  }

  function provisionalPnl(sideState, game) {
    if (!sideState || !game) {
      return null;
    }
    const mark =
      game.settlement ??
      game.lastResolution?.mark ??
      (game.currentQuote ? (Number(game.currentQuote.bid) + Number(game.currentQuote.ask)) / 2 : null);
    if (mark === null || mark === undefined) {
      return null;
    }
    return sideState.cash + sideState.inventory * mark;
  }

  function renderPlayers(players) {
    elements.playersList.innerHTML = "";
    const gameType = state.roomState?.gameType || selectedGameType();
    if (!players?.length) {
      const li = document.createElement("li");
      li.textContent = "No players in room.";
      elements.playersList.appendChild(li);
      return;
    }

    players.forEach((player) => {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = "player-row";

      const meta = document.createElement("div");
      meta.className = "player-meta";
      const name = document.createElement("strong");
      const seatText = formatRoleLabel(player.role, gameType, player.seatStatus);
      const quoteText = gameType === "card_market" && player.quotingNow ? " · Quoting Now" : "";
      const botText = player.isBot ? ` · ${player.botKind === "card_rl" ? "RL Bot" : "Bot"}` : "";
      const policyText = player.isBot && player.botPolicyVersion ? ` · ${player.botPolicyVersion}` : "";
      const pendingText = gameType === "card_market" && player.pendingRemoval ? " · Removes after round" : "";
      name.textContent = `${player.name}${botText}${policyText} · ${seatText}${quoteText}${pendingText}`;
      const ready = document.createElement("span");
      ready.className = `status-chip${player.ready ? " ready" : ""}`;
      ready.textContent = player.ready ? "Ready" : "Not ready";
      meta.appendChild(name);
      meta.appendChild(ready);

      const connected = document.createElement("span");
      connected.className = `status-chip${player.connected ? " connected" : ""}${player.isBot ? " bot" : ""}`;
      connected.textContent = player.isBot ? "Server Bot" : player.connected ? "Connected" : "Offline";

      row.appendChild(meta);
      row.appendChild(connected);
      li.appendChild(row);
      elements.playersList.appendChild(li);
    });
  }

  function clampCardBotCount(roomState) {
    const maxPlayers = Number(roomState?.table?.maxPlayers || 0);
    const playerCount = Number(roomState?.players?.length || 0);
    const remainingSeats = Math.max(0, maxPlayers - playerCount);
    const rawDraft = String(state.cardBotCountDraft || "").trim();
    const parsed = Number(rawDraft);
    const nextValue = remainingSeats <= 0 ? 0 : Math.max(1, Math.min(remainingSeats, Number.isFinite(parsed) ? Math.trunc(parsed) : 1));
    elements.cardBotCount.min = remainingSeats > 0 ? "1" : "0";
    elements.cardBotCount.max = String(Math.max(remainingSeats, 0));
    elements.cardBotCount.disabled = remainingSeats <= 0;
    if (remainingSeats <= 0) {
      elements.cardBotCount.value = "0";
      return { remainingSeats, nextValue: 0, hasValidDraft: false };
    }
    elements.cardBotCount.value = rawDraft === "" ? state.cardBotCountDraft || "1" : rawDraft;
    return {
      remainingSeats,
      nextValue,
      hasValidDraft: Number.isFinite(parsed) && Math.trunc(parsed) >= 1 && Math.trunc(parsed) <= remainingSeats,
    };
  }

  function renderCardBotPanel(roomState, controlsLocked) {
    const canManageBots =
      roomState?.gameType === "card_market" &&
      roomState?.roomVisibility === "private_room" &&
      roomState?.isHost === true;

    elements.cardBotPanel.classList.toggle("hidden", !canManageBots);
    if (!canManageBots) {
      elements.cardBotList.innerHTML = "";
      setBotControlMessage("");
      return;
    }

    const { remainingSeats, nextValue, hasValidDraft } = clampCardBotCount(roomState);
    const bots = (roomState?.players || []).filter((player) => player.isBot && player.botKind === "card_rl");
    renderStatusMessage(
      elements.cardBotStatus,
      state.botControlMessage || defaultBotControlMessage(roomState),
      state.botControlMessageIsError
    );
    elements.addCardBots.disabled = controlsLocked || !state.roomCode || !state.playerId || remainingSeats <= 0 || nextValue < 1 || !hasValidDraft;
    elements.cardBotList.innerHTML = "";

    if (!bots.length) {
      const li = document.createElement("li");
      li.textContent = "No RL bots in this room.";
      elements.cardBotList.appendChild(li);
      return;
    }

    bots.forEach((bot) => {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = "player-row";

      const meta = document.createElement("div");
      meta.className = "player-meta";
      const title = document.createElement("strong");
      title.textContent = bot.name;
      const detail = document.createElement("span");
      detail.className = "body-copy subtle-copy";
      detail.textContent = bot.pendingRemoval
        ? `RL Bot${bot.botPolicyVersion ? ` · ${bot.botPolicyVersion}` : ""} · Removes after round`
        : `RL Bot${bot.botPolicyVersion ? ` · ${bot.botPolicyVersion}` : ""}`;
      meta.appendChild(title);
      meta.appendChild(detail);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary-button";
      remove.textContent = bot.pendingRemoval ? "Removes After Round" : "Remove";
      remove.disabled = controlsLocked || bot.pendingRemoval;
      remove.addEventListener("click", () => removeCardBot(bot.id));

      row.appendChild(meta);
      row.appendChild(remove);
      li.appendChild(row);
      elements.cardBotList.appendChild(li);
    });
  }

  function renderHistory(log) {
    elements.historyList.innerHTML = "";
    if (!log?.length) {
      const li = document.createElement("li");
      li.textContent = "No turns yet.";
      elements.historyList.appendChild(li);
      return;
    }
    log.forEach((entry) => {
      const li = document.createElement("li");
      li.textContent = entry.text;
      elements.historyList.appendChild(li);
    });
  }

  function renderPositions(positions) {
    elements.positionsList.innerHTML = "";
    if (!positions?.length) {
      const li = document.createElement("li");
      li.textContent = "No positions yet.";
      elements.positionsList.appendChild(li);
      return;
    }

    positions.forEach((entry) => {
      const li = document.createElement("li");
      const rankPrefix = Number.isFinite(entry.rank) ? `${entry.rank}. ` : "";
      li.textContent = `${rankPrefix}${entry.name}: cash ${format(entry.cash)}, inventory ${entry.inventory}, pnl ${format(entry.pnl)}`;
      elements.positionsList.appendChild(li);
    });
  }

  function cardDisplayPositions(roomState, game) {
    if (!game) {
      return [];
    }
    if (roomState?.status === "lobby" && game.previousSummary?.ranking?.length) {
      return game.previousSummary.ranking.map((entry, index) => ({
        ...entry,
        rank: index + 1,
      }));
    }
    return game.positions || [];
  }

  function cardDisplayHistory(roomState, game) {
    if (!game) {
      return [];
    }
    if (roomState?.status === "lobby" && game.previousSummary?.log?.length) {
      return [
        { text: game.previousSummary.text },
        ...game.previousSummary.log,
      ];
    }
    return game.log || [];
  }

  function renderCardQuotes(game) {
    elements.cardQuotesList.innerHTML = "";
    const quotes = game?.liveQuotes || [];
    if (!quotes.length) {
      const li = document.createElement("li");
      li.textContent = "No live quotes yet.";
      elements.cardQuotesList.appendChild(li);
      return;
    }

    quotes.forEach((quote) => {
      const li = document.createElement("li");
      const summary = document.createElement("div");
      summary.textContent = `${quote.playerName}: ${format(quote.bid)} / ${format(quote.ask)} x ${quote.size} · ${formatDuration(quote.msUntilExpiry)} left`;
      li.appendChild(summary);

      if (quote.canTrade && state.roomState?.status === "live") {
        const actions = document.createElement("div");
        actions.className = "action-row top-gap";

        const buy = document.createElement("button");
        buy.className = "primary-button";
        buy.type = "button";
        buy.textContent = "Buy Ask";
        buy.addEventListener("click", () => takeCardQuote(quote.playerId, "buy"));

        const sell = document.createElement("button");
        sell.className = "secondary-button";
        sell.type = "button";
        sell.textContent = "Sell Bid";
        sell.addEventListener("click", () => takeCardQuote(quote.playerId, "sell"));

        actions.appendChild(buy);
        actions.appendChild(sell);
        li.appendChild(actions);
      }

      elements.cardQuotesList.appendChild(li);
    });
  }

  function render() {
    applyTheme();
    renderModeSelection();
    const roomState = state.roomState;
    const game = roomState?.game || null;
    const selectedType = selectedGameType();
    const gameType = roomState?.gameType || selectedType;
    const isCardGame = gameType === "card_market";
    const hasRoom = Boolean(state.roomCode);
    const isLive = roomState?.status === "live";
    const role = roomState?.role || "";
    const you = !isCardGame ? (role === "market_maker" ? game?.maker : role === "market_taker" ? game?.taker : null) : null;
    const opponent = !isCardGame ? (role === "market_maker" ? game?.taker : role === "market_taker" ? game?.maker : null) : null;
    const makerTurn = game?.activeActor === "maker";
    const takerTurn = game?.activeActor === "taker";
    const canQuote = isCardGame ? Boolean(roomState?.cardCapabilities?.canQuote) : roomState?.status === "live" && role === "market_maker" && makerTurn;
    const canTake = !isCardGame && roomState?.status === "live" && role === "market_taker" && takerTurn && game?.currentQuote;
    const isFinished = roomState?.status === "finished";
    const needsReady = roomState?.status === "lobby" && roomState?.matchType !== "bot";
    const pendingRematch = roomState?.rematch?.pendingPlayers || [];
    const boardFullyRevealed = isCardGame ? (game?.boardCards?.length || 0) >= (game?.boardRevealTotal || 0) : false;
    const canVoteReveal = isCardGame ? Boolean(roomState?.cardCapabilities?.canVoteReveal) : false;
    const leadQuote = isCardGame ? game?.liveQuotes?.[0] || null : null;
    const draft = quoteDraft();
    const canSubmitQuote = canQuote && draft.valid;
    const contractPrompt = game?.contract?.prompt || (hasRoom ? "Waiting for the second player so the server can deal a fresh contract." : "Waiting for room");
    const contractUnit = isCardGame ? game?.target?.label || "-" : game?.contract?.unitLabel || "-";
    const contractRange = isCardGame
      ? `Board shown: ${game?.boardCards?.length || 0} / ${game?.boardRevealTotal || 0}. Private hands stay fixed while the table reveals one new card at a time.`
      : game?.contract
        ? `Working range: ${format(game.contract.rangeLow)} to ${format(game.contract.rangeHigh)} ${game.contract.unitLabel}`
        : "The server will load a fresh contract once two players are seated.";
    const liveQuoteAvailable = Boolean(game?.currentQuote);
    const controlsLocked = state.reloadRequired;

    elements.heroSection.classList.toggle("hidden", hasRoom);
    elements.modeSection.classList.remove("hidden");
    elements.setupSection.classList.toggle("hidden", hasRoom);
    elements.sessionSection.classList.toggle("hidden", !hasRoom);
    elements.gameSection.classList.toggle("hidden", !hasRoom);
    elements.lowerSection.classList.toggle("hidden", !hasRoom);
    renderStatusMessage(elements.setupMessage, state.setupMessage || defaultSetupMessage(), state.setupMessageIsError);
    renderStatusMessage(elements.roomActionMessage, state.actionMessage || defaultRoomActionMessage(), state.actionMessageIsError);
    renderStatusMessage(elements.queueStatus, state.queueMessage || defaultQueueMessage(), state.queueMessageIsError);

    setText(elements.connectionStatus, connectionStatusLabel());
    setText(elements.sessionConnectionStatus, connectionStatusLabel());
    setText(
      elements.sessionConnectionDetail,
      state.connectionState === "connected" && roomState ? buildTurnPrompt(role, roomState, game) : state.connectionDetail
    );

    setText(elements.roomCodeDisplay, state.roomCode || "No room");
    setText(elements.roleLabel, formatRoleLabel(role, gameType, roomState?.cardSeatStatus));
    setText(elements.gameStatus, capWords(roomState?.status || "lobby"));
    setText(elements.turnCaption, isCardGame ? "Board" : "Turn");
    setText(elements.activeCaption, isCardGame ? "Table" : "Active actor");
    setText(elements.turnLabel, `${game?.turn || 0} / ${game?.maxTurns || 0}`);
    setText(
      elements.activeActor,
      isCardGame
        ? `${roomState?.table?.activeSeatCount || 0} seated / ${roomState?.table?.playerCount || 0} total`
        : capWords(game?.activeActor || "")
    );
    setText(elements.gameTypeLabel, formatGameType(gameType));
    setText(
      elements.matchType,
      isCardGame ? (roomState?.roomVisibility === "public_table" ? "Public Table" : "Private Room") : roomState?.matchType === "bot" ? "RL Bot" : "Human"
    );
    setText(elements.gameNumber, String(roomState?.gameNumber || 0));

    setText(elements.contractCaption, isCardGame ? "Objective" : "Contract");
    setText(elements.contractPrompt, contractPrompt);
    setText(elements.contractUnit, contractUnit);
    setText(elements.contractRange, contractRange);
    setText(elements.roleHeadline, buildRoleHeadline(role, roomState, game));
    setText(elements.turnPrompt, buildTurnPrompt(role, roomState, game));
    setText(
      elements.roleSummaryTitle,
      isCardGame ? "Market state" : role === "market_maker" ? "Maker seat" : role === "market_taker" ? "Taker seat" : "Game flow"
    );
    if (state.restoring && !role) {
      setText(elements.sideInstructions, "Restoring previous session.");
    } else {
      setText(elements.sideInstructions, buildSideInstructions(role, roomState, game));
    }
    setText(elements.bluffSummary, buildBluffSummary(role, game));

    if (isCardGame && game?.previousSummary?.text) {
      setText(elements.resolutionSummary, game.previousSummary.text);
    } else if (isFinished && pendingRematch.length && !roomState?.rematch?.requested) {
      setText(elements.resolutionSummary, `Settlement is in. Waiting on rematch votes from: ${pendingRematch.join(", ")}.`);
    } else if (isFinished && roomState?.rematch?.requested && pendingRematch.length) {
      setText(elements.resolutionSummary, `Rematch requested. Waiting on: ${pendingRematch.join(", ")}.`);
    } else {
      setText(elements.resolutionSummary, game?.lastResolution?.text || "No turns have resolved yet.");
    }

    const currentBid = isCardGame ? (leadQuote ? format(leadQuote.bid) : "-") : game?.currentQuote ? format(game.currentQuote.bid) : "-";
    const currentAsk = isCardGame ? (leadQuote ? format(leadQuote.ask) : "-") : game?.currentQuote ? format(game.currentQuote.ask) : "-";
    const currentSize = isCardGame ? (leadQuote ? String(leadQuote.size) : "-") : game?.currentQuote ? String(game.currentQuote.size) : "-";
    setText(elements.currentQuoteBid, currentBid);
    setText(elements.currentQuoteAsk, currentAsk);
    setText(elements.currentQuoteSize, currentSize);
    setText(elements.takerQuoteBid, currentBid);
    setText(elements.takerQuoteAsk, currentAsk);
    setText(elements.takerQuoteSize, currentSize);
    setText(elements.previousQuote, formatQuote(game?.previousQuote));
    setText(elements.quoteContext, buildQuoteContext(game));
    setText(elements.quoteCardCaption, isCardGame ? "Your market" : "Maker controls");
    setText(
      elements.quoteCardTitle,
      isCardGame
        ? roomState?.cardSeatStatus === "waiting_next_round"
          ? "Waiting for next round"
          : "Keep a live quote in the room"
        : "Submit a quote"
    );
    setText(
      elements.cardMakerBadge,
      isCardGame
        ? game?.msUntilStart !== null && game?.msUntilStart !== undefined
          ? `Start in: ${formatDuration(game.msUntilStart)}`
          : `Next reveal: ${formatDuration(game?.nextRevealAt ? Math.max(game.nextRevealAt - Date.now(), 0) : game?.msUntilNextReveal)}`
        : isFinished
          ? "Round settled"
          : `Next reveal: ${formatDuration(game?.nextRevealAt ? Math.max(game.nextRevealAt - Date.now(), 0) : game?.msUntilNextReveal)}`
    );
    renderCardRack(
      elements.privateHand,
      game?.privateHand || [],
      roomState?.cardSeatStatus === "waiting_next_round" ? "You will receive cards at the next deal." : "No cards dealt yet."
    );
    renderCardRack(elements.boardCards, game?.boardCards || [], "No board cards revealed yet.");
    setText(elements.handUpdate, describeHandUpdate());
    setText(
      elements.cardResponseStatus,
      isCardGame
        ? game?.msUntilStart !== null && game?.msUntilStart !== undefined
          ? `${roomState?.table?.readyHumanCount || 0} of ${roomState?.table?.readyThreshold || 1} required human votes are in for the next deal.`
          : roomState?.status === "lobby" && game?.previousSummary?.kind === "finished"
            ? `${roomState?.table?.readyHumanCount || 0} of ${roomState?.table?.readyThreshold || 1} required human votes are in. Final standings remain visible until the next deal starts.`
            : roomState?.cardSeatStatus === "waiting_next_round" && isLive
              ? "This round is already live. You are observing until the table returns to lobby."
              : `${game?.revealVotes?.length || 0} of ${game?.revealVotesNeeded || 0} seated players have voted to reveal the next card early.`
        : "No live quote."
    );

    setText(elements.youCash, format(you?.cash || 0));
    setText(elements.youInventory, String(you?.inventory || 0));
    setText(elements.youPnl, game ? format(provisionalPnl(you, game)) : "-");
    setText(elements.oppCash, format(opponent?.cash || 0));
    setText(elements.oppInventory, String(opponent?.inventory || 0));
    setText(elements.settlementValue, game?.settlement === null || game?.settlement === undefined ? "hidden" : format(game.settlement));

    elements.quoteCard.classList.toggle("hidden", isCardGame ? !isLive : role !== "market_maker" || !isLive);
    elements.takerCard.classList.toggle("hidden", isCardGame || role !== "market_taker" || !isLive);
    elements.cardStateCard.classList.toggle("hidden", !isCardGame);
    elements.cardQuotesCard.classList.toggle("hidden", !isCardGame);
    elements.marketCard.classList.toggle("hidden", isCardGame);
    elements.classicPositionCard.classList.toggle("hidden", isCardGame);
    elements.positionsCard.classList.toggle("hidden", !isCardGame);

    elements.submitQuote.disabled = !canSubmitQuote;
    elements.submitQuote.textContent = isCardGame ? (canQuote ? (draft.valid ? "Post Live Quote" : "Fix Quote First") : "Waiting For Next Deal") : canQuote ? (draft.valid ? "Submit Quote" : "Fix Quote First") : "Waiting For Turn";
    elements.takerBuy.disabled = !canTake;
    elements.takerSell.disabled = !canTake;
    elements.takerPass.disabled = !canTake;
    elements.takerBuy.textContent = liveQuoteAvailable ? "Buy Ask" : "Waiting";
    elements.takerSell.textContent = liveQuoteAvailable ? "Sell Bid" : "Waiting";
    elements.takerPass.textContent = liveQuoteAvailable ? "Pass" : "No Quote Yet";
    elements.requestNextReveal.disabled = !canVoteReveal;
    elements.queueMatch.disabled = controlsLocked || Boolean(state.queueTicketId) || Boolean(state.roomCode);
    if (state.queueJoinPending) {
      elements.queueMatch.disabled = true;
    }
    elements.queueMatch.textContent = selectedType === "card_market" ? "Join Public Table" : "Find Random Opponent";
    elements.cancelQueue.disabled = controlsLocked || !state.queueTicketId;
    elements.createRoom.disabled = controlsLocked || Boolean(state.roomCode);
    elements.joinRoom.disabled = controlsLocked || Boolean(state.roomCode);
    elements.playBotMaker.disabled = controlsLocked || selectedType === "card_market" || Boolean(state.roomCode);
    elements.playBotTaker.disabled = controlsLocked || selectedType === "card_market" || Boolean(state.roomCode);

    elements.bidInput.disabled = !canQuote;
    elements.askInput.disabled = !canQuote;
    elements.sizeInput.disabled = !canQuote;

    elements.readyToggle.disabled = controlsLocked || !needsReady;
    elements.readyToggle.textContent =
      isCardGame && game?.previousSummary?.kind === "finished"
        ? roomState?.ready
          ? "Leave Next Deal"
          : "Join Next Deal"
        : roomState?.ready
          ? "Unready"
          : "Mark Ready";
    elements.copyRoomCode.disabled = controlsLocked || !state.roomCode;
    elements.requestRematch.disabled = controlsLocked || isCardGame || !isFinished || Boolean(roomState?.rematch?.requested);
    elements.retryConnection.disabled =
      controlsLocked || !(state.roomCode && state.playerId) || state.reconnecting || state.connectionState === "connected";
    elements.reloadApp.classList.toggle("hidden", !controlsLocked);

    renderPlayers(roomState?.players || []);
    renderCardBotPanel(roomState, controlsLocked);
    renderPositions(isCardGame ? cardDisplayPositions(roomState, game) : game?.positions || []);
    renderCardQuotes(game);
    renderHistory(isCardGame ? cardDisplayHistory(roomState, game) : game?.log || []);
  }

  elements.createRoom.addEventListener("click", createRoom);
  elements.joinRoom.addEventListener("click", joinRoom);
  elements.toggleHiddenValue.addEventListener("click", () => setSelectedGameType("hidden_value"));
  elements.toggleCardMarket.addEventListener("click", () => setSelectedGameType("card_market"));
  elements.queueMatch.addEventListener("click", queueRandomMatch);
  elements.cancelQueue.addEventListener("click", cancelQueue);
  elements.playBotMaker.addEventListener("click", () => createBotRoom("market_maker"));
  elements.playBotTaker.addEventListener("click", () => createBotRoom("market_taker"));
  elements.addCardBots.addEventListener("click", addCardBots);
  elements.cardBotCount.addEventListener("input", () => {
    state.cardBotCountDraft = elements.cardBotCount.value;
    render();
  });
  elements.cardBotCount.addEventListener("blur", () => {
    const roomState = state.roomState;
    const { remainingSeats, nextValue } = clampCardBotCount(roomState);
    state.cardBotCountDraft = remainingSeats <= 0 ? "0" : String(nextValue);
    render();
  });
  elements.readyToggle.addEventListener("click", toggleReady);
  elements.requestRematch.addEventListener("click", requestRematch);
  elements.retryConnection.addEventListener("click", retryConnection);
  elements.reloadApp.addEventListener("click", () => window.location.reload());
  elements.leaveRoom.addEventListener("click", leaveRoom);
  elements.submitQuote.addEventListener("click", submitQuote);
  elements.takerBuy.addEventListener("click", () => takerAction("buy"));
  elements.takerSell.addEventListener("click", () => takerAction("sell"));
  elements.takerPass.addEventListener("click", () => takerAction("pass"));
  elements.requestNextReveal.addEventListener("click", requestNextReveal);
  elements.bidInput.addEventListener("input", render);
  elements.askInput.addEventListener("input", render);
  elements.sizeInput.addEventListener("input", render);

  elements.copyRoomCode.addEventListener("click", async () => {
    if (!state.roomCode) {
      return;
    }
    try {
      await copyText(state.roomCode);
      setActionMessage(`Copied room code ${state.roomCode}.`);
    } catch {
      setActionMessage("Failed to copy room code.", true);
    }
  });

  elements.playerName.addEventListener("change", () => {
    safeStorageSet(STORAGE_KEYS.playerName, (elements.playerName.value || "").trim());
  });

  ["pointerdown", "keydown", "touchstart", "focus"].forEach((eventName) => {
    window.addEventListener(eventName, recordUserActivity, { passive: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      recordUserActivity();
    }
  });

  elements.playerName.value = safeStorageGet(STORAGE_KEYS.playerName) || "";
  state.playerName = elements.playerName.value.trim();
  state.selectedGameType = safeStorageGet(STORAGE_KEYS.selectedGameType) === "card_market" ? "card_market" : "hidden_value";
  setBackendUrl(defaultBackendUrl());
  state.clientId = getOrCreateClientId();
  resetConnectionState();

  applyTheme();
  renderModeSelection();
  render();
  window.setInterval(() => {
    if (state.roomState?.gameType === "card_market" && state.roomState?.status === "live") {
      render();
    }
  }, 1000);
  resumePreviousSession();
})();
