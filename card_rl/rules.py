from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, List

PRIVATE_CARDS_PER_PLAYER = 2
BOARD_CARD_COUNT = 5
MAX_QUOTE_SIZE = 5


@dataclass(frozen=True)
class Card:
    id: str
    code: str
    rank: str
    rank_value: int
    suit: str
    color: str


def build_deck() -> List[Card]:
    ranks = [
        ("A", 14),
        ("K", 13),
        ("Q", 12),
        ("J", 11),
        ("10", 10),
        ("9", 9),
        ("8", 8),
        ("7", 7),
        ("6", 6),
        ("5", 5),
        ("4", 4),
        ("3", 3),
        ("2", 2),
    ]
    suits = [
        ("S", "black"),
        ("H", "red"),
        ("D", "red"),
        ("C", "black"),
    ]
    cards: List[Card] = []
    for rank, rank_value in ranks:
        for suit, color in suits:
            code = f"{rank}{suit}"
            cards.append(Card(id=f"1-{code}", code=code, rank=rank, rank_value=rank_value, suit=suit, color=color))
    return cards


def _spades_minus_red(card: Card) -> int:
    return int(card.suit == "S") - int(card.color == "red")


def _black_minus_low(card: Card) -> int:
    return int(card.color == "black") - int(card.rank_value <= 5)


def _faces_plus_aces(card: Card) -> int:
    return int(card.rank in {"A", "J", "Q", "K"})


TARGET_LABELS = {
    "spades_minus_red": "Spades minus red cards",
    "black_minus_low": "Black cards minus low cards",
    "faces_plus_aces": "Face cards plus aces",
}

TARGET_UNIT_LABELS = {
    "spades_minus_red": "points",
    "black_minus_low": "points",
    "faces_plus_aces": "cards",
}

TARGET_SCORERS: Dict[str, Callable[[Card], int]] = {
    "spades_minus_red": _spades_minus_red,
    "black_minus_low": _black_minus_low,
    "faces_plus_aces": _faces_plus_aces,
}


def target_range(target_id: str, total_cards: int) -> tuple[int, int]:
    if target_id == "faces_plus_aces":
        return 0, total_cards
    return -total_cards, total_cards


def score_card(target_id: str, card: Card) -> int:
    return TARGET_SCORERS.get(target_id, _spades_minus_red)(card)


def score_cards(target_id: str, cards: List[Card]) -> int:
    return sum(score_card(target_id, card) for card in cards)


QUOTE_TEMPLATES = [
    {"id": "noop", "reservationOffset": 0.0, "spreadScale": 0.0, "size": 0, "noop": True},
    {"id": "tight_buy_1", "reservationOffset": -0.03, "spreadScale": 0.7, "size": 1},
    {"id": "tight_sell_1", "reservationOffset": 0.03, "spreadScale": 0.7, "size": 1},
    {"id": "mid_1", "reservationOffset": 0.0, "spreadScale": 1.0, "size": 1},
    {"id": "mid_2", "reservationOffset": 0.0, "spreadScale": 1.15, "size": 2},
    {"id": "wide_1", "reservationOffset": 0.0, "spreadScale": 1.45, "size": 1},
    {"id": "wide_2", "reservationOffset": 0.0, "spreadScale": 1.55, "size": 2},
    {"id": "buy_skew_2", "reservationOffset": -0.08, "spreadScale": 1.0, "size": 2},
    {"id": "sell_skew_2", "reservationOffset": 0.08, "spreadScale": 1.0, "size": 2},
    {"id": "panic_buy_3", "reservationOffset": -0.14, "spreadScale": 1.7, "size": 3},
    {"id": "panic_sell_3", "reservationOffset": 0.14, "spreadScale": 1.7, "size": 3},
]
