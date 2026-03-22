from __future__ import annotations

import unittest

from card_rl.features import posterior_stats
from card_rl.simulator import CardMarketSimulator


class PosteriorFeatureTests(unittest.TestCase):
    def test_posterior_stats_are_deterministic(self) -> None:
        simulator = CardMarketSimulator(seed=11)
        state = simulator.create_state(4, "faces_plus_aces")
        stats_a = posterior_stats(state, "seat-1")
        stats_b = posterior_stats(state, "seat-1")
        self.assertEqual(stats_a["mean"], stats_b["mean"])
        self.assertEqual(stats_a["stdev"], stats_b["stdev"])
        self.assertGreaterEqual(stats_a["unknown_count"], 0)


if __name__ == "__main__":
    unittest.main()
