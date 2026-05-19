from __future__ import annotations

import unittest

from card_rl.features import base_feature_vector
from card_rl.heuristic import (
    BASELINE_BALANCED,
    decision_for_baseline,
    maker_public_mid_decision,
    maker_public_skew_inventory_decision,
    public_fair_value,
)
from card_rl.simulator import CardMarketSimulator


class HeuristicBaselineTests(unittest.TestCase):
    def test_balanced_baseline_takes_stale_positive_edge_quote(self) -> None:
        simulator = CardMarketSimulator(seed=21)
        state = simulator.create_state(2)
        base = base_feature_vector(state, "seat-2", 2)
        mean = float(base["stats"]["mean"])
        state["live_quotes"]["seat-1"] = {
            "bid": round(mean - 0.6, 2),
            "ask": round(mean - 0.35, 2),
            "size": 1,
            "initial_size": 1,
            "quoted_at_step": 0,
        }

        decision = decision_for_baseline(BASELINE_BALANCED, state, "seat-2", 2)

        self.assertEqual(decision["type"], "taker_action")
        self.assertEqual(decision["payload"]["targetPlayerId"], "seat-1")
        self.assertEqual(decision["payload"]["action"], "buy")

    def test_public_skew_maker_uses_directional_template_for_private_edge(self) -> None:
        simulator = CardMarketSimulator(seed=31)
        state = simulator.create_state(2)
        state["private_hands"]["seat-1"] = [
            {"id": "1-AS", "code": "AS", "rank": "A", "rank_value": 14, "suit": "S", "color": "black"},
            {"id": "1-KS", "code": "KS", "rank": "K", "rank_value": 13, "suit": "S", "color": "black"},
        ]

        decision = maker_public_skew_inventory_decision(state, "seat-1", 0)

        self.assertEqual(decision["type"], "submit_quote")
        self.assertTrue(str(decision["templateId"]).startswith("sell_"))

    def test_public_mid_maker_does_not_quote_full_private_skew(self) -> None:
        simulator = CardMarketSimulator(seed=41)
        state = simulator.create_state(2)
        state["private_hands"]["seat-1"] = [
            {"id": "1-AS", "code": "AS", "rank": "A", "rank_value": 14, "suit": "S", "color": "black"},
            {"id": "1-KS", "code": "KS", "rank": "K", "rank_value": 13, "suit": "S", "color": "black"},
        ]
        base = base_feature_vector(state, "seat-1", 0)
        decision = maker_public_mid_decision(state, "seat-1", 0)
        quoted_mid = (float(decision["payload"]["bid"]) + float(decision["payload"]["ask"])) / 2.0

        self.assertEqual(decision["type"], "submit_quote")
        self.assertLess(abs(quoted_mid - public_fair_value(base)), 0.8)


if __name__ == "__main__":
    unittest.main()
