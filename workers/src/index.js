import { MatchmakerDurableObject } from "./matchmaker-do.js";
import { RoomDurableObject } from "./room-do.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function randomCode(length = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  while (out.length < length) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function roomStubForCode(env, code) {
  const roomId = env.ROOM.idFromName(code.toUpperCase());
  return env.ROOM.get(roomId);
}

async function createPrivateRoom(env, name, gameType = "hidden_value") {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = randomCode();
    const response = await roomStubForCode(env, code).fetch("https://room/internal/create", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ name, code, gameType }),
    });

    if (response.status === 409) {
      continue;
    }
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not create room.");
    }
    return payload;
  }

  throw new Error("Could not allocate a room code.");
}

async function createBotRoom(env, name, humanRole) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = randomCode();
    const response = await roomStubForCode(env, code).fetch("https://room/internal/create-bot", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ name, code, humanRole }),
    });

    if (response.status === 409) {
      continue;
    }
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not create bot room.");
    }
    return payload;
  }

  throw new Error("Could not allocate a room code.");
}

export { RoomDurableObject, MatchmakerDurableObject };

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);

    try {
      if (request.headers.get("Upgrade") === "websocket" && url.pathname === "/ws") {
        const roomCode = String(url.searchParams.get("roomCode") || "").toUpperCase();
        if (!roomCode) {
          return new Response("Missing roomCode.", { status: 400 });
        }
        return roomStubForCode(env, roomCode).fetch(request);
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/api/rooms") {
        const body = await readJson(request);
        return json(await createPrivateRoom(env, body.name, body.gameType), 201);
      }

      if (request.method === "POST" && url.pathname === "/api/bot-rooms") {
        const body = await readJson(request);
        return json(await createBotRoom(env, body.name, body.humanRole), 201);
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/rooms/") && url.pathname.endsWith("/state")) {
        const code = url.pathname.split("/")[3];
        const playerId = url.searchParams.get("playerId");
        const target = new URL("https://room/internal/state");
        if (playerId) {
          target.searchParams.set("playerId", playerId);
        }
        const response = await roomStubForCode(env, code).fetch(target.toString());
        return withCors(response);
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/rooms/") && url.pathname.endsWith("/join")) {
        const code = url.pathname.split("/")[3];
        const body = await readJson(request);
        const response = await roomStubForCode(env, code).fetch("https://room/internal/join", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: body.name }),
        });
        return withCors(response);
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/rooms/") && url.pathname.endsWith("/card-bots")) {
        const code = url.pathname.split("/")[3];
        const body = await readJson(request);
        const response = await roomStubForCode(env, code).fetch("https://room/internal/card-bots", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            playerId: body.playerId,
            count: body.count,
            policyVersion: body.policyVersion,
          }),
        });
        return withCors(response);
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/api/rooms/") && url.pathname.includes("/card-bots/")) {
        const [, , , code, , botPlayerId] = url.pathname.split("/");
        const body = await readJson(request);
        const response = await roomStubForCode(env, code).fetch(`https://room/internal/card-bots/${encodeURIComponent(botPlayerId)}`, {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            playerId: body.playerId || url.searchParams.get("playerId"),
          }),
        });
        return withCors(response);
      }

      const matchmaker = env.MATCHMAKER.get(env.MATCHMAKER.idFromName("global-matchmaker"));

      if (request.method === "POST" && url.pathname === "/api/matchmaking/join") {
        const body = await readJson(request);
        const response = await matchmaker.fetch("https://matchmaker/internal/join", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: body.name,
            clientId: body.clientId,
            gameType: body.gameType === "card_market" ? "card_market" : "hidden_value",
          }),
        });
        return withCors(response);
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/matchmaking/")) {
        const ticketId = url.pathname.split("/")[3];
        const response = await matchmaker.fetch(`https://matchmaker/internal/tickets/${encodeURIComponent(ticketId)}`);
        return withCors(response);
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/api/matchmaking/")) {
        const ticketId = url.pathname.split("/")[3];
        const response = await matchmaker.fetch(`https://matchmaker/internal/tickets/${encodeURIComponent(ticketId)}`, {
          method: "DELETE",
        });
        return withCors(response);
      }

      return json({ error: "Not found." }, 404);
    } catch (error) {
      return json({ error: error.message || "Request failed." }, 400);
    }
  },
};
