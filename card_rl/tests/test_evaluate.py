from __future__ import annotations

import unittest
from unittest.mock import patch

from card_rl import evaluate, train


class RoleBalanceEvaluationTests(unittest.TestCase):
    def test_role_balance_wait_baseline_is_inactive_and_flat(self) -> None:
        summary, _mode = evaluate._evaluate_role_balance_policy(
            name="wait",
            maker_policy_kind="baseline:wait",
            maker_policy_data=None,
            taker_policy_kind="baseline:wait",
            taker_policy_data=None,
            episodes=12,
            workers=1,
            seed=29,
            incentive_schedule={},
            progress_label="test",
            show_progress=False,
        )

        self.assertEqual(summary["maker_mean_pnl"], 0.0)
        self.assertEqual(summary["taker_mean_pnl"], 0.0)
        self.assertEqual(summary["fills_per_episode"], 0.0)
        self.assertEqual(summary["maker_quote_rate"], 0.0)
        self.assertEqual(summary["taker_take_rate"], 0.0)
        self.assertFalse(summary["activity_ok"])

    def test_schedule_picker_prefers_lowest_parity_gap_among_active_rows(self) -> None:
        schedules = [
            {"maker_fill_rebate": 0.0, "taker_fill_fee": 0.0, "wide_quote_pass_penalty": 0.0, "tight_quote_refusal_penalty": 0.0},
            {"maker_fill_rebate": 0.0005, "taker_fill_fee": 0.0005, "wide_quote_pass_penalty": 0.0, "tight_quote_refusal_penalty": 0.0},
            {"maker_fill_rebate": -0.0005, "taker_fill_fee": -0.0005, "wide_quote_pass_penalty": 0.0, "tight_quote_refusal_penalty": 0.0},
        ]
        mocked_rows = {
            0.0: {"parity_gap": 0.05, "maker_quote_rate": 0.1, "taker_take_rate": 0.02, "activity_ok": False, "objective": 3.0},
            0.0005: {"parity_gap": 0.20, "maker_quote_rate": 0.55, "taker_take_rate": 0.18, "activity_ok": True, "objective": 0.20},
            -0.0005: {"parity_gap": 0.12, "maker_quote_rate": 0.50, "taker_take_rate": 0.16, "activity_ok": True, "objective": 0.12},
        }

        def fake_eval(**kwargs):
            schedule = kwargs["incentive_schedule"]
            rate = float(schedule["maker_fill_rebate"])
            return mocked_rows[rate], "sequential"

        with patch.object(evaluate, "role_balance_incentive_grid", return_value=schedules):
            with patch.object(evaluate, "_evaluate_role_balance_policy", side_effect=fake_eval):
                schedule, summary, evaluations = evaluate._choose_role_balance_schedule(
                    name="linear",
                    policy_kind="heuristic",
                    policy_data=None,
                    episodes=20,
                    workers=1,
                    seed=31,
                )

        self.assertEqual(schedule["maker_fill_rebate"], -0.0005)
        self.assertEqual(summary["parity_gap"], 0.12)
        self.assertEqual(len(evaluations), 3)

    def test_conservative_gate_rejects_taker_favored_maker_toxic_policy(self) -> None:
        summary = {
            count: {
                "take_rate": 0.22,
                "missed_take_rate": 0.4,
                "quote_rate": 0.55,
                "mean": 0.0,
                "maker_markout": -0.9,
                "toxic_quote_rate": 0.2,
            }
            for count in (4, 6, 8, 10)
        }
        role_balance = {
            "maker_mean_pnl": -1.2,
            "maker_ci95": 0.1,
            "taker_mean_pnl": 1.2,
            "taker_ci95": 0.1,
            "maker_quote_rate": 0.6,
            "taker_take_rate": 0.2,
            "parity_gap": 1.2,
            "quote_collapse": False,
            "taker_overtrade": False,
        }
        baseline = {count: {"mean": 0.0} for count in (4, 6, 8, 10)}
        failures = train._family_gate_failures(
            "linear",
            {"summary": summary, "mainSeatMean": 0.0, "roleBalance": role_balance},
            wait_mean=-1.0,
            balanced_mean=0.0,
            heuristic_mean=0.0,
            balanced_summary=baseline,
            heuristic_summary=baseline,
            gate_counts=[4, 6, 8, 10],
            role_balance_summary=role_balance,
        )
        self.assertIn("role_parity_gap", failures)
        self.assertIn("seat_4_maker_toxicity", failures)


if __name__ == "__main__":
    unittest.main()
