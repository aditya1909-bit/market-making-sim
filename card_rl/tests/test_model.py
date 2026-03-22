from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from card_rl.export_policy import export_js_module
from card_rl.model import bootstrap_policy
from card_rl.simulator import CardMarketSimulator


class ModelInferenceTests(unittest.TestCase):
    def test_bootstrap_policy_produces_supported_action(self) -> None:
        simulator = CardMarketSimulator(seed=3)
        state = simulator.create_state(3)
        policy = bootstrap_policy()
        action = policy.choose_action(state, "seat-1", 0)
        self.assertIn(action["type"], {"submit_quote", "taker_action", "request_next_reveal", "wait"})

    def test_export_writes_js_module(self) -> None:
        policy = bootstrap_policy()
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "card-policy.js"
            export_js_module(policy, output, version="unit-test")
            text = output.read_text(encoding="utf-8")
            self.assertIn("export const CARD_RL_POLICY =", text)
            self.assertIn('"version": "unit-test"', text)

    def test_accumulated_gradients_match_direct_updates(self) -> None:
        simulator = CardMarketSimulator(seed=5)
        state = simulator.create_state(4)
        base_values = [0.1] * 15
        direct = bootstrap_policy()
        accumulated = bootstrap_policy()

        quote = direct.choose_quote(state, "seat-1", 0)
        take = direct.choose_take(state, "seat-1", 0)
        reveal = direct.choose_reveal(state, "seat-1", 0)

        direct.update_quote_policy(quote["features"], quote["probabilities"], 1, 0.7, 0.01)
        direct.update_take_policy(take["features"], take["probabilities"], min(1, len(take["probabilities"]) - 1), 0.5, 0.01)
        direct.update_reveal_policy(reveal["base"]["values"], reveal["probability"], True, 0.2, 0.01)
        direct.update_value(base_values, 1.25, 0.01)

        gradients = accumulated.zero_gradients()
        accumulated.accumulate_quote_gradient(gradients, quote["features"], quote["probabilities"], 1, 0.7)
        accumulated.accumulate_take_gradient(
            gradients,
            take["features"],
            take["probabilities"],
            min(1, len(take["probabilities"]) - 1),
            0.5,
        )
        accumulated.accumulate_reveal_gradient(gradients, reveal["base"]["values"], reveal["probability"], True, 0.2)
        accumulated.accumulate_value_gradient(gradients, base_values, 1.25)
        accumulated.apply_gradients(gradients, 0.01)

        self.assertEqual(direct.to_dict(), accumulated.to_dict())


if __name__ == "__main__":
    unittest.main()
