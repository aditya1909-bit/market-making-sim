from __future__ import annotations

from typing import Dict

from .features import base_feature_vector
from .rules import QUOTE_TEMPLATES


def quote_from_template(state: Dict, player_id: str, template: Dict, now_step: int = 0) -> Dict | None:
    if template.get("noop"):
        return None
    base = base_feature_vector(state, player_id, now_step)
    stats = base["stats"]
    inventory = float(base["position"].get("inventory", 0))
    reservation = stats["mean"] + float(template.get("reservationOffset", 0.0)) * stats["width"] - inventory * stats["width"] * 0.025
    base_half_spread = max(0.35, stats["stdev"] * (0.8 + float(template.get("spreadScale", 1.0)) * 0.65))
    competition_spread = (
        max(0.2, min(float(entry["quote"]["ask"]) - float(entry["quote"]["bid"]) for entry in base["quotes"]) * 0.45)
        if base["quotes"]
        else 0.5
    )
    half_spread = max(base_half_spread, competition_spread)
    bid = max(stats["range_low"], min(stats["range_high"] - 0.01, round(reservation - half_spread, 2)))
    ask = max(bid + 0.01, min(stats["range_high"], round(reservation + half_spread, 2)))
    return {"bid": bid, "ask": ask, "size": int(max(1, min(5, int(template.get("size", 1)))))}


def heuristic_decision(state: Dict, player_id: str, now_step: int = 0) -> Dict:
    base = base_feature_vector(state, player_id, now_step)
    stats = base["stats"]
    reveal_progress = state["revealed_board_count"]
    board_total = len(state["board_cards"])
    reveal_ready = (
        reveal_progress < board_total
        and player_id not in state["reveal_votes"]
        and (base["values"][1] < 0.11 or len(base["quotes"]) == 0 or reveal_progress >= board_total - 1)
    )

    best_take = None
    for entry in base["quotes"]:
        buy_edge = (stats["mean"] - float(entry["quote"]["ask"])) / stats["width"]
        sell_edge = (float(entry["quote"]["bid"]) - stats["mean"]) / stats["width"]
        edge = max(buy_edge, sell_edge)
        action = "buy" if buy_edge >= sell_edge else "sell"
        if best_take is None or edge > best_take["edge"]:
            best_take = {"entry": entry, "action": action, "edge": edge}

    quote_threshold = 0.04 + max(0.0, min(base["values"][1] * 0.2, 0.12))
    if best_take and best_take["edge"] > quote_threshold:
        return {
            "type": "taker_action",
            "payload": {
                "targetPlayerId": best_take["entry"]["target_player_id"],
                "action": best_take["action"],
            },
        }

    own_quote = base["own_quote"]
    need_refresh = not own_quote or base["own_quote_age_ratio"] > 0.72 or abs(base["own_mid_bias"]) > 0.08 or len(base["quotes"]) > 0
    if need_refresh:
        if abs(base["values"][2]) > 0.55:
            template_id = "buy_skew_2" if base["values"][2] > 0 else "sell_skew_2"
        elif base["values"][1] > 0.18:
            template_id = "wide_2"
        elif len(base["quotes"]) > 2:
            template_id = "mid_2"
        else:
            template_id = "mid_1"
        template = next(template for template in QUOTE_TEMPLATES if template["id"] == template_id)
        return {
            "type": "submit_quote",
            "payload": quote_from_template(state, player_id, template, now_step),
            "templateId": template_id,
        }

    if reveal_ready:
        return {"type": "request_next_reveal", "payload": {}}

    return {"type": "wait", "payload": {}}
