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

  function formatRoleLabel(role, gameType) {
    if (gameType === "card_market") {
      if (role === "quoting") {
        return "Quoting";
      }
      if (role === "trader") {
        return "Trader";
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
    return "hidden_value";
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
    elements.toggleHiddenValue.classList.add("mode-toggle-active");
    elements.toggleCardMarket.classList.remove("mode-toggle-active");

    setText(elements.heroTitle, "One hidden value. One market.");
    setText(
      elements.heroText,
      "Create a private room, join by code, or queue into a random match. The maker quotes a market, the taker chooses buy, sell, or pass, and settlement stays hidden until the round ends."
    );
    setText(
      elements.modeDescription,
      "Hidden Value is the current polished mode: a fast 1v1 market-making game with private settlement, reconnect support, and authoritative multiplayer state."
    );
    setText(elements.setupMessage, "The site connects to the live game server automatically. Refreshing the page restores your room when possible.");
    setText(elements.roomActionMessage, "Private rooms are best for playing a specific friend.");
    setText(elements.queueTitle, "Queue into the next game");
    setText(elements.queueStatus, "Not in matchmaking queue.");
    setText(elements.botTitle, "Play the trained model");
    setText(elements.cardInfoTitle, "How this game runs");
    setText(elements.cardInfoPrivate, "Each player starts with 2 private cards from a standard 52-card deck. Your hand stays fixed for the full round.");
    setText(elements.cardInfoTrading, "There is no maker turn. Anyone can post a live market and anyone else can trade against it.");
    setText(elements.cardInfoTiming, "The round runs on a shared clock. Cards reveal automatically, or faster if everyone votes to reveal early.");
    elements.profileCard.classList.remove("hidden");
    elements.privateRoomCard.classList.remove("hidden");
    elements.randomMatchCard.classList.remove("hidden");
    elements.rlBotCard.classList.remove("hidden");
    elements.cardMarketInfoCard.classList.add("hidden");
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
      if (roomState?.status === "live") {
        return "You can quote the market and trade against anyone else's live quote.";
      }
      return "Join a room to receive private cards and trade the shared board reveal.";
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
      if (roomState.status === "finished") {
        return "The clock is over. Review the final board and settled positions.";
      }
      if (roomState.status === "lobby") {
        return "Waiting for at least two players to mark ready.";
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
      if (roomState.status === "live") {
        return "Keep a live quote in the room if you want to make markets, and hit or lift other players when they are off.";
      }
      return "The timed card market starts once everyone in the room is ready.";
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
        return "Waiting for the first live quote.";
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
    state.backendUrl = normalizeBackendUrl(state.backendUrl || defaultBackendUrl());
    if (!state.backendUrl) {
      throw new Error("Backend URL is not configured.");
    }
    safeStorageSet(STORAGE_KEYS.backendUrl, state.backendUrl);
    return state.backendUrl;
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
      return parsed;
    } catch {
      return null;
    }
  }

  async function api(path, options = {}) {
    const base = requireBackendUrl();
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
    elements.roomActionMessage.textContent = message;
    elements.roomActionMessage.style.color = isError ? "var(--red)" : "";
  }

  function setQueueStatus(message, isError = false) {
    elements.queueStatus.textContent = message;
    elements.queueStatus.style.color = isError ? "var(--red)" : "";
  }

  function setSetupMessage(message, isError = false) {
    elements.setupMessage.textContent = message;
    elements.setupMessage.style.color = isError ? "var(--red)" : "";
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

  function resetConnectionState() {
    state.reconnecting = false;
    state.reconnectAttempts = 0;
    state.connectionState = state.roomId ? "disconnected" : "idle";
    state.connectionDetail = state.roomId
      ? "You are not connected to the room right now."
      : "Create, join, or queue into a room to start playing.";
  }

  function fetchRoomState(roomCode = state.roomCode, playerId = state.playerId) {
    return api(`/api/rooms/${encodeURIComponent(roomCode)}/state?playerId=${encodeURIComponent(playerId)}`);
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
    state.roomId = joinPayload.roomId;
    state.roomCode = joinPayload.roomCode;
    state.playerId = joinPayload.playerId;
    state.roomState = joinPayload.view || null;
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
      if (message.type === "error") {
        setActionMessage(message.error || "Server error.", true);
      }
    });

    ws.addEventListener("close", () => {
      if (socketSessionId !== state.socketSessionId) {
        return;
      }
      state.ws = null;
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
    if (state.queueTicketId || state.queueJoinPending) {
      return;
    }
    try {
      state.queueJoinPending = true;
      render();
      const name = requirePlayerName();
      const gameType = selectedGameType();
      const payload = await api("/api/matchmaking/join", { method: "POST", body: { name, clientId: state.clientId, gameType } });
      state.queueTicketId = payload.ticketId;

      if (payload.status === "matched") {
        setQueueStatus(`Matched into room ${payload.roomCode}.`);
        await connectToRoom({
          roomId: payload.roomId,
          roomCode: payload.roomCode,
          playerId: payload.playerId,
          view: null,
        });
        return;
      }

      setQueueStatus("Searching for opponent...");
      clearQueuePolling();
      state.queuePollHandle = window.setInterval(async () => {
        try {
          const ticket = await api(`/api/matchmaking/${encodeURIComponent(state.queueTicketId)}`);
          if (ticket.status !== "matched") {
            return;
          }
          clearQueuePolling();
          state.queueTicketId = null;
          setQueueStatus(`Matched into room ${ticket.roomCode}.`);
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
      await api(`/api/matchmaking/${encodeURIComponent(state.queueTicketId)}`, { method: "DELETE" });
      setQueueStatus("Queue cancelled.");
    } catch (error) {
      setQueueStatus(error.message, true);
    } finally {
      clearQueuePolling();
      state.queueTicketId = null;
      render();
    }
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
    state.roomId = null;
    state.roomCode = null;
    state.playerId = null;
    state.roomState = null;
    clearSession();
    resetConnectionState();
    setSetupMessage("Disconnected from the room.");
    render();
  }

  function retryConnection() {
    if (state.reconnecting) {
      return;
    }
    if (!state.roomCode || !state.playerId) {
      const session = readStoredSession();
      if (!session) {
        setSetupMessage("No saved room session is available to reconnect.", true);
        return;
      }
      state.roomCode = session.roomCode;
      state.roomId = session.roomId || null;
      state.playerId = session.playerId;
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

  async function resumePreviousSession() {
    const session = readStoredSession();
    if (!session) {
      return;
    }

    state.restoring = true;
    try {
      const preferredBackend = normalizeBackendUrl(session.backendUrl);
      if (preferredBackend && !safeStorageGet(STORAGE_KEYS.backendUrl)) {
        state.backendUrl = preferredBackend;
      }
      const payload = await fetchRoomState(session.roomCode, session.playerId);
      await connectToRoom(payload, { restored: true });
    } catch {
      clearSession();
      setSetupMessage("Saved room session expired. Create or join a new room.");
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
      name.textContent = `${player.name}${player.isBot ? " · RL Bot" : ""} · ${formatRoleLabel(player.role, gameType)}`;
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
      li.textContent = `${entry.name}: cash ${format(entry.cash)}, inventory ${entry.inventory}, pnl ${format(entry.pnl)}`;
      elements.positionsList.appendChild(li);
    });
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
    const canQuote = isCardGame ? isLive : roomState?.status === "live" && role === "market_maker" && makerTurn;
    const canTake = !isCardGame && roomState?.status === "live" && role === "market_taker" && takerTurn && game?.currentQuote;
    const isFinished = roomState?.status === "finished";
    const needsReady = roomState?.status === "lobby" && roomState?.matchType !== "bot";
    const pendingRematch = roomState?.rematch?.pendingPlayers || [];
    const boardFullyRevealed = isCardGame ? (game?.boardCards?.length || 0) >= (game?.boardRevealTotal || 0) : false;
    const canVoteReveal = isCardGame && isLive && !boardFullyRevealed && !game?.revealRequestedByYou;
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

    elements.heroSection.classList.toggle("hidden", hasRoom);
    elements.modeSection.classList.toggle("hidden", hasRoom);
    elements.setupSection.classList.toggle("hidden", hasRoom);
    elements.sessionSection.classList.toggle("hidden", !hasRoom);
    elements.gameSection.classList.toggle("hidden", !hasRoom);
    elements.lowerSection.classList.toggle("hidden", !hasRoom);

    setText(elements.connectionStatus, connectionStatusLabel());
    setText(elements.sessionConnectionStatus, connectionStatusLabel());
    setText(
      elements.sessionConnectionDetail,
      state.connectionState === "connected" && roomState ? buildTurnPrompt(role, roomState, game) : state.connectionDetail
    );

    setText(elements.roomCodeDisplay, state.roomCode || "No room");
    setText(elements.roleLabel, formatRoleLabel(role, gameType));
    setText(elements.gameStatus, capWords(roomState?.status || "lobby"));
    setText(elements.turnCaption, isCardGame ? "Board" : "Turn");
    setText(elements.activeCaption, isCardGame ? "Market" : "Active actor");
    setText(elements.turnLabel, `${game?.turn || 0} / ${game?.maxTurns || 0}`);
    setText(elements.activeActor, isCardGame ? `${game?.liveQuotes?.length || 0} live` : capWords(game?.activeActor || ""));
    setText(elements.gameTypeLabel, formatGameType(gameType));
    setText(elements.matchType, roomState?.matchType === "bot" ? "RL Bot" : "Human");
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

    if (isFinished && pendingRematch.length && !roomState?.rematch?.requested) {
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
    setText(elements.quoteCardTitle, isCardGame ? "Keep a live quote in the room" : "Submit a quote");
    setText(
      elements.cardMakerBadge,
      isFinished ? "Round settled" : `Next reveal: ${formatDuration(game?.nextRevealAt ? Math.max(game.nextRevealAt - Date.now(), 0) : game?.msUntilNextReveal)}`
    );
    renderCardRack(elements.privateHand, game?.privateHand || [], "No cards dealt yet.");
    renderCardRack(elements.boardCards, game?.boardCards || [], "No board cards revealed yet.");
    setText(elements.handUpdate, describeHandUpdate());
    setText(
      elements.cardResponseStatus,
      isCardGame
        ? isFinished
          ? `Final board revealed. Settlement ${format(game?.settlement)}.`
          : `${game?.revealVotes?.length || 0} of ${game?.revealVotesNeeded || 0} players have voted to reveal the next card early.`
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
    elements.cardStateCard.classList.toggle("hidden", !isCardGame || (!isLive && !isFinished));
    elements.cardQuotesCard.classList.toggle("hidden", !isCardGame || (!isLive && !isFinished));
    elements.marketCard.classList.toggle("hidden", isCardGame);
    elements.classicPositionCard.classList.toggle("hidden", isCardGame);
    elements.positionsCard.classList.toggle("hidden", !isCardGame);

    elements.submitQuote.disabled = !canSubmitQuote;
    elements.submitQuote.textContent = canQuote ? (draft.valid ? "Submit Quote" : "Fix Quote First") : "Waiting For Turn";
    elements.takerBuy.disabled = !canTake;
    elements.takerSell.disabled = !canTake;
    elements.takerPass.disabled = !canTake;
    elements.takerBuy.textContent = liveQuoteAvailable ? "Buy Ask" : "Waiting";
    elements.takerSell.textContent = liveQuoteAvailable ? "Sell Bid" : "Waiting";
    elements.takerPass.textContent = liveQuoteAvailable ? "Pass" : "No Quote Yet";
    elements.requestNextReveal.disabled = !canVoteReveal;
    elements.queueMatch.disabled = Boolean(state.queueTicketId) || Boolean(state.roomCode);
    if (state.queueJoinPending) {
      elements.queueMatch.disabled = true;
    }
    elements.cancelQueue.disabled = !state.queueTicketId;
    elements.createRoom.disabled = Boolean(state.roomCode);
    elements.joinRoom.disabled = Boolean(state.roomCode);
    elements.playBotMaker.disabled = Boolean(state.roomCode);
    elements.playBotTaker.disabled = Boolean(state.roomCode);

    elements.bidInput.disabled = !canQuote;
    elements.askInput.disabled = !canQuote;
    elements.sizeInput.disabled = !canQuote;

    elements.readyToggle.disabled = !needsReady;
    elements.readyToggle.textContent = roomState?.ready ? "Unready" : "Mark Ready";
    elements.copyRoomCode.disabled = !state.roomCode;
    elements.requestRematch.disabled = !isFinished || Boolean(roomState?.rematch?.requested);
    elements.retryConnection.disabled = !(state.roomCode && state.playerId) || state.reconnecting || state.connectionState === "connected";

    renderPlayers(roomState?.players || []);
    renderPositions(game?.positions || []);
    renderCardQuotes(game);
    renderHistory(game?.log || []);
  }

  elements.createRoom.addEventListener("click", createRoom);
  elements.joinRoom.addEventListener("click", joinRoom);
  elements.toggleHiddenValue.addEventListener("click", () => setSelectedGameType("hidden_value"));
  elements.toggleCardMarket.addEventListener("click", () => setSelectedGameType("card_market"));
  elements.queueMatch.addEventListener("click", queueRandomMatch);
  elements.cancelQueue.addEventListener("click", cancelQueue);
  elements.playBotMaker.addEventListener("click", () => createBotRoom("market_maker"));
  elements.playBotTaker.addEventListener("click", () => createBotRoom("market_taker"));
  elements.readyToggle.addEventListener("click", toggleReady);
  elements.requestRematch.addEventListener("click", requestRematch);
  elements.retryConnection.addEventListener("click", retryConnection);
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

  elements.playerName.value = safeStorageGet(STORAGE_KEYS.playerName) || "";
  state.playerName = elements.playerName.value.trim();
  state.selectedGameType = "hidden_value";
  state.backendUrl = defaultBackendUrl();
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
