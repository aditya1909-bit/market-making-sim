(function () {
  const DEPLOYED_BACKEND_URL = "https://market-making-sim-backend.adityasdutta.workers.dev";

  const STORAGE_KEYS = {
    backendUrl: "market-making-sim.backend-url",
    playerName: "market-making-sim.player-name",
    session: "market-making-sim.session",
  };

  const elements = {
    connectionStatus: document.getElementById("connection-status"),
    playerName: document.getElementById("player-name"),
    backendUrl: document.getElementById("backend-url"),
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
    matchType: document.getElementById("match-type"),
    gameNumber: document.getElementById("game-number"),
    playersList: document.getElementById("players-list"),
    contractPrompt: document.getElementById("contract-prompt"),
    contractUnit: document.getElementById("contract-unit"),
    contractRange: document.getElementById("contract-range"),
    sideInstructions: document.getElementById("side-instructions"),
    resolutionSummary: document.getElementById("resolution-summary"),
    bidInput: document.getElementById("bid-input"),
    askInput: document.getElementById("ask-input"),
    sizeInput: document.getElementById("size-input"),
    submitQuote: document.getElementById("submit-quote"),
    currentQuoteBid: document.getElementById("current-quote-bid"),
    currentQuoteAsk: document.getElementById("current-quote-ask"),
    currentQuoteSize: document.getElementById("current-quote-size"),
    takerBuy: document.getElementById("taker-buy"),
    takerSell: document.getElementById("taker-sell"),
    takerPass: document.getElementById("taker-pass"),
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

  function normalizeBackendUrl(input) {
    return String(input || "")
      .trim()
      .replace(/\/+$/, "");
  }

  function requireBackendUrl() {
    state.backendUrl = normalizeBackendUrl(elements.backendUrl.value);
    if (!state.backendUrl) {
      throw new Error("Enter a backend URL first.");
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
        backendUrl: normalizeBackendUrl(elements.backendUrl.value),
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
      const payload = await api("/api/rooms", { method: "POST", body: { name } });
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
    try {
      const name = requirePlayerName();
      const payload = await api("/api/matchmaking/join", { method: "POST", body: { name } });
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
        elements.backendUrl.value = preferredBackend;
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

  function render() {
    const roomState = state.roomState;
    const game = roomState?.game || null;
    const role = roomState?.role || "";
    const you = role === "market_maker" ? game?.maker : role === "market_taker" ? game?.taker : null;
    const opponent = role === "market_maker" ? game?.taker : role === "market_taker" ? game?.maker : null;
    const makerTurn = game?.activeActor === "maker";
    const takerTurn = game?.activeActor === "taker";
    const canQuote = roomState?.status === "live" && role === "market_maker" && makerTurn;
    const canTake = roomState?.status === "live" && role === "market_taker" && takerTurn && game?.currentQuote;
    const isFinished = roomState?.status === "finished";
    const needsReady = roomState?.status === "lobby" && roomState?.matchType !== "bot";
    const pendingRematch = roomState?.rematch?.pendingPlayers || [];

    setText(elements.roomCodeDisplay, state.roomCode || "No room");
    setText(elements.roleLabel, capWords(role));
    setText(elements.gameStatus, capWords(roomState?.status || "lobby"));
    setText(elements.turnLabel, `${game?.turn || 0} / ${game?.maxTurns || 0}`);
    setText(elements.activeActor, capWords(game?.activeActor || ""));
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

    if (role === "market_maker") {
      setText(elements.sideInstructions, "You are the market maker. Quote a bid and ask when it is your turn.");
    } else if (role === "market_taker") {
      setText(elements.sideInstructions, "You are the market taker. Decide whether to buy the ask, sell the bid, or pass.");
    } else if (state.restoring) {
      setText(elements.sideInstructions, "Restoring previous session.");
    } else {
      setText(elements.sideInstructions, "Create, join, or resume a room to receive a role.");
    }

    if (isFinished && pendingRematch.length && !roomState?.rematch?.requested) {
      setText(elements.resolutionSummary, `Settlement is in. Waiting on rematch votes from: ${pendingRematch.join(", ")}.`);
    } else if (isFinished && roomState?.rematch?.requested && pendingRematch.length) {
      setText(elements.resolutionSummary, `Rematch requested. Waiting on: ${pendingRematch.join(", ")}.`);
    } else {
      setText(elements.resolutionSummary, game?.lastResolution?.text || "No turns have resolved yet.");
    }

    setText(elements.currentQuoteBid, game?.currentQuote ? format(game.currentQuote.bid) : "-");
    setText(elements.currentQuoteAsk, game?.currentQuote ? format(game.currentQuote.ask) : "-");
    setText(elements.currentQuoteSize, game?.currentQuote ? String(game.currentQuote.size) : "-");

    setText(elements.youCash, format(you?.cash || 0));
    setText(elements.youInventory, String(you?.inventory || 0));
    setText(elements.youPnl, game ? format(provisionalPnl(you, game)) : "-");
    setText(elements.oppCash, format(opponent?.cash || 0));
    setText(elements.oppInventory, String(opponent?.inventory || 0));
    setText(elements.settlementValue, game?.settlement === null || game?.settlement === undefined ? "hidden" : format(game.settlement));

    elements.submitQuote.disabled = !canQuote;
    elements.takerBuy.disabled = !canTake;
    elements.takerSell.disabled = !canTake;
    elements.takerPass.disabled = !canTake;
    elements.queueMatch.disabled = Boolean(state.queueTicketId) || Boolean(state.roomCode);
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

  elements.backendUrl.addEventListener("change", () => {
    safeStorageSet(STORAGE_KEYS.backendUrl, normalizeBackendUrl(elements.backendUrl.value));
  });

  elements.playerName.value = safeStorageGet(STORAGE_KEYS.playerName) || "";
  elements.backendUrl.value = defaultBackendUrl();
  state.playerName = elements.playerName.value.trim();
  state.backendUrl = elements.backendUrl.value.trim();

  render();
  resumePreviousSession();
})();
