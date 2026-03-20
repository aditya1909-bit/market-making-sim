(function () {
  const DEPLOYED_BACKEND_URL = "https://market-making-sim-backend.adityasdutta.workers.dev";

  const STORAGE_KEYS = {
    backendUrl: "market-making-sim.backend-url",
    playerName: "market-making-sim.player-name",
    session: "market-making-sim.session",
    clientId: "market-making-sim.client-id",
  };

  const elements = {
    connectionStatus: document.getElementById("connection-status"),
    playerName: document.getElementById("player-name"),
    gameType: document.getElementById("game-type"),
    setupMessage: document.getElementById("setup-message"),
    createRoom: document.getElementById("create-room"),
    joinCode: document.getElementById("join-code"),
    joinRoom: document.getElementById("join-room"),
    roomActionMessage: document.getElementById("room-action-message"),
    queueMatch: document.getElementById("queue-match"),
    cancelQueue: document.getElementById("cancel-queue"),
    queueStatus: document.getElementById("queue-status"),
    playBotMaker: document.getElementById("play-bot-maker"),
    playBotTaker: document.getElementById("play-bot-taker"),
    roomCodeDisplay: document.getElementById("room-code-display"),
    copyRoomCode: document.getElementById("copy-room-code"),
    readyToggle: document.getElementById("ready-toggle"),
    requestRematch: document.getElementById("request-rematch"),
    leaveRoom: document.getElementById("leave-room"),
    roleLabel: document.getElementById("role-label"),
    gameStatus: document.getElementById("game-status"),
    turnLabel: document.getElementById("turn-label"),
    activeActor: document.getElementById("active-actor"),
    gameTypeLabel: document.getElementById("game-type-label"),
    matchType: document.getElementById("match-type"),
    gameNumber: document.getElementById("game-number"),
    playersList: document.getElementById("players-list"),
    contractPrompt: document.getElementById("contract-prompt"),
    contractUnit: document.getElementById("contract-unit"),
    contractRange: document.getElementById("contract-range"),
    roleHeadline: document.getElementById("role-headline"),
    turnPrompt: document.getElementById("turn-prompt"),
    roleSummaryTitle: document.getElementById("role-summary-title"),
    sideInstructions: document.getElementById("side-instructions"),
    bluffSummary: document.getElementById("bluff-summary"),
    resolutionSummary: document.getElementById("resolution-summary"),
    quoteCard: document.getElementById("quote-card"),
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
    cardMakerBadge: document.getElementById("card-maker-badge"),
    privateHand: document.getElementById("private-hand"),
    boardCards: document.getElementById("board-cards"),
    cardResponseStatus: document.getElementById("card-response-status"),
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

  function formatCard(card) {
    if (!card) {
      return "-";
    }
    return card.code || `${card.rank}${card.suit}`;
  }

  function formatCards(cards) {
    if (!cards?.length) {
      return "None shown.";
    }
    return cards.map((card) => formatCard(card)).join("  ");
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
      if (role === "market_maker") {
        return "You set the market for this reveal step.";
      }
      if (role === "market_taker") {
        return "You trade against the live maker using your private hand.";
      }
      return "Join a room to receive cards and a turn in the maker rotation.";
    }
    if (role === "market_maker") {
      return "You set the market and decide how much edge to show.";
    }
    if (role === "market_taker") {
      return "You decide whether to buy, sell, or wait.";
    }
    return "Join a room to get a seat.";
  }

  function buildTurnPrompt(role, roomState, game) {
    if (!roomState || !game) {
      return "No active turn.";
    }
    if (roomState.gameType === "card_market") {
      if (roomState.status === "finished") {
        return "The final board is revealed and positions are settled.";
      }
      if (roomState.status === "lobby") {
        return "Waiting for at least two players to mark ready.";
      }
      if (role === "market_maker") {
        return game.activeActor === "maker" ? "Post a market for the current card property." : "Waiting for responders to trade or pass.";
      }
      return game.activeActor === "taker" ? "Trade this quote once, or pass." : "Waiting for the maker to post a quote.";
    }
    if (roomState.status === "finished") {
      return "The round is settled. Review the tape and request a rematch if you want the other side.";
    }
    if (roomState.status === "lobby") {
      return roomState.matchType === "bot"
        ? "The bot room is preparing the next round."
        : "Waiting for both sides to mark ready.";
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
      if (role === "market_maker") {
        return "Use your private cards plus the revealed board to set a tradable market.";
      }
      if (role === "market_taker") {
        return "You can trade the quote once each round while the maker rotates around the table.";
      }
      return "The card market starts once at least two players are ready.";
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
      if (!game?.currentQuote) {
        return "No live quote yet. Private information still dominates.";
      }
      if ((game?.respondedPlayerIds || []).length === 0) {
        return "The maker has shown a market. First responses will reveal whether the quote is off.";
      }
      return `${game.respondedPlayerIds.length} player${game.respondedPlayerIds.length === 1 ? "" : "s"} already responded to this quote.`;
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
      if (!game?.currentQuote) {
        return "Waiting for the current maker to quote.";
      }
      return `${game.currentMakerName || "Maker"} is quoting ${format(game.currentQuote.bid)} / ${format(game.currentQuote.ask)} x ${game.currentQuote.size}.`;
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

  async function connectToRoom(joinPayload, options = {}) {
    clearQueuePolling();
    state.queueTicketId = null;
    state.manualClose = false;
    closeSocket();
    state.roomId = joinPayload.roomId;
    state.roomCode = joinPayload.roomCode;
    state.playerId = joinPayload.playerId;
    state.roomState = joinPayload.view || null;
    persistSession();
    await openSocket(options);
    render();
  }

  async function openSocket(options = {}) {
    if (!state.playerId) {
      return;
    }
    const ws = new WebSocket(toWebSocketUrl(requireBackendUrl()));
    state.ws = ws;
    setText(elements.connectionStatus, "Connecting");

    ws.addEventListener("open", () => {
      setText(elements.connectionStatus, "Connected");
      if (options.restored) {
        setSetupMessage(`Restored room ${state.roomCode}.`);
      }
      render();
    });

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "room_state") {
        state.roomState = message.payload;
        state.roomId = message.payload.roomId;
        state.roomCode = message.payload.roomCode;
        persistSession();
        render();
        return;
      }
      if (message.type === "error") {
        setActionMessage(message.error || "Server error.", true);
      }
    });

    ws.addEventListener("close", () => {
      setText(elements.connectionStatus, state.roomId ? "Disconnected" : "Not connected");
      state.ws = null;
      render();
    });

    ws.addEventListener("error", () => {
      setText(elements.connectionStatus, "Socket error");
    });
  }

  function closeSocket() {
    if (state.ws) {
      state.manualClose = true;
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
      const gameType = elements.gameType.value || "hidden_value";
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
      const payload = await api("/api/matchmaking/join", { method: "POST", body: { name, clientId: state.clientId } });
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
    state.queueTicketId = null;
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: "leave_room" }));
    }
    closeSocket();
    state.roomId = null;
    state.roomCode = null;
    state.playerId = null;
    state.roomState = null;
    clearSession();
    setText(elements.connectionStatus, "Not connected");
    setSetupMessage("Disconnected from the room.");
    render();
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
      sendMessage("submit_quote", {
        payload: {
          bid: Number(elements.bidInput.value),
          ask: Number(elements.askInput.value),
          size: Number(elements.sizeInput.value),
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
      const payload = await api(`/api/rooms/${encodeURIComponent(session.roomCode)}/state?playerId=${encodeURIComponent(session.playerId)}`);
      await connectToRoom(payload, { restored: true });
    } catch {
      clearSession();
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
      name.textContent = `${player.name}${player.isBot ? " · RL Bot" : ""} · ${capWords(player.role)}`;
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

  function render() {
    const roomState = state.roomState;
    const game = roomState?.game || null;
    const gameType = roomState?.gameType || "hidden_value";
    const isCardGame = gameType === "card_market";
    const role = roomState?.role || "";
    const you = !isCardGame ? (role === "market_maker" ? game?.maker : role === "market_taker" ? game?.taker : null) : null;
    const opponent = !isCardGame ? (role === "market_maker" ? game?.taker : role === "market_taker" ? game?.maker : null) : null;
    const makerTurn = game?.activeActor === "maker";
    const takerTurn = game?.activeActor === "taker";
    const alreadyResponded = isCardGame ? (game?.respondedPlayerIds || []).includes(state.playerId) : false;
    const canQuote = roomState?.status === "live" && role === "market_maker" && makerTurn;
    const canTake = roomState?.status === "live" && role === "market_taker" && takerTurn && game?.currentQuote && !alreadyResponded;
    const isFinished = roomState?.status === "finished";
    const needsReady = roomState?.status === "lobby" && roomState?.matchType !== "bot";
    const pendingRematch = roomState?.rematch?.pendingPlayers || [];

    setText(elements.roomCodeDisplay, state.roomCode || "No room");
    setText(elements.roleLabel, capWords(role));
    setText(elements.gameStatus, capWords(roomState?.status || "lobby"));
    setText(elements.turnLabel, `${game?.turn || 0} / ${game?.maxTurns || 0}`);
    setText(elements.activeActor, capWords(game?.activeActor || ""));
    setText(elements.gameTypeLabel, formatGameType(gameType));
    setText(elements.matchType, roomState?.matchType === "bot" ? "RL Bot" : "Human");
    setText(elements.gameNumber, String(roomState?.gameNumber || 0));

    setText(elements.contractPrompt, game?.contract?.prompt || "Waiting for room");
    setText(elements.contractUnit, game?.contract?.unitLabel || "-");
    setText(
      elements.contractRange,
      game?.contract
        ? `Working range: ${format(game.contract.rangeLow)} to ${format(game.contract.rangeHigh)} ${game.contract.unitLabel}`
        : "Range: -"
    );
    setText(elements.roleHeadline, buildRoleHeadline(role, roomState, game));
    setText(elements.turnPrompt, buildTurnPrompt(role, roomState, game));
    setText(
      elements.roleSummaryTitle,
      role === "market_maker" ? "Maker seat" : role === "market_taker" ? "Taker seat" : "Game flow"
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

    const currentBid = game?.currentQuote ? format(game.currentQuote.bid) : "-";
    const currentAsk = game?.currentQuote ? format(game.currentQuote.ask) : "-";
    const currentSize = game?.currentQuote ? String(game.currentQuote.size) : "-";
    setText(elements.currentQuoteBid, currentBid);
    setText(elements.currentQuoteAsk, currentAsk);
    setText(elements.currentQuoteSize, currentSize);
    setText(elements.takerQuoteBid, currentBid);
    setText(elements.takerQuoteAsk, currentAsk);
    setText(elements.takerQuoteSize, currentSize);
    setText(elements.previousQuote, formatQuote(game?.previousQuote));
    setText(elements.quoteContext, buildQuoteContext(game));
    setText(elements.cardMakerBadge, `Maker: ${game?.currentMakerName || "-"}`);
    setText(elements.privateHand, formatCards(game?.privateHand || []));
    setText(elements.boardCards, formatCards(game?.boardCards || []));
    setText(
      elements.cardResponseStatus,
      isCardGame
        ? game?.currentQuote
          ? `${(game?.respondedPlayerIds || []).length} of ${Math.max((roomState?.players?.length || 1) - 1, 0)} responders are done.`
          : "No live quote."
        : "No live quote."
    );

    setText(elements.youCash, format(you?.cash || 0));
    setText(elements.youInventory, String(you?.inventory || 0));
    setText(elements.youPnl, game ? format(provisionalPnl(you, game)) : "-");
    setText(elements.oppCash, format(opponent?.cash || 0));
    setText(elements.oppInventory, String(opponent?.inventory || 0));
    setText(elements.settlementValue, game?.settlement === null || game?.settlement === undefined ? "hidden" : format(game.settlement));

    elements.quoteCard.classList.toggle("hidden", role !== "market_maker");
    elements.takerCard.classList.toggle("hidden", role !== "market_taker");
    elements.cardStateCard.classList.toggle("hidden", !isCardGame);
    elements.classicPositionCard.classList.toggle("hidden", isCardGame);
    elements.positionsCard.classList.toggle("hidden", !isCardGame);

    elements.submitQuote.disabled = !canQuote;
    elements.takerBuy.disabled = !canTake;
    elements.takerSell.disabled = !canTake;
    elements.takerPass.disabled = !canTake;
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

    renderPlayers(roomState?.players || []);
    renderPositions(game?.positions || []);
    renderHistory(game?.log || []);
  }

  elements.createRoom.addEventListener("click", createRoom);
  elements.joinRoom.addEventListener("click", joinRoom);
  elements.queueMatch.addEventListener("click", queueRandomMatch);
  elements.cancelQueue.addEventListener("click", cancelQueue);
  elements.playBotMaker.addEventListener("click", () => createBotRoom("market_maker"));
  elements.playBotTaker.addEventListener("click", () => createBotRoom("market_taker"));
  elements.readyToggle.addEventListener("click", toggleReady);
  elements.requestRematch.addEventListener("click", requestRematch);
  elements.leaveRoom.addEventListener("click", leaveRoom);
  elements.submitQuote.addEventListener("click", submitQuote);
  elements.takerBuy.addEventListener("click", () => takerAction("buy"));
  elements.takerSell.addEventListener("click", () => takerAction("sell"));
  elements.takerPass.addEventListener("click", () => takerAction("pass"));

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
  state.backendUrl = defaultBackendUrl();
  state.clientId = getOrCreateClientId();

  render();
  resumePreviousSession();
})();
