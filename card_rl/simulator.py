from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

from .features import base_feature_vector, quote_refresh_allowed
from .heuristic import heuristic_decision
from .rules import BOARD_CARD_COUNT, PRIVATE_CARDS_PER_PLAYER, TARGET_LABELS, TARGET_SCORERS, TARGET_UNIT_LABELS, build_deck, score_cards, target_range

ROLE_MAKER = "maker"
ROLE_TAKER = "taker"
ROLE_BALANCE_SEAT_ROLES = {"seat-1": ROLE_MAKER, "seat-2": ROLE_TAKER}
WIDE_QUOTE_RATIO_THRESHOLD = 0.18
TIGHT_QUOTE_RATIO_THRESHOLD = 0.04
MAX_FILL_INCENTIVE_RATE = 0.002
MAX_PASS_PENALTY_RATE = 0.003


def round2(value: float) -> float:
    return round(float(value), 2)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, float(value)))


@dataclass
class IncentiveSchedule:
    maker_fill_rebate: float = 0.0
    taker_fill_fee: float = 0.0
    wide_quote_pass_penalty: float = 0.0
    tight_quote_refusal_penalty: float = 0.0

    @classmethod
    def from_dict(cls, payload: Dict | "IncentiveSchedule" | None = None) -> "IncentiveSchedule":
        if isinstance(payload, cls):
            return payload.normalized()
        payload = payload or {}
        return cls(
            maker_fill_rebate=float(payload.get("maker_fill_rebate", 0.0)),
            taker_fill_fee=float(payload.get("taker_fill_fee", 0.0)),
            wide_quote_pass_penalty=float(payload.get("wide_quote_pass_penalty", 0.0)),
            tight_quote_refusal_penalty=float(payload.get("tight_quote_refusal_penalty", 0.0)),
        ).normalized()

    def normalized(self) -> "IncentiveSchedule":
        maker_fill = clamp(self.maker_fill_rebate, -MAX_FILL_INCENTIVE_RATE, MAX_FILL_INCENTIVE_RATE)
        taker_fill = clamp(self.taker_fill_fee, -MAX_FILL_INCENTIVE_RATE, MAX_FILL_INCENTIVE_RATE)
        if maker_fill * taker_fill < 0:
            raise ValueError("Fill incentives must point in the same direction; dual rebates are not supported.")
        return IncentiveSchedule(
            maker_fill_rebate=maker_fill,
            taker_fill_fee=taker_fill,
            wide_quote_pass_penalty=clamp(self.wide_quote_pass_penalty, 0.0, MAX_PASS_PENALTY_RATE),
            tight_quote_refusal_penalty=clamp(self.tight_quote_refusal_penalty, 0.0, MAX_PASS_PENALTY_RATE),
        )

    def to_dict(self) -> Dict[str, float]:
        return {
            "maker_fill_rebate": float(self.maker_fill_rebate),
            "taker_fill_fee": float(self.taker_fill_fee),
            "wide_quote_pass_penalty": float(self.wide_quote_pass_penalty),
            "tight_quote_refusal_penalty": float(self.tight_quote_refusal_penalty),
        }


@dataclass
class EpisodeSummary:
    settlement: float
    risk_adjusted_pnl: Dict[str, float]
    raw_pnl: Dict[str, float]


class CardMarketSimulator:
    def __init__(
        self,
        seed: Optional[int] = None,
        quote_ttl_steps: int = 2,
        reveal_interval_steps: int = 3,
        incentive_schedule: Dict | IncentiveSchedule | None = None,
    ) -> None:
        self.random = random.Random(seed)
        self.quote_ttl_steps = quote_ttl_steps
        self.reveal_interval_steps = reveal_interval_steps
        self.default_incentive_schedule = IncentiveSchedule.from_dict(incentive_schedule)

    def _player_id(self, index: int) -> str:
        return f"seat-{index + 1}"

    def create_state(
        self,
        seat_count: int,
        target_id: Optional[str] = None,
        *,
        role_constraints: Dict[str, str] | None = None,
        incentive_schedule: Dict | IncentiveSchedule | None = None,
    ) -> Dict:
        target_id = target_id or self.random.choice(list(TARGET_SCORERS.keys()))
        deck = [card.__dict__.copy() for card in build_deck()]
        self.random.shuffle(deck)
        total_cards = seat_count * PRIVATE_CARDS_PER_PLAYER + BOARD_CARD_COUNT
        range_low, range_high = target_range(target_id, total_cards)
        active_seat_ids = [self._player_id(index) for index in range(seat_count)]
        role_constraints = {player_id: str(role_constraints[player_id]) for player_id in (role_constraints or {}) if player_id in active_seat_ids}
        schedule = IncentiveSchedule.from_dict(incentive_schedule or self.default_incentive_schedule)
        private_hands = {}
        for player_id in active_seat_ids:
            private_hands[player_id] = [deck.pop(0), deck.pop(0)]
        board_cards = [deck.pop(0) for _ in range(BOARD_CARD_COUNT)]
        return {
            "status": "live",
            "step": 0,
            "range_low": range_low,
            "range_high": range_high,
            "target": {"id": target_id, "label": TARGET_LABELS[target_id]},
            "target_scorer_id": target_id,
            "unit_label": TARGET_UNIT_LABELS[target_id],
            "active_seat_ids": active_seat_ids,
            "private_hands": private_hands,
            "board_cards": board_cards,
            "revealed_board_count": 1,
            "positions": {player_id: {"cash": 0.0, "inventory": 0} for player_id in active_seat_ids},
            "live_quotes": {},
            "reveal_votes": {},
            "last_mark": 0.0,
            "log": [],
            "role_constraints": role_constraints,
            "role_mode": "locked" if role_constraints else "open",
            "incentive_schedule": schedule.to_dict(),
        }

    def _role_for_player(self, state: Dict, player_id: str) -> str | None:
        return state.get("role_constraints", {}).get(player_id)

    def _quote_spread_ratio(self, state: Dict, quote: Dict) -> float:
        width = max(1.0, float(state["range_high"]) - float(state["range_low"]))
        return clamp((float(quote["ask"]) - float(quote["bid"])) / width, 0.0, 2.0)

    def _incentive_amount(self, state: Dict, rate: float, size: int = 1) -> float:
        width = max(1.0, float(state["range_high"]) - float(state["range_low"]))
        return round2(width * float(rate) * max(1, int(size)))

    def _incentive_schedule(self, state: Dict) -> IncentiveSchedule:
        return IncentiveSchedule.from_dict(state.get("incentive_schedule"))

    def _normalize_role_decision(self, state: Dict, player_id: str, decision: Dict | None) -> Dict:
        role = self._role_for_player(state, player_id)
        if not role:
            return decision or {"type": "wait", "payload": {}}
        resolved = {"type": str((decision or {}).get("type", "wait")), "payload": dict((decision or {}).get("payload", {}) or {})}
        if role == ROLE_MAKER and resolved["type"] == "taker_action":
            return {"type": "wait", "payload": {}}
        if role == ROLE_TAKER and resolved["type"] == "submit_quote":
            return {"type": "wait", "payload": {}}
        return resolved

    def prune_quotes(self, state: Dict) -> None:
        to_delete = []
        for player_id, quote in state["live_quotes"].items():
            if state["step"] - int(quote["quoted_at_step"]) >= self.quote_ttl_steps:
                to_delete.append(player_id)
        for player_id in to_delete:
            del state["live_quotes"][player_id]

    def reveal_next(self, state: Dict, reason: str) -> None:
        if state["revealed_board_count"] >= len(state["board_cards"]):
            return
        state["revealed_board_count"] += 1
        state["live_quotes"] = {}
        state["reveal_votes"] = {}
        state["log"].append({"type": "reveal", "reason": reason, "step": state["step"]})

    def apply_quote(self, state: Dict, player_id: str, payload: Dict) -> None:
        if self._role_for_player(state, player_id) == ROLE_TAKER:
            return
        previous_quote = state["live_quotes"].get(player_id)
        if previous_quote and not quote_refresh_allowed(previous_quote):
            return
        state["live_quotes"][player_id] = {
            "bid": round2(payload["bid"]),
            "ask": round2(payload["ask"]),
            "size": max(1, min(5, int(payload.get("size", 1)))),
            "initial_size": max(1, min(5, int(payload.get("size", 1)))),
            "quoted_at_step": state["step"],
        }
        state["last_mark"] = round2((state["live_quotes"][player_id]["bid"] + state["live_quotes"][player_id]["ask"]) / 2.0)
        state["log"].append(
            {
                "type": "quote",
                "player_id": player_id,
                "bid": state["live_quotes"][player_id]["bid"],
                "ask": state["live_quotes"][player_id]["ask"],
                "size": state["live_quotes"][player_id]["size"],
                "step": state["step"],
            }
        )

    def apply_take(self, state: Dict, player_id: str, payload: Dict) -> bool:
        if self._role_for_player(state, player_id) == ROLE_MAKER:
            return False
        target_player_id = payload.get("targetPlayerId")
        if not target_player_id or target_player_id == player_id or target_player_id not in state["live_quotes"]:
            return False
        quote = state["live_quotes"][target_player_id]
        maker = state["positions"][target_player_id]
        taker = state["positions"][player_id]
        schedule = self._incentive_schedule(state)
        quantity = 1
        remaining_size = max(0, int(quote["size"]) - quantity)
        if payload["action"] == "buy":
            price = float(quote["ask"])
            maker["cash"] += price * quantity
            maker["inventory"] -= quantity
            taker["cash"] -= price * quantity
            taker["inventory"] += quantity
            state["last_mark"] = price
            trade_side = "buy"
        elif payload["action"] == "sell":
            price = float(quote["bid"])
            maker["cash"] -= price * quantity
            maker["inventory"] += quantity
            taker["cash"] += price * quantity
            taker["inventory"] -= quantity
            state["last_mark"] = price
            trade_side = "sell"
        else:
            return False
        maker_incentive = self._incentive_amount(state, schedule.maker_fill_rebate, quantity)
        taker_fee = self._incentive_amount(state, schedule.taker_fill_fee, quantity)
        maker["cash"] += maker_incentive
        taker["cash"] -= taker_fee
        if remaining_size > 0:
            state["live_quotes"][target_player_id] = {
                **quote,
                "size": remaining_size,
            }
        else:
            del state["live_quotes"][target_player_id]
        state["log"].append(
            {
                "type": "trade",
                "step": state["step"],
                "maker_player_id": target_player_id,
                "taker_player_id": player_id,
                "action": trade_side,
                "price": round2(price),
                "qty": quantity,
                "maker_incentive": maker_incentive,
                "taker_fee": taker_fee,
            }
        )
        return True

    def apply_taker_pass(self, state: Dict, player_id: str, target_player_id: str | None = None) -> bool:
        if self._role_for_player(state, player_id) == ROLE_MAKER:
            return False
        if not state["live_quotes"]:
            return False
        target_player_id = target_player_id or next(iter(state["live_quotes"].keys()))
        if target_player_id not in state["live_quotes"]:
            return False
        schedule = self._incentive_schedule(state)
        quote = state["live_quotes"][target_player_id]
        spread_ratio = self._quote_spread_ratio(state, quote)
        maker_penalty = 0.0
        taker_penalty = 0.0
        if spread_ratio >= WIDE_QUOTE_RATIO_THRESHOLD:
            maker_penalty = self._incentive_amount(state, schedule.wide_quote_pass_penalty, int(quote.get("size", 1)))
            state["positions"][target_player_id]["cash"] -= maker_penalty
        elif spread_ratio <= TIGHT_QUOTE_RATIO_THRESHOLD:
            taker_penalty = self._incentive_amount(state, schedule.tight_quote_refusal_penalty, int(quote.get("size", 1)))
            state["positions"][player_id]["cash"] -= taker_penalty
        state["log"].append(
            {
                "type": "pass",
                "step": state["step"],
                "maker_player_id": target_player_id,
                "taker_player_id": player_id,
                "maker_pass_penalty": maker_penalty,
                "taker_pass_penalty": taker_penalty,
                "quoted_spread_ratio": spread_ratio,
            }
        )
        return True

    def apply_reveal_vote(self, state: Dict, player_id: str) -> None:
        if state["revealed_board_count"] >= len(state["board_cards"]):
            return
        state["reveal_votes"][player_id] = True
        if all(seat_id in state["reveal_votes"] for seat_id in state["active_seat_ids"]):
            self.reveal_next(state, "all_voted")

    def settle(self, state: Dict) -> EpisodeSummary:
        all_cards = []
        for player_id in state["active_seat_ids"]:
            all_cards.extend(state["private_hands"][player_id])
        all_cards.extend(state["board_cards"])
        settlement = float(score_cards(state["target_scorer_id"], [self._dict_to_card(card) for card in all_cards]))
        raw = {}
        risk_adjusted = {}
        reveal_progress = state["revealed_board_count"] / max(1.0, len(state["board_cards"]))
        for player_id, position in state["positions"].items():
            raw_pnl = round2(float(position["cash"]) + float(position["inventory"]) * settlement)
            raw[player_id] = raw_pnl
            risk_adjusted[player_id] = raw_pnl
        return EpisodeSummary(settlement=settlement, risk_adjusted_pnl=risk_adjusted, raw_pnl=raw)

    def run_episode(
        self,
        seat_count: int,
        policy_for_seat: Callable[[Dict, str, int], Dict] | Dict[str, Callable[[Dict, str, int], Dict]],
        target_id: Optional[str] = None,
        max_steps: int = 18,
        *,
        role_constraints: Dict[str, str] | None = None,
        incentive_schedule: Dict | IncentiveSchedule | None = None,
    ) -> tuple[Dict, EpisodeSummary]:
        state = self.create_state(
            seat_count,
            target_id,
            role_constraints=role_constraints,
            incentive_schedule=incentive_schedule,
        )
        while state["status"] == "live" and state["step"] < max_steps:
            self.prune_quotes(state)
            if state.get("role_mode") == "locked":
                ordered_seats = [
                    player_id
                    for player_id in state["active_seat_ids"]
                    if self._role_for_player(state, player_id) == ROLE_MAKER
                ] + [
                    player_id
                    for player_id in state["active_seat_ids"]
                    if self._role_for_player(state, player_id) == ROLE_TAKER
                ]
            else:
                ordered_seats = list(state["active_seat_ids"])
                self.random.shuffle(ordered_seats)
            for player_id in ordered_seats:
                if isinstance(policy_for_seat, dict):
                    actor = policy_for_seat[player_id]
                else:
                    actor = policy_for_seat
                decision = self._normalize_role_decision(state, player_id, actor(state, player_id, state["step"]))
                if decision["type"] == "submit_quote" and decision.get("payload"):
                    self.apply_quote(state, player_id, decision["payload"])
                elif decision["type"] == "taker_action":
                    self.apply_take(state, player_id, decision["payload"])
                elif decision["type"] == "request_next_reveal":
                    self.apply_reveal_vote(state, player_id)
                    if self._role_for_player(state, player_id) == ROLE_TAKER and state["live_quotes"]:
                        self.apply_taker_pass(state, player_id)
                elif self._role_for_player(state, player_id) == ROLE_TAKER and state["live_quotes"]:
                    self.apply_taker_pass(state, player_id)
            state["step"] += 1
            if state["step"] % self.reveal_interval_steps == 0 and state["revealed_board_count"] < len(state["board_cards"]):
                self.reveal_next(state, "timer")
            if state["revealed_board_count"] >= len(state["board_cards"]) and state["step"] >= self.reveal_interval_steps * len(state["board_cards"]):
                state["status"] = "finished"
        state["status"] = "finished"
        summary = self.settle(state)
        return state, summary

    def _dict_to_card(self, card: Dict):
        from .rules import Card

        return Card(
            id=card["id"],
            code=card["code"],
            rank=card["rank"],
            rank_value=int(card["rank_value"]),
            suit=card["suit"],
            color=card["color"],
        )


def heuristic_policy(state: Dict, player_id: str, now_step: int) -> Dict:
    return heuristic_decision(state, player_id, now_step)
