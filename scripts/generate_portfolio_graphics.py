#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".tmp_mpl"))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch


RESULTS = ROOT / "results" / "portfolio"
ASSETS = ROOT / "docs" / "assets"

COLORS = {
    "ink": "#172033",
    "muted": "#64748b",
    "line": "#cbd5e1",
    "blue": "#2563eb",
    "green": "#059669",
    "orange": "#d97706",
    "red": "#dc2626",
    "cyan": "#0891b2",
    "bg": "#f8fafc",
    "panel": "#ffffff",
}


def load_summary() -> dict:
    path = RESULTS / "summary.json"
    if not path.exists():
        raise SystemExit(f"Missing {path}. Run scripts/portfolio_benchmark.py first.")
    return json.loads(path.read_text(encoding="utf-8"))


def save(fig: plt.Figure, name: str) -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    path = ASSETS / name
    fig.savefig(path, dpi=180, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close(fig)
    print(f"wrote {path}")


def style_axis(ax: plt.Axes) -> None:
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color(COLORS["line"])
    ax.spines["bottom"].set_color(COLORS["line"])
    ax.tick_params(colors=COLORS["muted"], labelsize=9)
    ax.grid(axis="y", color="#e2e8f0", linewidth=0.8)
    ax.set_axisbelow(True)


def wrap_for_box(text: str, width: float, chars_per_axis: int) -> str:
    line_width = max(8, int(width * chars_per_axis))
    wrapped_lines = []
    for line in str(text).splitlines() or [""]:
        wrapped_lines.extend(textwrap.wrap(line, width=line_width, break_long_words=False) or [""])
    return "\n".join(wrapped_lines)


def draw_box(
    ax: plt.Axes,
    xy: tuple[float, float],
    wh: tuple[float, float],
    title: str,
    body: str,
    color: str,
    *,
    title_font: float = 10.8,
    body_font: float = 8.8,
    body_linespacing: float = 1.28,
) -> None:
    x, y = xy
    w, h = wh
    patch = FancyBboxPatch(
        (x, y),
        w,
        h,
        boxstyle="round,pad=0.018,rounding_size=0.025",
        linewidth=1.1,
        edgecolor=color,
        facecolor=COLORS["panel"],
    )
    ax.add_patch(patch)
    title_text = wrap_for_box(title, w, 58)
    body_text = wrap_for_box(body, w, 48)
    title_artist = ax.text(
        x + 0.03,
        y + h - 0.055,
        title_text,
        color=color,
        fontsize=title_font,
        fontweight="bold",
        va="top",
        linespacing=1.15,
        clip_on=True,
    )
    title_lines = max(1, title_text.count("\n") + 1)
    body_y = y + h - 0.105 - (title_lines - 1) * 0.045
    body_artist = ax.text(
        x + 0.03,
        body_y,
        body_text,
        color=COLORS["ink"],
        fontsize=body_font,
        va="top",
        linespacing=body_linespacing,
        clip_on=True,
    )
    title_artist.set_clip_path(patch)
    body_artist.set_clip_path(patch)


def draw_arrow(ax: plt.Axes, start: tuple[float, float], end: tuple[float, float], color: str = COLORS["muted"]) -> None:
    arrow = FancyArrowPatch(start, end, arrowstyle="-|>", mutation_scale=12, linewidth=1.4, color=color)
    ax.add_patch(arrow)


def architecture(summary: dict) -> None:
    fig, ax = plt.subplots(figsize=(12.5, 7.0))
    fig.patch.set_facecolor(COLORS["bg"])
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")
    ax.text(0.03, 0.95, "Realtime Quant Game Architecture", fontsize=18, fontweight="bold", color=COLORS["ink"], va="top")
    ax.text(
        0.03,
        0.90,
        "Static UI, authoritative Cloudflare Durable Objects, reproducible RL training and gated policy export.",
        fontsize=10.5,
        color=COLORS["muted"],
        va="top",
    )

    arch_box = {"title_font": 9.6, "body_font": 7.6, "body_linespacing": 1.12}
    draw_box(ax, (0.04, 0.56), (0.23, 0.27), "Static Frontend", "HTML/CSS/JS\nlive room UI\nmobile layouts", COLORS["blue"], **arch_box)
    draw_box(ax, (0.385, 0.56), (0.23, 0.27), "Worker Edge API", "HTTP routes\nWebSocket upgrade\nbot APIs", COLORS["cyan"], **arch_box)
    draw_box(ax, (0.73, 0.56), (0.23, 0.27), "Room Durable Object", "authoritative state\nsettlement + timers\nreconnect/rematch", COLORS["green"], **arch_box)

    draw_box(ax, (0.04, 0.16), (0.23, 0.27), "Self-Play Benchmarks", "hidden-value eval\ncard-market eval\nquality gates", COLORS["orange"], **arch_box)
    draw_box(ax, (0.385, 0.16), (0.23, 0.27), "Policy Registry", "exported weights\nversioned metadata\nfallback policies", COLORS["red"], **arch_box)
    draw_box(ax, (0.73, 0.16), (0.23, 0.27), "Live Bots", "balanced heuristics\nsanity wrappers\nhuman pacing", COLORS["green"], **arch_box)

    draw_arrow(ax, (0.27, 0.70), (0.385, 0.70))
    draw_arrow(ax, (0.615, 0.70), (0.73, 0.70))
    draw_arrow(ax, (0.155, 0.56), (0.155, 0.43), COLORS["orange"])
    draw_arrow(ax, (0.27, 0.29), (0.385, 0.29), COLORS["orange"])
    draw_arrow(ax, (0.615, 0.29), (0.73, 0.29), COLORS["red"])
    draw_arrow(ax, (0.845, 0.43), (0.845, 0.56), COLORS["green"])

    tests = summary.get("tests", {})
    worker = tests.get("worker", {}).get("pass")
    card = tests.get("card_rl", {}).get("pass")
    caption = f"Quality evidence: Worker tests {worker or 'n/a'} passing, Card RL tests {card or 'n/a'} passing"
    ax.text(0.04, 0.055, caption, fontsize=10.5, color=COLORS["ink"], fontweight="bold")
    save(fig, "architecture.png")


def bot_uplift(summary: dict) -> None:
    hidden = summary.get("hidden_value", {}).get("uplifts", {})
    values = [hidden.get("maker_uplift", 0), hidden.get("taker_uplift", 0)]
    labels = ["RL maker\nvs fallback", "RL taker\nvs fallback"]
    fig, ax = plt.subplots(figsize=(8, 4.8))
    fig.patch.set_facecolor(COLORS["bg"])
    bars = ax.bar(labels, values, color=[COLORS["blue"], COLORS["green"]], width=0.55)
    style_axis(ax)
    ax.set_title("Hidden-Value Bot Uplift", loc="left", fontsize=15, color=COLORS["ink"], fontweight="bold")
    ax.set_ylabel("PnL / game uplift")
    ax.axhline(0, color=COLORS["line"], linewidth=1)
    for bar, value in zip(bars, values):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            value + (max(values) * 0.03 if max(values) else 1),
            f"{value:,.0f}",
            ha="center",
            va="bottom",
            color=COLORS["ink"],
            fontweight="bold",
        )
    params = summary.get("parameters", {})
    ax.text(
        0.0,
        -0.22,
        f"Holdout benchmark: {params.get('hidden_scenarios', 'n/a')} scenarios x {params.get('hidden_games_per_scenario', 'n/a')} variants.",
        transform=ax.transAxes,
        color=COLORS["muted"],
        fontsize=9,
    )
    save(fig, "bot-uplift.png")


def card_behavior(summary: dict) -> None:
    rows = summary.get("card_market", {}).get("behavior_rows", [])
    df = pd.DataFrame(rows)
    fig, ax = plt.subplots(figsize=(10, 5.2))
    fig.patch.set_facecolor(COLORS["bg"])
    if df.empty:
        ax.text(0.5, 0.5, "Run portfolio_benchmark.py to populate card behavior data.", ha="center", va="center")
        ax.axis("off")
        save(fig, "card-behavior.png")
        return
    focus = df[df["policy"].eq("linear-v3")].sort_values("seats")
    if focus.empty:
        focus = df[df["policy"].eq("linear-v2")].sort_values("seats")
    bottom = np.zeros(len(focus))
    x = np.arange(len(focus))
    for label, column, color in [
        ("Quote", "quote_rate", COLORS["blue"]),
        ("Take", "take_rate", COLORS["green"]),
        ("Reveal", "reveal_rate", COLORS["orange"]),
        ("Wait", "wait_rate", COLORS["muted"]),
    ]:
        values = focus[column].to_numpy() * 100
        ax.bar(x, values, bottom=bottom, color=color, label=label, width=0.62)
        bottom += values
    style_axis(ax)
    ax.set_xticks(x, [str(int(v)) for v in focus["seats"]])
    ax.set_xlabel("Seat count")
    ax.set_ylabel("Decision mix (%)")
    ax.set_ylim(0, max(100, bottom.max() * 1.08))
    ax.set_title("Card-Market Learned Policy Behavior", loc="left", fontsize=15, color=COLORS["ink"], fontweight="bold")
    ax.legend(ncol=4, frameon=False, loc="upper center", bbox_to_anchor=(0.5, -0.12))
    ax.text(
        0.0,
        -0.24,
        "Read as a gating chart: high missed-take or low take-rate means the learned policy remains a research candidate.",
        transform=ax.transAxes,
        color=COLORS["muted"],
        fontsize=9,
    )
    save(fig, "card-behavior.png")


def role_balance(summary: dict) -> None:
    role = summary.get("card_market", {}).get("role_balance", {})
    fig, ax = plt.subplots(figsize=(8.5, 5.0))
    fig.patch.set_facecolor(COLORS["bg"])
    labels = ["Maker PnL", "Taker PnL", "Parity Gap"]
    values = [role.get("maker_pnl", 0), role.get("taker_pnl", 0), role.get("parity_gap", 0)]
    colors = [COLORS["blue"], COLORS["green"], COLORS["orange"]]
    bars = ax.bar(labels, values, color=colors, width=0.55)
    style_axis(ax)
    ax.axhline(0, color=COLORS["line"], linewidth=1)
    ax.set_title("Role-Balance Gate", loc="left", fontsize=15, color=COLORS["ink"], fontweight="bold")
    ax.set_ylabel("PnL / parity units")
    for bar, value in zip(bars, values):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            value + (0.05 if value >= 0 else -0.08),
            f"{value:.3f}",
            ha="center",
            va="bottom" if value >= 0 else "top",
            color=COLORS["ink"],
            fontweight="bold",
        )
    live = summary.get("card_market", {}).get("live_card_policy_ready")
    status = "passes live gate" if live else "research benchmark, not live default"
    ax.text(
        0.0,
        -0.20,
        f"Gate status: {status}. Maker quote {role.get('maker_quote_rate', 0) * 100:.1f}%, taker take {role.get('taker_take_rate', 0) * 100:.1f}%.",
        transform=ax.transAxes,
        color=COLORS["muted"],
        fontsize=9,
    )
    save(fig, "role-balance.png")


def quality_panel(summary: dict) -> None:
    tests = summary.get("tests", {})
    worker_pass = tests.get("worker", {}).get("pass") or 0
    card_pass = tests.get("card_rl", {}).get("pass") or 0
    hidden = summary.get("hidden_value", {}).get("uplifts", {})
    live_ready = summary.get("card_market", {}).get("live_card_policy_ready")
    items = [
        ("Worker backend tests", f"{worker_pass}/54 pass" if worker_pass else "not run", COLORS["green"]),
        ("Card RL unit tests", f"{card_pass}/16 pass" if card_pass else "not run", COLORS["green"]),
        ("Hidden-value taker uplift", f"{hidden.get('taker_uplift', 0):,.0f} pnl/game", COLORS["blue"]),
        ("Card RL live gate", "pass" if live_ready else "research only", COLORS["orange"] if not live_ready else COLORS["green"]),
    ]

    fig, ax = plt.subplots(figsize=(10.5, 5.4))
    fig.patch.set_facecolor(COLORS["bg"])
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")
    ax.text(0.04, 0.92, "Quality Gates And Evidence", fontsize=17, fontweight="bold", color=COLORS["ink"], va="top")
    for index, (title, value, color) in enumerate(items):
        x = 0.06 + (index % 2) * 0.47
        y = 0.53 - (index // 2) * 0.31
        draw_box(ax, (x, y), (0.39, 0.25), title, value, color)
    save(fig, "quality-gates.png")


def card_rl_gate(summary: dict) -> None:
    report_path = RESULTS / "card_rl_gate_report.json"
    fig, ax = plt.subplots(figsize=(10, 5.0))
    fig.patch.set_facecolor(COLORS["bg"])
    if not report_path.exists():
        ax.text(0.5, 0.5, "Run scripts/card_rl_production_sweep.py to populate card RL gate data.", ha="center", va="center")
        ax.axis("off")
        save(fig, "card-rl-gate.png")
        return
    report = json.loads(report_path.read_text(encoding="utf-8"))
    rows = pd.DataFrame(report.get("candidates", []))
    if rows.empty:
        ax.text(0.5, 0.5, "No card RL candidates recorded.", ha="center", va="center")
        ax.axis("off")
        save(fig, "card-rl-gate.png")
        return
    rows["mainSeatMean"] = pd.to_numeric(rows["mainSeatMean"], errors="coerce").fillna(0.0)
    rows["failureCount"] = rows["gateFailures"].fillna("").map(lambda value: 0 if not value else len(str(value).split("|")))
    colors = [COLORS["green"] if bool(value) else COLORS["orange"] for value in rows["liveCandidate"]]
    x = np.arange(len(rows))
    bars = ax.bar(x, rows["mainSeatMean"], color=colors, width=0.55)
    style_axis(ax)
    ax.axhline(0, color=COLORS["line"], linewidth=1)
    ax.set_xticks(x, [f"c{int(v)}" for v in rows["candidate"]])
    ax.set_ylabel("Weighted main-seat PnL")
    ax.set_title("Card RL Production Gate Sweep", loc="left", fontsize=15, color=COLORS["ink"], fontweight="bold")
    for bar, failures in zip(bars, rows["failureCount"]):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height(), f"{int(failures)} fails", ha="center", va="bottom", fontsize=9, color=COLORS["ink"])
    best = report.get("bestEvaluation") or {}
    ax.text(
        0.0,
        -0.20,
        f"Best candidate: {report.get('bestPolicyId') or 'n/a'} | promotion: {best.get('promotionDecision', 'n/a')} | live gate: {best.get('liveCandidate', False)}.",
        transform=ax.transAxes,
        color=COLORS["muted"],
        fontsize=9,
    )
    save(fig, "card-rl-gate.png")


def main() -> int:
    summary = load_summary()
    architecture(summary)
    bot_uplift(summary)
    card_behavior(summary)
    role_balance(summary)
    quality_panel(summary)
    card_rl_gate(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
