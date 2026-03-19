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

function randomCode(length = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  while (out.length < length) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
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
    const ticketId = crypto.randomUUID();

    let waitingTicketId = null;
    while (this.queue.length) {
      const candidateId = this.queue.shift();
      if (this.tickets[candidateId]?.status === "queued") {
        waitingTicketId = candidateId;
        break;
      }
    }

    if (!waitingTicketId) {
      this.tickets[ticketId] = {
        id: ticketId,
        status: "queued",
        name,
        createdAt: Date.now(),
      };
      await this.persist();
      this.queue.push(ticketId);
      await this.persist();
      return json({ ticketId, status: "queued" }, 200);
    }

    const waitingTicket = this.tickets[waitingTicketId];
    const created = await this.createMatchedRoom(waitingTicket.name, name);

    waitingTicket.status = "matched";
    waitingTicket.roomId = created.roomId;
    waitingTicket.roomCode = created.roomCode;
    waitingTicket.playerId = created.players[0].playerId;

    this.tickets[ticketId] = {
      id: ticketId,
      status: "matched",
      name,
      roomId: created.roomId,
      roomCode: created.roomCode,
      playerId: created.players[1].playerId,
    };

    await this.persist();

    return json(
      {
        ticketId,
        status: "matched",
        roomId: created.roomId,
        roomCode: created.roomCode,
        playerId: created.players[1].playerId,
      },
      200
    );
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

  async createMatchedRoom(nameA, nameB) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const code = randomCode();
      const roomId = this.env.ROOM.idFromName(code);
      const roomStub = this.env.ROOM.get(roomId);
      const response = await roomStub.fetch("https://room/internal/seed-match", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ code, names: [nameA, nameB] }),
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
