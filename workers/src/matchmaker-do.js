import { DurableObject } from "cloudflare:workers";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function validateName(name) {
  const value = String(name || "").trim().slice(0, 32);
  if (!value) {
    throw new Error("Player name is required.");
  }
  return value;
}

function validateClientId(clientId) {
  const value = String(clientId || "").trim().slice(0, 96);
  if (!value) {
    throw new Error("Client id is required.");
  }
  return value;
}

function normalizeGameType(gameType) {
  return gameType === "card_market" ? "card_market" : "hidden_value";
}

function randomCode(length = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  while (out.length < length) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function serializeTicket(ticket) {
  if (!ticket) {
    return null;
  }
  return {
    ticketId: ticket.id,
    status: ticket.status,
    gameType: ticket.gameType,
    roomId: ticket.roomId,
    roomCode: ticket.roomCode,
    playerId: ticket.playerId,
  };
}

export class MatchmakerDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.queue = [];
    this.tickets = {};
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.queue = (await this.ctx.storage.get("queue")) || [];
      this.tickets = (await this.ctx.storage.get("tickets")) || {};
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/internal/join") {
        return this.joinQueue(request);
      }

      if (request.method === "GET" && url.pathname.startsWith("/internal/tickets/")) {
        return this.getTicket(url.pathname.split("/")[3]);
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/internal/tickets/")) {
        return this.cancelTicket(url.pathname.split("/")[3]);
      }

      return json({ error: "Not found." }, 404);
    } catch (error) {
      return json({ error: error.message || "Matchmaking request failed." }, 400);
    }
  }

  async joinQueue(request) {
    const body = await readJson(request);
    const name = validateName(body.name);
    const clientId = validateClientId(body.clientId);
    const gameType = normalizeGameType(body.gameType);
    const existingTicket = this.findActiveTicketForClient(clientId);
    if (existingTicket) {
      return json(serializeTicket(existingTicket), 200);
    }
    const ticketId = crypto.randomUUID();

    let waitingTicketId = null;
    const skippedIds = [];
    while (this.queue.length) {
      const candidateId = this.queue.shift();
      const candidate = this.tickets[candidateId];
      if (candidate?.status !== "queued") {
        continue;
      }
      if (candidate.clientId === clientId || normalizeGameType(candidate.gameType) !== gameType) {
        skippedIds.push(candidateId);
        continue;
      }
      if (candidate.status === "queued") {
        waitingTicketId = candidateId;
        break;
      }
    }
    if (skippedIds.length) {
      this.queue = skippedIds.concat(this.queue);
    }

    if (!waitingTicketId) {
      this.tickets[ticketId] = {
        id: ticketId,
        status: "queued",
        name,
        clientId,
        gameType,
        createdAt: Date.now(),
      };
      await this.persist();
      this.queue.push(ticketId);
      await this.persist();
      return json(serializeTicket(this.tickets[ticketId]), 200);
    }

    const waitingTicket = this.tickets[waitingTicketId];
    const created = await this.createMatchedRoom(waitingTicket.name, name, gameType);

    waitingTicket.status = "matched";
    waitingTicket.gameType = gameType;
    waitingTicket.roomId = created.roomId;
    waitingTicket.roomCode = created.roomCode;
    waitingTicket.playerId = created.players[0].playerId;

    this.tickets[ticketId] = {
      id: ticketId,
      status: "matched",
      name,
      clientId,
      gameType,
      roomId: created.roomId,
      roomCode: created.roomCode,
      playerId: created.players[1].playerId,
    };

    await this.persist();

    return json(serializeTicket(this.tickets[ticketId]), 200);
  }

  getTicket(ticketId) {
    const ticket = this.tickets[ticketId];
    if (!ticket) {
      return json({ error: "Matchmaking ticket not found." }, 404);
    }
    return json(ticket, 200);
  }

  async cancelTicket(ticketId) {
    const ticket = this.tickets[ticketId];
    if (!ticket) {
      return json({ error: "Matchmaking ticket not found." }, 404);
    }
    if (ticket.status === "matched") {
      return json(ticket, 200);
    }

    ticket.status = "cancelled";
    this.queue = this.queue.filter((entry) => entry !== ticketId);
    await this.persist();
    return json(ticket, 200);
  }

  findActiveTicketForClient(clientId) {
    for (const ticket of Object.values(this.tickets)) {
      if (!ticket || ticket.clientId !== clientId) {
        continue;
      }
      if (ticket.status === "queued" || ticket.status === "matched") {
        return ticket;
      }
    }
    return null;
  }

  async createMatchedRoom(nameA, nameB, gameType) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const code = randomCode();
      const roomId = this.env.ROOM.idFromName(code);
      const roomStub = this.env.ROOM.get(roomId);
      const response = await roomStub.fetch("https://room/internal/seed-match", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ code, names: [nameA, nameB], gameType: normalizeGameType(gameType) }),
      });

      if (response.status === 409) {
        continue;
      }

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Failed to create matched room.");
      }
      return payload;
    }

    throw new Error("Could not allocate a room code.");
  }

  async persist() {
    await this.ctx.storage.put("queue", this.queue);
    await this.ctx.storage.put("tickets", this.tickets);
  }
}
