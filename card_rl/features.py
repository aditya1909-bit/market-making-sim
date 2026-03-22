from __future__ import annotations

from math import sqrt
from typing import Dict, List

from .rules import BOARD_CARD_COUNT, PRIVATE_CARDS_PER_PLAYER, build_deck, score_card

BASE_FEATURE_NAMES = [
    "bias",
    "stdev",
    "inventory",
    "reveal_progress",
    "seat_count",
    "live_quote_count",
    "best_buy_edge",
    "best_sell_edge",
    "own_quote_spread",
    "mark_bias",
    "private_positive",
    "private_negative",
    "board_positive",
    "board_negative",
    "unknown_ratio",
]

QUOTE_FEATURE_NAMES = BASE_FEATURE_NAMES + ["template_reservation_offset", "template_spread_scale", "template_size"]
TAKE_FEATURE_NAMES = BASE_FEATURE_NAMES + ["candidate_buy_edge", "candidate_sell_edge", "candidate_spread", "candidate_size", "candidate_age"]


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def midpoint(quote: Dict | None) -> float | None:
    if not quote:
        return None
    return (float(quote["bid"]) + float(quote["ask"])) / 2.0


def _known_cards(state: Dict, player_id: str) -> List[Dict]:
    private_hand = state["private_hands"].get(player_id, [])
    board_cards = state["board_cards"][: state["revealed_board_count"]]
    return private_hand + board_cards


def _remaining_deck(state: Dict, player_id: str) -> List[Dict]:
    known_ids = {card["id"] for card in _known_cards(state, player_id)}
    return [card.__dict__ for card in build_deck() if card.id not in known_ids]


def _unknown_card_count(state: Dict, player_id: str) -> int:
    seat_count = len(state["active_seat_ids"])
    total_cards = seat_count * PRIVATE_CARDS_PER_PLAYER + BOARD_CARD_COUNT
    known_count = len(state["private_hands"].get(player_id, [])) + state["revealed_board_count"]
    return max(0, total_cards - known_count)


def _contribution_ratios(cards: List[Dict], target_id: str) -> tuple[float, float]:
    if not cards:
      return 0.0, 0.0
    positive = 0.0
    negative = 0.0
    for card in cards:
        value = score_card(target_id, _dict_to_card(card))
        if value > 0:
            positive += value
        elif value < 0:
            negative += abs(value)
    scale = max(1.0, float(len(cards)))
    return positive / scale, negative / scale


def _dict_to_card(card: Dict):
    from .rules import Card

    return Card(
        id=card["id"],
        code=card["code"],
        rank=card["rank"],
        rank_value=int(card["rank_value"]),
        suit=card["suit"],
        color=card["color"],
    )


def posterior_stats(state: Dict, player_id: str) -> Dict:
    target_id = state.get("target_scorer_id") or state.get("target", {}).get("id") or "spades_minus_red"
    private_hand = state["private_hands"].get(player_id, [])
    visible_board = state["board_cards"][: state["revealed_board_count"]]
    known_cards = private_hand + visible_board
    known_score = sum(score_card(target_id, _dict_to_card(card)) for card in known_cards)
    remaining = _remaining_deck(state, player_id)
    unknown_count = min(_unknown_card_count(state, player_id), len(remaining))
    values = [score_card(target_id, _dict_to_card(card)) for card in remaining]
    population_count = len(values)
    population_mean = sum(values) / population_count if population_count else 0.0
    population_variance = (
        sum((value - population_mean) ** 2 for value in values) / population_count if population_count else 0.0
    )
    unknown_mean = unknown_count * population_mean
    unknown_variance = (
        unknown_count * ((population_count - unknown_count) / (population_count - 1)) * population_variance
        if population_count > 1
        else 0.0
    )
    range_low = float(state["range_low"])
    range_high = float(state["range_high"])
    width = max(1.0, range_high - range_low)
    private_positive, private_negative = _contribution_ratios(private_hand, target_id)
    board_positive, board_negative = _contribution_ratios(visible_board, target_id)
    return {
        "target_id": target_id,
        "mean": known_score + unknown_mean,
        "stdev": sqrt(max(unknown_variance, 0.0)),
        "width": width,
        "range_low": range_low,
        "range_high": range_high,
        "known_score": known_score,
        "unknown_count": unknown_count,
        "private_positive_ratio": private_positive,
        "private_negative_ratio": private_negative,
        "board_positive_ratio": board_positive,
        "board_negative_ratio": board_negative,
    }


def live_quote_entries(state: Dict, player_id: str, now_step: int = 0) -> List[Dict]:
    positions = state["positions"]
    entries = []
    for other_player_id, quote in state["live_quotes"].items():
        if other_player_id == player_id:
            continue
        entries.append(
            {
                "target_player_id": other_player_id,
                "quote": quote,
                "position": positions.get(other_player_id, {"cash": 0.0, "inventory": 0}),
                "age": max(0, now_step - int(quote.get("quoted_at_step", now_step))),
            }
        )
    entries.sort(key=lambda entry: int(entry["quote"].get("quoted_at_step", 0)), reverse=True)
    return entries


def base_feature_vector(state: Dict, player_id: str, now_step: int = 0) -> Dict:
    stats = posterior_stats(state, player_id)
    position = state["positions"].get(player_id, {"cash": 0.0, "inventory": 0})
    quotes = live_quote_entries(state, player_id, now_step)
    range_mid = (stats["range_low"] + stats["range_high"]) / 2.0
    own_quote = state["live_quotes"].get(player_id)
    own_spread = float(own_quote["ask"]) - float(own_quote["bid"]) if own_quote else 0.0
    best_bid = max((float(entry["quote"]["bid"]) for entry in quotes), default=range_mid)
    best_ask = min((float(entry["quote"]["ask"]) for entry in quotes), default=range_mid)
    last_mark = float(state.get("last_mark", range_mid))
    values = [
        clamp((stats["mean"] - range_mid) / stats["width"], -1.5, 1.5),
        clamp(stats["stdev"] / stats["width"], 0.0, 1.5),
        clamp(float(position.get("inventory", 0)) / 8.0, -1.5, 1.5),
        clamp(state["revealed_board_count"] / max(1.0, len(state["board_cards"]) or BOARD_CARD_COUNT), 0.0, 1.0),
        clamp(len(state["active_seat_ids"]) / 10.0, 0.0, 1.0),
        clamp(len(quotes) / 8.0, 0.0, 1.0),
        clamp((stats["mean"] - best_ask) / stats["width"], -1.5, 1.5),
        clamp((best_bid - stats["mean"]) / stats["width"], -1.5, 1.5),
        clamp(own_spread / stats["width"], 0.0, 1.5),
        clamp((last_mark - range_mid) / stats["width"], -1.5, 1.5),
        clamp(stats["private_positive_ratio"], 0.0, 2.0),
        clamp(stats["private_negative_ratio"], 0.0, 2.0),
        clamp(stats["board_positive_ratio"], 0.0, 2.0),
        clamp(stats["board_negative_ratio"], 0.0, 2.0),
        clamp(
            stats["unknown_count"] / max(1.0, len(state["active_seat_ids"]) * PRIVATE_CARDS_PER_PLAYER + BOARD_CARD_COUNT),
            0.0,
            1.0,
        ),
    ]
    own_mid = midpoint(own_quote)
    return {
        "stats": stats,
        "position": position,
        "quotes": quotes,
        "own_quote": own_quote,
        "values": values,
        "own_quote_age_ratio": clamp((now_step - int(own_quote.get("quoted_at_step", now_step))) / 2.0, 0.0, 2.0)
        if own_quote
        else 0.0,
        "own_mid_bias": clamp((own_mid - stats["mean"]) / stats["width"], -1.5, 1.5) if own_mid is not None else 0.0,
    }


def quote_features(base_state: Dict, template: Dict) -> List[float]:
    return base_state["values"] + [
        clamp(float(template.get("reservationOffset", 0.0)), -2.0, 2.0),
        clamp(float(template.get("spreadScale", 0.0)), 0.0, 3.0),
        clamp(float(template.get("size", 0)) / 5.0, 0.0, 1.0),
    ]


def take_features(base_state: Dict, entry: Dict) -> List[float]:
    quote = entry["quote"]
    buy_edge = clamp((base_state["stats"]["mean"] - float(quote["ask"])) / base_state["stats"]["width"], -2.0, 2.0)
    sell_edge = clamp((float(quote["bid"]) - base_state["stats"]["mean"]) / base_state["stats"]["width"], -2.0, 2.0)
    return base_state["values"] + [
        buy_edge,
        sell_edge,
        clamp((float(quote["ask"]) - float(quote["bid"])) / base_state["stats"]["width"], 0.0, 2.0),
        clamp(float(quote.get("size", 1)) / 5.0, 0.0, 1.0),
        clamp(float(entry["age"]) / 2.0, 0.0, 2.0),
    ]
