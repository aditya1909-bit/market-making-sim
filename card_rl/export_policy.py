from __future__ import annotations

import json
from pathlib import Path

from .model import MODEL_COMPATIBILITY_VERSION, LinearCardPolicy, NeuralCardPolicy


def build_policy_entry(
    policy: LinearCardPolicy | NeuralCardPolicy,
    *,
    family: str,
    version: str,
    source: str,
    evaluation: dict | None = None,
) -> dict:
    return {
        "id": version,
        "family": family,
        "version": version,
        "compatibilityVersion": MODEL_COMPATIBILITY_VERSION,
        "source": source,
        "evaluation": evaluation or {},
        "model": policy.to_dict(),
    }


def build_registry_export(
    *,
    linear_policy: LinearCardPolicy,
    neural_policy: NeuralCardPolicy,
    linear_version: str = "linear-v2",
    neural_version: str = "neural-v1",
    source: str = "python-card-rl",
    evaluation: dict | None = None,
    default_policy_ids: dict | None = None,
) -> dict:
    return {
        "metadata": {
            "source": source,
            "compatibilityVersion": MODEL_COMPATIBILITY_VERSION,
            "defaultPolicyIds": default_policy_ids or {},
        },
        "policies": {
            linear_version: build_policy_entry(
                linear_policy,
                family="linear",
                version=linear_version,
                source=f"{source}:linear",
                evaluation=(evaluation or {}).get("linear"),
            ),
            neural_version: build_policy_entry(
                neural_policy,
                family="neural",
                version=neural_version,
                source=f"{source}:neural",
                evaluation=(evaluation or {}).get("neural"),
            ),
        },
    }


def export_js_module(
    linear_policy: LinearCardPolicy,
    neural_policy: NeuralCardPolicy,
    output_path: str | Path,
    *,
    linear_version: str = "linear-v2",
    neural_version: str = "neural-v1",
    source: str = "python-card-rl",
    evaluation: dict | None = None,
    default_policy_ids: dict | None = None,
) -> Path:
    output = Path(output_path)
    payload = build_registry_export(
        linear_policy=linear_policy,
        neural_policy=neural_policy,
        linear_version=linear_version,
        neural_version=neural_version,
        source=source,
        evaluation=evaluation,
        default_policy_ids=default_policy_ids,
    )
    text = "export const CARD_RL_POLICY_REGISTRY = " + json.dumps(payload, indent=2) + ";\n"
    output.write_text(text, encoding="utf-8")
    return output
