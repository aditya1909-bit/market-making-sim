import http from "node:http";
import { URL } from "node:url";
import { WebSocketServer } from "ws";
import { RoomManager } from "./room-manager.js";
import { SERVER_EVENTS } from "../shared/protocol.js";

const PORT = Number(process.env.PORT || 8787);
const roomManager = new RoomManager();

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    json(res, 400, { error: "Missing URL." });
    return;
  }

  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readJsonBody(req);
      const { room, player } = roomManager.createRoom(body.name);
      json(res, 201, roomManager.serializeRoomJoin(room, player));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/rooms/") && url.pathname.endsWith("/join")) {
      const parts = url.pathname.split("/");
      const code = parts[3];
      const body = await readJsonBody(req);
      const { room, player } = roomManager.joinRoomByCode(code, body.name);
      json(res, 200, roomManager.serializeRoomJoin(room, player));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/matchmaking/join") {
      const body = await readJsonBody(req);
      json(res, 200, roomManager.enqueueRandom(body.name));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/matchmaking/")) {
      const ticketId = url.pathname.split("/")[3];
      json(res, 200, roomManager.getMatchmakingTicket(ticketId));
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/matchmaking/")) {
      const ticketId = url.pathname.split("/")[3];
      json(res, 200, roomManager.cancelMatchmakingTicket(ticketId));
      return;
    }

    json(res, 404, { error: "Not found." });
  } catch (error) {
    json(res, 400, { error: error.message || "Request failed." });
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url) {
    socket.destroy();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const playerId = url.searchParams.get("playerId");
  if (!playerId) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.playerId = playerId;
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  try {
    roomManager.connectSocket(ws.playerId, ws);
  } catch (error) {
    ws.send(JSON.stringify({ type: SERVER_EVENTS.ERROR, error: error.message || "Connection failed." }));
    ws.close();
    return;
  }

  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw));
      roomManager.handleClientEvent(ws.playerId, message);
    } catch (error) {
      ws.send(JSON.stringify({ type: SERVER_EVENTS.ERROR, error: error.message || "Message failed." }));
    }
  });

  ws.on("close", () => {
    try {
      roomManager.disconnectSocket(ws.playerId);
    } catch (error) {
      // noop on disconnect cleanup
    }
  });
});

server.listen(PORT, () => {
  console.log(`market-making-sim backend listening on :${PORT}`);
});
