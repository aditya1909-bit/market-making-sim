from __future__ import annotations

import json
from pathlib import Path

from .model import LinearCardPolicy

CARD_POLICY_COMPAT_VERSION = 1


def build_export(policy: LinearCardPolicy, version: str = "local-card-policy", source: str = "python-linear-ppo") -> dict:
    return {
        "metadata": {
            "version": version,
            "source": source,
            "compatibilityVersion": CARD_POLICY_COMPAT_VERSION,
        },
        "model": policy.to_dict(),
    }


def export_js_module(policy: LinearCardPolicy, output_path: str | Path, version: str = "local-card-policy") -> Path:
    output = Path(output_path)
    payload = build_export(policy, version=version)
    text = "export const CARD_RL_POLICY = " + json.dumps(payload, indent=2) + ";\n"
    output.write_text(text, encoding="utf-8")
    return output
