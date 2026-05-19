from __future__ import annotations

import unittest

from card_rl.simulator import CardMarketSimulator, IncentiveSchedule, ROLE_BALANCE_SEAT_ROLES


class SimulatorParityTests(unittest.TestCase):
    def test_take_fills_one_unit_and_leaves_quote_live(self) -> None:
        simulator = CardMarketSimulator(seed=7)
        state = simulator.create_state(2)
        simulator.apply_quote(state, "seat-1", {"bid": 1, "ask": 2, "size": 2})

        traded = simulator.apply_take(state, "seat-2", {"targetPlayerId": "seat-1", "action": "buy"})

        self.assertTrue(traded)
        self.assertEqual(state["positions"]["seat-2"]["inventory"], 1)
        self.assertEqual(state["positions"]["seat-1"]["inventory"], -1)
        self.assertEqual(state["live_quotes"]["seat-1"]["size"], 1)
        self.assertEqual(state["live_quotes"]["seat-1"]["initial_size"], 2)

    def test_unfilled_quote_cannot_be_replaced(self) -> None:
        simulator = CardMarketSimulator(seed=9)
        state = simulator.create_state(2)
        simulator.apply_quote(state, "seat-1", {"bid": 1, "ask": 2, "size": 2})
        simulator.apply_quote(state, "seat-1", {"bid": 2, "ask": 3, "size": 1})

        self.assertEqual(state["live_quotes"]["seat-1"]["bid"], 1)
        self.assertEqual(state["live_quotes"]["seat-1"]["ask"], 2)
        self.assertEqual(state["live_quotes"]["seat-1"]["size"], 2)

    def test_partially_filled_quote_can_be_replaced(self) -> None:
        simulator = CardMarketSimulator(seed=11)
        state = simulator.create_state(2)
        simulator.apply_quote(state, "seat-1", {"bid": 1, "ask": 2, "size": 2})
        simulator.apply_take(state, "seat-2", {"targetPlayerId": "seat-1", "action": "buy"})
        simulator.apply_quote(state, "seat-1", {"bid": 2, "ask": 3, "size": 1})

        self.assertEqual(state["live_quotes"]["seat-1"]["bid"], 2)
        self.assertEqual(state["live_quotes"]["seat-1"]["ask"], 3)
        self.assertEqual(state["live_quotes"]["seat-1"]["size"], 1)
        self.assertEqual(state["live_quotes"]["seat-1"]["initial_size"], 1)

    def test_settlement_matches_raw_mark_to_market(self) -> None:
        simulator = CardMarketSimulator(seed=13)
        state = simulator.create_state(2)
        simulator.apply_quote(state, "seat-1", {"bid": 1, "ask": 2, "size": 1})
        simulator.apply_take(state, "seat-2", {"targetPlayerId": "seat-1", "action": "buy"})

        summary = simulator.settle(state)

        self.assertEqual(summary.risk_adjusted_pnl, summary.raw_pnl)

    def test_fill_incentives_apply_to_maker_and_taker_cashflows(self) -> None:
        simulator = CardMarketSimulator(
            seed=17,
            incentive_schedule=IncentiveSchedule(maker_fill_rebate=0.001, taker_fill_fee=0.001),
        )
        state = simulator.create_state(2)
        state["range_low"] = -10
        state["range_high"] = 10
        simulator.apply_quote(state, "seat-1", {"bid": 1, "ask": 2, "size": 1})

        traded = simulator.apply_take(state, "seat-2", {"targetPlayerId": "seat-1", "action": "buy"})

        self.assertTrue(traded)
        self.assertEqual(state["positions"]["seat-1"]["cash"], 2.02)
        self.assertEqual(state["positions"]["seat-2"]["cash"], -2.02)
        self.assertEqual(state["log"][-1]["maker_incentive"], 0.02)
        self.assertEqual(state["log"][-1]["taker_fee"], 0.02)

    def test_role_locked_mode_masks_invalid_quote_and_take_actions(self) -> None:
        simulator = CardMarketSimulator(seed=19)

        def maker_actor(_state, _player_id, _now_step):
            return {"type": "taker_action", "payload": {"targetPlayerId": "seat-2", "action": "buy"}}

        def taker_actor(_state, _player_id, _now_step):
            return {"type": "submit_quote", "payload": {"bid": 1, "ask": 2, "size": 1}}

        state, _summary = simulator.run_episode(
            2,
            {"seat-1": maker_actor, "seat-2": taker_actor},
            max_steps=1,
            role_constraints=ROLE_BALANCE_SEAT_ROLES,
        )

        self.assertEqual(state["live_quotes"], {})
        self.assertEqual(state["positions"]["seat-1"]["inventory"], 0)
        self.assertEqual(state["positions"]["seat-2"]["inventory"], 0)

    def test_role_locked_pass_penalties_apply_on_wide_and_tight_quotes(self) -> None:
        simulator = CardMarketSimulator(
            seed=23,
            incentive_schedule=IncentiveSchedule(
                wide_quote_pass_penalty=0.001,
                tight_quote_refusal_penalty=0.001,
            ),
        )
        wide_state = simulator.create_state(2, role_constraints=ROLE_BALANCE_SEAT_ROLES)
        wide_state["range_low"] = -10
        wide_state["range_high"] = 10
        simulator.apply_quote(wide_state, "seat-1", {"bid": -2, "ask": 2, "size": 1})

        passed = simulator.apply_taker_pass(wide_state, "seat-2", "seat-1")

        self.assertTrue(passed)
        self.assertEqual(wide_state["positions"]["seat-1"]["cash"], -0.02)
        self.assertEqual(wide_state["log"][-1]["maker_pass_penalty"], 0.02)

        tight_state = simulator.create_state(2, role_constraints=ROLE_BALANCE_SEAT_ROLES)
        tight_state["range_low"] = -10
        tight_state["range_high"] = 10
        simulator.apply_quote(tight_state, "seat-1", {"bid": 0.98, "ask": 1.02, "size": 1})

        passed = simulator.apply_taker_pass(tight_state, "seat-2", "seat-1")

        self.assertTrue(passed)
        self.assertEqual(tight_state["positions"]["seat-2"]["cash"], -0.02)
        self.assertEqual(tight_state["log"][-1]["taker_pass_penalty"], 0.02)


if __name__ == "__main__":
    unittest.main()
