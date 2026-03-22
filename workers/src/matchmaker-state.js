function ticketTimestamp(ticket) {
  return Number.isFinite(ticket?.createdAt) ? Number(ticket.createdAt) : 0;
}

function pickNewestTicket(tickets) {
  return [...tickets].sort((a, b) => ticketTimestamp(b) - ticketTimestamp(a))[0] || null;
}

export function serializeTicket(ticket) {
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

export function reconcileClientTickets(tickets, queue, clientId, requestedGameType) {
  const sameGameMatchedTickets = [];
  const sameGameQueuedTickets = [];
  const conflictingQueuedTickets = [];

  for (const ticket of Object.values(tickets)) {
    if (!ticket || ticket.clientId !== clientId) {
      continue;
    }
    if (ticket.status === "matched") {
      if (ticket.gameType === requestedGameType) {
        sameGameMatchedTickets.push(ticket);
      }
      continue;
    }
    if (ticket.status !== "queued") {
      continue;
    }
    if (ticket.gameType === requestedGameType) {
      sameGameQueuedTickets.push(ticket);
      continue;
    }
    conflictingQueuedTickets.push(ticket);
  }

  let changed = false;
  let nextQueue = queue;
  if (conflictingQueuedTickets.length) {
    const conflictingIds = new Set(conflictingQueuedTickets.map((ticket) => ticket.id));
    for (const ticket of conflictingQueuedTickets) {
      ticket.status = "cancelled";
    }
    nextQueue = queue.filter((ticketId) => !conflictingIds.has(ticketId));
    changed = true;
  }

  const reusableTicket = pickNewestTicket(sameGameMatchedTickets) || pickNewestTicket(sameGameQueuedTickets);
  return {
    changed,
    queue: nextQueue,
    ticket: reusableTicket,
  };
}

export function cancelTicketState(tickets, queue, ticketId) {
  const ticket = tickets[ticketId];
  if (!ticket) {
    return {
      found: false,
      queue,
      ticket: null,
    };
  }

  if (ticket.status === "queued") {
    ticket.status = "cancelled";
    return {
      found: true,
      queue: queue.filter((entry) => entry !== ticketId),
      ticket,
    };
  }

  return {
    found: true,
    queue,
    ticket,
  };
}
