from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

from .features import base_feature_vector
from .heuristic import heuristic_decision
from .rules import BOARD_CARD_COUNT, PRIVATE_CARDS_PER_PLAYER, TARGET_LABELS, TARGET_SCORERS, TARGET_UNIT_LABELS, build_deck, score_cards, target_range


def round2(value: float) -> float:
    return round(float(value), 2)


@dataclass
class EpisodeSummary:
    settlement: float
    risk_adjusted_pnl: Dict[str, float]
    raw_pnl: Dict[str, float]


class CardMarketSimulator:
    def __init__(self, seed: Optional[int] = None, quote_ttl_steps: int = 2, reveal_interval_steps: int = 3) -> None:
        self.random = random.Random(seed)
        self.quote_ttl_steps = quote_ttl_steps
        self.reveal_interval_steps = reveal_interval_steps

    def _player_id(self, index: int) -> str:
        return f"seat-{index + 1}"

    def create_state(self, seat_count: int, target_id: Optional[str] = None) -> Dict:
        target_id = target_id or self.random.choice(list(TARGET_SCORERS.keys()))
        deck = [card.__dict__.copy() for card in build_deck()]
        self.random.shuffle(deck)
        total_cards = seat_count * PRIVATE_CARDS_PER_PLAYER + BOARD_CARD_COUNT
        range_low, range_high = target_range(target_id, total_cards)
        active_seat_ids = [self._player_id(index) for index in range(seat_count)]
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
        }

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
        state["live_quotes"][player_id] = {
            "bid": round2(payload["bid"]),
            "ask": round2(payload["ask"]),
            "size": max(1, min(5, int(payload.get("size", 1)))),
            "quoted_at_step": state["step"],
        }
        state["last_mark"] = round2((state["live_quotes"][player_id]["bid"] + state["live_quotes"][player_id]["ask"]) / 2.0)

    def apply_take(self, state: Dict, player_id: str, payload: Dict) -> bool:
        target_player_id = payload.get("targetPlayerId")
        if not target_player_id or target_player_id == player_id or target_player_id not in state["live_quotes"]:
            return False
        quote = state["live_quotes"][target_player_id]
        maker = state["positions"][target_player_id]
        taker = state["positions"][player_id]
        quantity = int(quote["size"])
        if payload["action"] == "buy":
            price = float(quote["ask"])
            maker["cash"] += price * quantity
            maker["inventory"] -= quantity
            taker["cash"] -= price * quantity
            taker["inventory"] += quantity
            state["last_mark"] = price
            return True
        if payload["action"] == "sell":
            price = float(quote["bid"])
            maker["cash"] -= price * quantity
            maker["inventory"] += quantity
            taker["cash"] += price * quantity
            taker["inventory"] -= quantity
            state["last_mark"] = price
            return True
        return False

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
            risk_penalty = abs(float(position["inventory"])) * (0.2 + (1.0 - reveal_progress) * 0.3)
            quote_penalty = 0.0
            if player_id in state["live_quotes"]:
                quote = state["live_quotes"][player_id]
                quote_penalty = (float(quote["ask"]) - float(quote["bid"])) * 0.04
            raw[player_id] = raw_pnl
            risk_adjusted[player_id] = round2(raw_pnl - risk_penalty - quote_penalty)
        return EpisodeSummary(settlement=settlement, risk_adjusted_pnl=risk_adjusted, raw_pnl=raw)

    def run_episode(
        self,
        seat_count: int,
        policy_for_seat: Callable[[Dict, str, int], Dict] | Dict[str, Callable[[Dict, str, int], Dict]],
        target_id: Optional[str] = None,
        max_steps: int = 18,
    ) -> tuple[Dict, EpisodeSummary]:
        state = self.create_state(seat_count, target_id)
        while state["status"] == "live" and state["step"] < max_steps:
            self.prune_quotes(state)
            ordered_seats = list(state["active_seat_ids"])
            self.random.shuffle(ordered_seats)
            for player_id in ordered_seats:
                if isinstance(policy_for_seat, dict):
                    actor = policy_for_seat[player_id]
                else:
                    actor = policy_for_seat
                decision = actor(state, player_id, state["step"])
                if decision["type"] == "submit_quote" and decision.get("payload"):
                    self.apply_quote(state, player_id, decision["payload"])
                elif decision["type"] == "taker_action":
                    self.apply_take(state, player_id, decision["payload"])
                elif decision["type"] == "request_next_reveal":
                    self.apply_reveal_vote(state, player_id)
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
