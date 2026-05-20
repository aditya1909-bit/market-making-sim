from __future__ import annotations

from typing import Dict

from .features import base_feature_vector, clamp, midpoint, quote_refresh_allowed
from .rules import QUOTE_TEMPLATES

BASELINE_WAIT = "wait"
BASELINE_MAKER_PUBLIC_MID = "maker_public_mid"
BASELINE_MAKER_PUBLIC_SKEW = "maker_public_skew_inventory"
BASELINE_TAKER_BEST_EDGE = "taker_best_edge"
BASELINE_BALANCED = "balanced_public_make_private_take"
BASELINE_IDS = [
    BASELINE_WAIT,
    BASELINE_MAKER_PUBLIC_MID,
    BASELINE_MAKER_PUBLIC_SKEW,
    BASELINE_TAKER_BEST_EDGE,
    BASELINE_BALANCED,
]


def _template_by_id(template_id: str) -> Dict:
    return next((template for template in QUOTE_TEMPLATES if template["id"] == template_id), QUOTE_TEMPLATES[0])


def public_fair_value(base: Dict) -> float:
    public_stats = base["public_stats"]
    anchor = float(public_stats["mean"])
    range_mid = (float(public_stats["range_low"]) + float(public_stats["range_high"])) / 2.0
    if base["quotes"]:
        best_bid = max(float(entry["quote"]["bid"]) for entry in base["quotes"])
        best_ask = min(float(entry["quote"]["ask"]) for entry in base["quotes"])
        anchor = anchor * 0.88 + ((best_bid + best_ask) / 2.0) * 0.12
    last_mark = float(base["stats"]["range_low"] + base["stats"]["range_high"]) / 2.0
    last_mark = float(base.get("last_mark", base["stats"].get("mean", range_mid)))
    if abs(last_mark - range_mid) > 0.01 or base["quotes"]:
        anchor = anchor * 0.9 + last_mark * 0.1
    return clamp(anchor, float(public_stats["range_low"]), float(public_stats["range_high"]))


def _private_skew(base: Dict) -> float:
    width = float(base["stats"]["width"])
    private_edge = float(base["stats"]["mean"]) - float(base["public_stats"]["mean"])
    return clamp(private_edge, -0.16 * width, 0.16 * width)


def _private_bias_ratio(base: Dict) -> float:
    return clamp((float(base["stats"]["mean"]) - float(base["public_stats"]["mean"])) / float(base["stats"]["width"]), -0.35, 0.35)


def quote_from_template(
    state: Dict,
    player_id: str,
    template: Dict,
    now_step: int = 0,
    *,
    private_skew_scale: float = 0.5,
) -> Dict | None:
    if template.get("noop"):
        return None
    base = base_feature_vector(state, player_id, now_step)
    if base["own_quote"] and not base["own_quote_refresh_allowed"]:
        return None
    public_stats = base["public_stats"]
    inventory = float(base["position"].get("inventory", 0))
    reservation = (
        public_fair_value(base)
        + _private_skew(base) * clamp(float(private_skew_scale), 0.0, 1.0)
        + float(template.get("reservationOffset", 0.0)) * public_stats["width"] * 0.68
        - inventory * public_stats["width"] * 0.04
    )
    base_half_spread = max(0.18, float(public_stats["stdev"]) * (0.45 + float(template.get("spreadScale", 1.0)) * 0.38))
    competition_spread = (
        max(0.08, min(float(entry["quote"]["ask"]) - float(entry["quote"]["bid"]) for entry in base["quotes"]) * 0.3)
        if base["quotes"]
        else 0.28
    )
    half_spread = max(base_half_spread, competition_spread)
    bid = max(public_stats["range_low"], min(public_stats["range_high"] - 0.01, round(reservation - half_spread, 2)))
    ask = max(bid + 0.01, min(public_stats["range_high"], round(reservation + half_spread, 2)))
    competitive = float(template.get("spreadScale", 1.0)) <= 1.15 and abs(float(template.get("reservationOffset", 0.0))) <= 0.12
    if competitive and base["quotes"]:
        best_bid = max(float(entry["quote"]["bid"]) for entry in base["quotes"])
        best_ask = min(float(entry["quote"]["ask"]) for entry in base["quotes"])
        if reservation >= best_bid:
            bid = min(ask - 0.01, max(bid, round(best_bid + 0.01, 2)))
        if reservation <= best_ask:
            ask = max(bid + 0.01, min(ask, round(best_ask - 0.01, 2)))
    return {
        "bid": bid,
        "ask": ask,
        "size": int(max(1, min(5, int(template.get("size", 1))))),
    }


def hybrid_as_quote_from_params(
    state: Dict,
    player_id: str,
    params: Dict,
    now_step: int = 0,
) -> Dict | None:
    base = base_feature_vector(state, player_id, now_step)
    if base["own_quote"] and not base["own_quote_refresh_allowed"]:
        return None
    public_stats = base["public_stats"]
    width = float(public_stats["width"])
    stdev_ratio = clamp(float(public_stats["stdev"]) / max(0.01, width), 0.0, 0.45)
    inventory = float(base["position"].get("inventory", 0.0))
    seat_ratio = clamp(len(state["active_seat_ids"]) / 10.0, 0.0, 1.0)
    risk_aversion = clamp(float(params.get("risk_aversion", 0.5)), 0.0, 1.0)
    inventory_skew = clamp(float(params.get("inventory_skew", 0.45)), 0.0, 1.5)
    spread_multiplier = clamp(float(params.get("spread_multiplier", 1.0)), 0.65, 2.4)
    quote_mode = str(params.get("quote_mode", "balanced"))
    private_skew_scale = clamp(float(params.get("private_skew_scale", 0.35)), 0.0, 0.7)
    locked_role = (state.get("role_constraints") or {}).get(player_id)
    public_fair = public_fair_value(base)
    private_component = _private_skew(base) * private_skew_scale
    inventory_component = inventory * width * (0.025 + 0.08 * risk_aversion) * inventory_skew
    mode_skew = {
        "bid": -0.05,
        "ask": 0.05,
        "wide": 0.0,
        "tight": 0.0,
        "balanced": 0.0,
    }.get(quote_mode, 0.0) * width
    if locked_role == "maker":
        private_component = 0.0
        mode_skew = 0.0
        spread_multiplier = min(spread_multiplier, 0.95)
        risk_aversion = min(risk_aversion, 0.45)
    else:
        private_component *= 1.0 + seat_ratio * 1.25
    reservation = public_fair + private_component - inventory_component + mode_skew
    competition_spread = (
        min(float(entry["quote"]["ask"]) - float(entry["quote"]["bid"]) for entry in base["quotes"])
        if base["quotes"]
        else 0.42
    )
    base_half_spread = max(0.18, width * (0.018 + stdev_ratio * (0.55 + risk_aversion * 0.75)))
    half_spread = max(base_half_spread * spread_multiplier * (1.0 + seat_ratio * 0.55), competition_spread * 0.42)
    if locked_role == "maker":
        half_spread = max(0.04, min(half_spread, width * 0.04))
    if quote_mode == "wide":
        half_spread *= 1.2
    elif quote_mode == "tight":
        half_spread *= 0.88
    bid = max(float(public_stats["range_low"]), min(float(public_stats["range_high"]) - 0.01, round(reservation - half_spread, 2)))
    ask = max(bid + 0.01, min(float(public_stats["range_high"]), round(reservation + half_spread, 2)))
    toxicity = quote_toxicity(base, {"bid": bid, "ask": ask})
    if toxicity > 0.12:
        widen = min(width * 0.1, toxicity * width * 0.45)
        bid = max(float(public_stats["range_low"]), round(bid - widen, 2))
        ask = min(float(public_stats["range_high"]), round(max(ask + widen, bid + 0.01), 2))
    return {
        "bid": bid,
        "ask": ask,
        "size": int(max(1, min(5, int(params.get("size", 1))))),
    }


def quote_toxicity(base: Dict, quote: Dict | None) -> float:
    if not quote or quote.get("bid") is None or quote.get("ask") is None:
        return 0.0
    width = max(0.01, float(base["stats"]["width"]))
    fair = float(base["stats"]["mean"])
    bid_edge = (float(quote["bid"]) - fair) / width
    ask_edge = (fair - float(quote["ask"])) / width
    spread = max(0.0, float(quote["ask"]) - float(quote["bid"])) / width
    narrow_penalty = max(0.0, 0.035 - spread) * 1.6
    return max(0.0, bid_edge, ask_edge) + narrow_penalty


def _best_take(base: Dict) -> Dict | None:
    best_take = None
    for entry in base["quotes"]:
        buy_edge = (base["stats"]["mean"] - float(entry["quote"]["ask"])) / base["stats"]["width"]
        sell_edge = (float(entry["quote"]["bid"]) - base["stats"]["mean"]) / base["stats"]["width"]
        edge = max(buy_edge, sell_edge)
        action = "buy" if buy_edge >= sell_edge else "sell"
        if best_take is None or edge > best_take["edge"]:
            best_take = {"entry": entry, "action": action, "edge": edge}
    return best_take


def _reveal_ready(state: Dict, player_id: str, base: Dict) -> bool:
    reveal_progress = state["revealed_board_count"]
    board_total = len(state["board_cards"])
    seat_ratio = clamp(len(state["active_seat_ids"]) / 10.0, 0.0, 1.0)
    reveal_allowed = len(base["quotes"]) == 0 or reveal_progress >= board_total - 1
    if seat_ratio >= 0.8:
        reveal_allowed = reveal_progress >= board_total - 1 or (len(base["quotes"]) == 0 and not base["own_quote"])
    return (
        reveal_progress < board_total
        and player_id not in state["reveal_votes"]
        and reveal_allowed
    )


def wait_decision(state: Dict, player_id: str, now_step: int = 0) -> Dict:
    return {"type": "wait", "payload": {}, "baselineId": BASELINE_WAIT}


def maker_public_mid_decision(state: Dict, player_id: str, now_step: int = 0) -> Dict:
    base = base_feature_vector(state, player_id, now_step)
    if base["own_quote"] and not base["own_quote_refresh_allowed"]:
        return wait_decision(state, player_id, now_step)
    template_id = "mid_00_100_1" if base["public_stats"]["stdev"] / base["public_stats"]["width"] <= 0.16 else "mid_00_145_2"
    payload = quote_from_template(state, player_id, _template_by_id(template_id), now_step, private_skew_scale=0.0)
    if not payload:
        return wait_decision(state, player_id, now_step)
    return {"type": "submit_quote", "payload": payload, "templateId": template_id, "baselineId": BASELINE_MAKER_PUBLIC_MID}


def maker_public_skew_inventory_decision(
    state: Dict,
    player_id: str,
    now_step: int = 0,
    *,
    private_skew_scale: float = 0.8,
) -> Dict:
    base = base_feature_vector(state, player_id, now_step)
    if base["own_quote"] and not base["own_quote_refresh_allowed"]:
        return wait_decision(state, player_id, now_step)
    inventory = float(base["position"].get("inventory", 0))
    uncertainty_ratio = float(base["public_stats"]["stdev"]) / float(base["public_stats"]["width"])
    seat_ratio = clamp(len(state["active_seat_ids"]) / 10.0, 0.0, 1.0)
    private_bias = _private_bias_ratio(base)
    if inventory > 1.4:
        template_id = "buy_18_100_1"
    elif inventory < -1.4:
        template_id = "sell_18_100_1"
    elif private_bias >= 0.12:
        template_id = "sell_18_075_1"
    elif private_bias >= 0.06:
        template_id = "sell_12_075_1"
    elif private_bias <= -0.12:
        template_id = "buy_18_075_1"
    elif private_bias <= -0.06:
        template_id = "buy_12_075_1"
    elif seat_ratio >= 0.8:
        template_id = "mid_00_075_1"
    elif uncertainty_ratio > 0.18:
        template_id = "mid_00_115_2"
    elif len(base["quotes"]) > 2:
        template_id = "mid_00_075_1"
    else:
        template_id = "mid_00_100_1"
    payload = quote_from_template(
        state,
        player_id,
        _template_by_id(template_id),
        now_step,
        private_skew_scale=private_skew_scale,
    )
    if not payload:
        return wait_decision(state, player_id, now_step)
    return {"type": "submit_quote", "payload": payload, "templateId": template_id, "baselineId": BASELINE_MAKER_PUBLIC_SKEW}


def taker_best_edge_decision(state: Dict, player_id: str, now_step: int = 0) -> Dict:
    base = base_feature_vector(state, player_id, now_step)
    best_take = _best_take(base)
    if best_take:
        age_ratio = clamp(float(best_take["entry"]["age"]) / 2.0, 0.0, 2.0)
        seat_ratio = clamp(len(state["active_seat_ids"]) / 10.0, 0.0, 1.0)
        threshold = max(0.002, 0.012 - age_ratio * 0.008 - seat_ratio * 0.004)
        if best_take["edge"] > threshold:
            return {
                "type": "taker_action",
                "payload": {
                    "targetPlayerId": best_take["entry"]["target_player_id"],
                    "action": best_take["action"],
                },
                "baselineId": BASELINE_TAKER_BEST_EDGE,
            }
    if _reveal_ready(state, player_id, base):
        return {"type": "request_next_reveal", "payload": {}, "baselineId": BASELINE_TAKER_BEST_EDGE}
    return wait_decision(state, player_id, now_step)


def balanced_public_make_private_take_decision(state: Dict, player_id: str, now_step: int = 0) -> Dict:
    base = base_feature_vector(state, player_id, now_step)
    best_take = _best_take(base)
    if best_take:
        age_ratio = clamp(float(best_take["entry"]["age"]) / 2.0, 0.0, 2.0)
        seat_ratio = clamp(len(state["active_seat_ids"]) / 10.0, 0.0, 1.0)
        uncertainty_ratio = clamp(float(base["stats"]["stdev"]) / float(base["stats"]["width"]), 0.0, 0.3)
        quote_skew = abs((midpoint(best_take["entry"]["quote"]) or float(base["public_stats"]["mean"])) - float(base["public_stats"]["mean"]))
        quote_skew_ratio = clamp(quote_skew / float(base["stats"]["width"]), 0.0, 0.25)
        take_threshold = max(
            0.001,
            0.01 + uncertainty_ratio * 0.02 - age_ratio * 0.02 - quote_skew_ratio * 0.05 - seat_ratio * 0.012,
        )
        if best_take["edge"] > take_threshold:
            return {
                "type": "taker_action",
                "payload": {
                    "targetPlayerId": best_take["entry"]["target_player_id"],
                    "action": best_take["action"],
                },
                "baselineId": BASELINE_BALANCED,
            }

    own_quote = base["own_quote"]
    need_quote = (
        not own_quote
        or (base["own_quote_refresh_allowed"] and (base["own_quote_age_ratio"] > 0.55 or abs(base["own_mid_bias"]) > 0.05))
    )
    if need_quote:
        seat_ratio = clamp(len(state["active_seat_ids"]) / 10.0, 0.0, 1.0)
        return maker_public_skew_inventory_decision(
            state,
            player_id,
            now_step,
            private_skew_scale=0.35 + seat_ratio * 0.45,
        ) | {"baselineId": BASELINE_BALANCED}
    if _reveal_ready(state, player_id, base):
        return {"type": "request_next_reveal", "payload": {}, "baselineId": BASELINE_BALANCED}
    return {"type": "wait", "payload": {}, "baselineId": BASELINE_BALANCED}


def decision_for_baseline(baseline_id: str, state: Dict, player_id: str, now_step: int = 0) -> Dict:
    if baseline_id == BASELINE_WAIT:
        return wait_decision(state, player_id, now_step)
    if baseline_id == BASELINE_MAKER_PUBLIC_MID:
        return maker_public_mid_decision(state, player_id, now_step)
    if baseline_id == BASELINE_MAKER_PUBLIC_SKEW:
        return maker_public_skew_inventory_decision(state, player_id, now_step)
    if baseline_id == BASELINE_TAKER_BEST_EDGE:
        return taker_best_edge_decision(state, player_id, now_step)
    return balanced_public_make_private_take_decision(state, player_id, now_step)


def heuristic_decision(state: Dict, player_id: str, now_step: int = 0) -> Dict:
    return balanced_public_make_private_take_decision(state, player_id, now_step)
