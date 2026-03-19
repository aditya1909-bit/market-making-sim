export const CLIENT_EVENTS = {
  READY: "ready",
  START_GAME: "start_game",
  SUBMIT_QUOTE: "submit_quote",
  TAKER_ACTION: "taker_action",
  LEAVE_ROOM: "leave_room",
  PING: "ping",
};

export const SERVER_EVENTS = {
  ROOM_STATE: "room_state",
  ERROR: "error",
  PONG: "pong",
};

export const ROOM_STATUS = {
  LOBBY: "lobby",
  LIVE: "live",
  FINISHED: "finished",
};

export const GAME_ROLE = {
  MAKER: "market_maker",
  TAKER: "market_taker",
  SPECTATOR: "spectator",
};

export const GAME_ACTOR = {
  MAKER: "maker",
  TAKER: "taker",
};

export const TAKER_ACTION = {
  BUY: "buy",
  SELL: "sell",
  PASS: "pass",
};
