from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from typing import Dict, List, Sequence

from .features import BASE_FEATURE_NAMES, QUOTE_FEATURE_NAMES, TAKE_FEATURE_NAMES, base_feature_vector, quote_features, take_features
from .heuristic import quote_from_template
from .rules import MAX_QUOTE_SIZE, QUOTE_TEMPLATES

BOOTSTRAP_QUOTE_WEIGHTS = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [-0.2, -0.6, 0.1, -0.05, -0.03, -0.08, 0.15, -0.05, -0.2, -0.05, 0.05, -0.02, 0.04, -0.01, 0.1, -0.7, -0.5, -0.1],
    [0.2, -0.6, -0.1, -0.05, -0.03, -0.08, -0.05, 0.15, -0.2, 0.05, -0.02, 0.05, -0.01, 0.04, 0.1, 0.7, -0.5, -0.1],
    [0, -0.45, 0, -0.05, -0.03, -0.08, 0.08, 0.08, -0.12, 0, 0.03, 0.03, 0.03, 0.03, 0.08, 0, -0.35, -0.05],
    [0, -0.25, -0.15, 0.08, 0.05, -0.02, 0.04, 0.04, -0.1, 0, 0.03, 0.03, 0.03, 0.03, 0.02, 0, -0.1, 0.18],
    [0, 0.25, 0, 0.05, 0.04, -0.04, -0.05, -0.05, 0.04, 0, 0.01, 0.01, 0.02, 0.02, -0.05, 0, 0.18, -0.05],
    [0, 0.3, -0.12, 0.08, 0.06, -0.02, -0.06, -0.06, 0.08, 0, 0.01, 0.01, 0.02, 0.02, -0.05, 0, 0.22, 0.14],
    [-0.45, -0.35, 0.25, 0.02, 0.02, -0.03, 0.18, -0.08, -0.15, -0.08, 0.06, -0.02, 0.04, -0.01, 0.08, -0.85, -0.25, 0.14],
    [0.45, -0.35, -0.25, 0.02, 0.02, -0.03, -0.08, 0.18, -0.15, 0.08, -0.02, 0.06, -0.01, 0.04, 0.08, 0.85, -0.25, 0.14],
    [-0.7, 0.1, 0.45, 0.1, 0.08, 0.05, 0.12, -0.08, 0.1, -0.1, 0.05, -0.02, 0.03, 0, -0.04, -1.0, 0.2, 0.28],
    [0.7, 0.1, -0.45, 0.1, 0.08, 0.05, -0.08, 0.12, 0.1, 0.1, -0.02, 0.05, 0, 0.03, -0.04, 1.0, 0.2, 0.28],
]
BOOTSTRAP_QUOTE_BIAS = [-0.2, 0.04, 0.04, 0.2, 0.08, -0.05, -0.08, 0.02, 0.02, -0.12, -0.12]
BOOTSTRAP_TAKE_CANDIDATE = [0, 0, 0, -0.08, -0.04, 0.02, 0.2, 0.2, 0, 0, 0, 0, 0, 0, -0.06, 1.8, 1.8, -0.35, -0.12, -0.1]
BOOTSTRAP_TAKE_PASS = [0, 0.35, -0.05, 0.06, 0.03, 0.03, -0.7, -0.7, 0.04, 0, 0, 0, 0, 0, 0.04]
BOOTSTRAP_REVEAL = [0.1, -1.2, 0.04, 1.5, 0.04, -0.15, -0.55, -0.55, 0.2, 0, 0.02, 0.02, 0.03, 0.03, -0.1]


def dot(weights: Sequence[float], values: Sequence[float]) -> float:
    return sum(float(weight) * float(value) for weight, value in zip(weights, values))


def softmax(logits: Sequence[float]) -> List[float]:
    if not logits:
        return []
    peak = max(logits)
    exps = [math.exp(value - peak) for value in logits]
    total = sum(exps) or 1.0
    return [value / total for value in exps]


def sigmoid(value: float) -> float:
    if value >= 0:
        exp_term = math.exp(-value)
        return 1.0 / (1.0 + exp_term)
    exp_term = math.exp(value)
    return exp_term / (1.0 + exp_term)


@dataclass
class LinearCardPolicy:
    quote_templates: List[Dict] = field(default_factory=lambda: [dict(entry) for entry in QUOTE_TEMPLATES])
    quote_weights: List[List[float]] = field(default_factory=list)
    quote_bias: List[float] = field(default_factory=list)
    take_candidate_weights: List[float] = field(default_factory=list)
    take_candidate_bias: float = -0.18
    take_pass_weights: List[float] = field(default_factory=list)
    take_pass_bias: float = 0.12
    reveal_weights: List[float] = field(default_factory=list)
    reveal_bias: float = -0.65
    value_weights: List[float] = field(default_factory=list)
    value_bias: float = 0.0
    parameter_clip: float = 25.0

    def __post_init__(self) -> None:
        if not self.quote_weights:
            self.quote_weights = [[0.0] * len(QUOTE_FEATURE_NAMES) for _ in self.quote_templates]
        if not self.quote_bias:
            self.quote_bias = [0.0 for _ in self.quote_templates]
        if not self.take_candidate_weights:
            self.take_candidate_weights = [0.0] * len(TAKE_FEATURE_NAMES)
        if not self.take_pass_weights:
            self.take_pass_weights = [0.0] * len(BASE_FEATURE_NAMES)
        if not self.reveal_weights:
            self.reveal_weights = [0.0] * len(BASE_FEATURE_NAMES)
        if not self.value_weights:
            self.value_weights = [0.0] * len(BASE_FEATURE_NAMES)

    def copy(self) -> "LinearCardPolicy":
        return LinearCardPolicy.from_dict(self.to_dict())

    def value(self, base_values: Sequence[float]) -> float:
        return dot(self.value_weights, base_values) + self.value_bias

    def choose_quote(self, state: Dict, player_id: str, now_step: int = 0) -> Dict:
        base = base_feature_vector(state, player_id, now_step)
        logits = []
        feature_rows = []
        for template, weights, bias in zip(self.quote_templates, self.quote_weights, self.quote_bias):
            features = quote_features(base, template)
            feature_rows.append(features)
            logits.append(dot(weights, features) + bias)
        probabilities = softmax(logits)
        action_index = sample_index(probabilities)
        template = self.quote_templates[action_index]
        return {
            "type": "submit_quote",
            "template_index": action_index,
            "template": template,
            "payload": quote_from_template(state, player_id, template, now_step),
            "probabilities": probabilities,
            "features": feature_rows,
            "base": base,
        }

    def choose_take(self, state: Dict, player_id: str, now_step: int = 0) -> Dict:
        base = base_feature_vector(state, player_id, now_step)
        feature_rows = [base["values"]]
        logits = [dot(self.take_pass_weights, base["values"]) + self.take_pass_bias]
        entries = base["quotes"]
        for entry in entries:
            features = take_features(base, entry)
            feature_rows.append(features)
            logits.append(dot(self.take_candidate_weights, features) + self.take_candidate_bias)
        probabilities = softmax(logits)
        action_index = sample_index(probabilities)
        if action_index == 0:
            payload = {"action": "pass", "targetPlayerId": None}
        else:
            entry = entries[action_index - 1]
            buy_edge = (base["stats"]["mean"] - float(entry["quote"]["ask"])) / base["stats"]["width"]
            sell_edge = (float(entry["quote"]["bid"]) - base["stats"]["mean"]) / base["stats"]["width"]
            payload = {
                "action": "buy" if buy_edge >= sell_edge else "sell",
                "targetPlayerId": entry["target_player_id"],
            }
        return {
            "type": "taker_action",
            "payload": payload,
            "probabilities": probabilities,
            "features": feature_rows,
            "entries": entries,
            "base": base,
            "action_index": action_index,
        }

    def choose_reveal(self, state: Dict, player_id: str, now_step: int = 0) -> Dict:
        base = base_feature_vector(state, player_id, now_step)
        probability = sigmoid(dot(self.reveal_weights, base["values"]) + self.reveal_bias)
        vote = random.random() < probability
        return {
            "type": "request_next_reveal" if vote else "wait",
            "vote": vote,
            "probability": probability,
            "base": base,
        }

    def choose_action(self, state: Dict, player_id: str, now_step: int = 0) -> Dict:
        take = self.choose_take(state, player_id, now_step)
        quote = self.choose_quote(state, player_id, now_step)
        reveal = self.choose_reveal(state, player_id, now_step)
        take_score = max(take["probabilities"]) if take["probabilities"] else 0.0
        quote_score = max(quote["probabilities"]) if quote["probabilities"] else 0.0
        reveal_score = reveal["probability"] if reveal["vote"] else 0.0
        if take["payload"]["action"] != "pass" and take_score >= quote_score and take_score >= reveal_score:
            return take
        if quote["payload"] is not None:
            return quote
        return reveal

    def zero_gradients(self) -> Dict:
        return {
            "quote_weights": [[0.0] * len(QUOTE_FEATURE_NAMES) for _ in self.quote_templates],
            "quote_bias": [0.0 for _ in self.quote_templates],
            "take_candidate_weights": [0.0] * len(TAKE_FEATURE_NAMES),
            "take_candidate_bias": 0.0,
            "take_pass_weights": [0.0] * len(BASE_FEATURE_NAMES),
            "take_pass_bias": 0.0,
            "reveal_weights": [0.0] * len(BASE_FEATURE_NAMES),
            "reveal_bias": 0.0,
            "value_weights": [0.0] * len(BASE_FEATURE_NAMES),
            "value_bias": 0.0,
        }

    def merge_gradients(self, target: Dict, source: Dict) -> None:
        for row_index, row in enumerate(source["quote_weights"]):
            for feature_index, value in enumerate(row):
                target["quote_weights"][row_index][feature_index] += float(value)
        for index, value in enumerate(source["quote_bias"]):
            target["quote_bias"][index] += float(value)
        for index, value in enumerate(source["take_candidate_weights"]):
            target["take_candidate_weights"][index] += float(value)
        target["take_candidate_bias"] += float(source["take_candidate_bias"])
        for index, value in enumerate(source["take_pass_weights"]):
            target["take_pass_weights"][index] += float(value)
        target["take_pass_bias"] += float(source["take_pass_bias"])
        for index, value in enumerate(source["reveal_weights"]):
            target["reveal_weights"][index] += float(value)
        target["reveal_bias"] += float(source["reveal_bias"])
        for index, value in enumerate(source["value_weights"]):
            target["value_weights"][index] += float(value)
        target["value_bias"] += float(source["value_bias"])

    def apply_gradients(self, gradients: Dict, lr: float) -> None:
        for row_index, row in enumerate(gradients["quote_weights"]):
            for feature_index, value in enumerate(row):
                self.quote_weights[row_index][feature_index] += lr * float(value)
        for index, value in enumerate(gradients["quote_bias"]):
            self.quote_bias[index] += lr * float(value)
        for index, value in enumerate(gradients["take_candidate_weights"]):
            self.take_candidate_weights[index] += lr * float(value)
        self.take_candidate_bias += lr * float(gradients["take_candidate_bias"])
        for index, value in enumerate(gradients["take_pass_weights"]):
            self.take_pass_weights[index] += lr * float(value)
        self.take_pass_bias += lr * float(gradients["take_pass_bias"])
        for index, value in enumerate(gradients["reveal_weights"]):
            self.reveal_weights[index] += lr * float(value)
        self.reveal_bias += lr * float(gradients["reveal_bias"])
        for index, value in enumerate(gradients["value_weights"]):
            self.value_weights[index] += lr * float(value)
        self.value_bias += lr * float(gradients["value_bias"])
        self.clip_parameters()

    def clip_parameters(self) -> None:
        limit = abs(float(self.parameter_clip))
        for row_index, row in enumerate(self.quote_weights):
            for feature_index, value in enumerate(row):
                self.quote_weights[row_index][feature_index] = max(-limit, min(limit, float(value)))
        for index, value in enumerate(self.quote_bias):
            self.quote_bias[index] = max(-limit, min(limit, float(value)))
        for index, value in enumerate(self.take_candidate_weights):
            self.take_candidate_weights[index] = max(-limit, min(limit, float(value)))
        self.take_candidate_bias = max(-limit, min(limit, float(self.take_candidate_bias)))
        for index, value in enumerate(self.take_pass_weights):
            self.take_pass_weights[index] = max(-limit, min(limit, float(value)))
        self.take_pass_bias = max(-limit, min(limit, float(self.take_pass_bias)))
        for index, value in enumerate(self.reveal_weights):
            self.reveal_weights[index] = max(-limit, min(limit, float(value)))
        self.reveal_bias = max(-limit, min(limit, float(self.reveal_bias)))
        for index, value in enumerate(self.value_weights):
            self.value_weights[index] = max(-limit, min(limit, float(value)))
        self.value_bias = max(-limit, min(limit, float(self.value_bias)))

    def accumulate_value_gradient(self, gradients: Dict, base_values: Sequence[float], target: float, scale: float = 1.0) -> None:
        prediction = self.value(base_values)
        error = (target - prediction) * float(scale)
        for index, value in enumerate(base_values):
            gradients["value_weights"][index] += error * float(value)
        gradients["value_bias"] += error

    def accumulate_quote_gradient(self, gradients: Dict, features: List[List[float]], probabilities: List[float], action_index: int, advantage: float) -> None:
        for row_index, (row, probability) in enumerate(zip(features, probabilities)):
            scale = ((1.0 if row_index == action_index else 0.0) - probability) * advantage
            for feature_index, feature_value in enumerate(row):
                gradients["quote_weights"][row_index][feature_index] += scale * float(feature_value)
            gradients["quote_bias"][row_index] += scale

    def accumulate_take_gradient(self, gradients: Dict, features: List[List[float]], probabilities: List[float], action_index: int, advantage: float) -> None:
        for row_index, probability in enumerate(probabilities):
            scale = ((1.0 if row_index == action_index else 0.0) - probability) * advantage
            weights = gradients["take_pass_weights"] if row_index == 0 else gradients["take_candidate_weights"]
            row = features[row_index]
            for feature_index, feature_value in enumerate(row):
                weights[feature_index] += scale * float(feature_value)
            if row_index == 0:
                gradients["take_pass_bias"] += scale
            else:
                gradients["take_candidate_bias"] += scale

    def accumulate_reveal_gradient(self, gradients: Dict, base_values: Sequence[float], probability: float, vote: bool, advantage: float) -> None:
        scale = ((1.0 if vote else 0.0) - probability) * advantage
        for index, value in enumerate(base_values):
            gradients["reveal_weights"][index] += scale * float(value)
        gradients["reveal_bias"] += scale

    def update_value(self, base_values: Sequence[float], target: float, lr: float) -> None:
        gradients = self.zero_gradients()
        self.accumulate_value_gradient(gradients, base_values, target)
        self.apply_gradients(gradients, lr)

    def update_quote_policy(self, features: List[List[float]], probabilities: List[float], action_index: int, advantage: float, lr: float) -> None:
        gradients = self.zero_gradients()
        self.accumulate_quote_gradient(gradients, features, probabilities, action_index, advantage)
        self.apply_gradients(gradients, lr)

    def update_take_policy(self, features: List[List[float]], probabilities: List[float], action_index: int, advantage: float, lr: float) -> None:
        gradients = self.zero_gradients()
        self.accumulate_take_gradient(gradients, features, probabilities, action_index, advantage)
        self.apply_gradients(gradients, lr)

    def update_reveal_policy(self, base_values: Sequence[float], probability: float, vote: bool, advantage: float, lr: float) -> None:
        gradients = self.zero_gradients()
        self.accumulate_reveal_gradient(gradients, base_values, probability, vote, advantage)
        self.apply_gradients(gradients, lr)

    def to_dict(self) -> Dict:
        return {
            "quoteTemplates": self.quote_templates,
            "featureNames": {
                "base": BASE_FEATURE_NAMES,
                "quote": QUOTE_FEATURE_NAMES,
                "take": TAKE_FEATURE_NAMES,
                "reveal": BASE_FEATURE_NAMES,
            },
            "quoteHead": {"weights": self.quote_weights, "bias": self.quote_bias},
            "takeHead": {
                "candidateWeights": self.take_candidate_weights,
                "candidateBias": self.take_candidate_bias,
                "passWeights": self.take_pass_weights,
                "passBias": self.take_pass_bias,
            },
            "revealHead": {"weights": self.reveal_weights, "bias": self.reveal_bias},
            "valueHead": {"weights": self.value_weights, "bias": self.value_bias},
            "parameterClip": self.parameter_clip,
        }

    @classmethod
    def from_dict(cls, data: Dict) -> "LinearCardPolicy":
        return cls(
            quote_templates=[dict(entry) for entry in data["quoteTemplates"]],
            quote_weights=[list(map(float, row)) for row in data["quoteHead"]["weights"]],
            quote_bias=list(map(float, data["quoteHead"]["bias"])),
            take_candidate_weights=list(map(float, data["takeHead"]["candidateWeights"])),
            take_candidate_bias=float(data["takeHead"]["candidateBias"]),
            take_pass_weights=list(map(float, data["takeHead"]["passWeights"])),
            take_pass_bias=float(data["takeHead"]["passBias"]),
            reveal_weights=list(map(float, data["revealHead"]["weights"])),
            reveal_bias=float(data["revealHead"]["bias"]),
            value_weights=list(map(float, data.get("valueHead", {}).get("weights", [0.0] * len(BASE_FEATURE_NAMES)))),
            value_bias=float(data.get("valueHead", {}).get("bias", 0.0)),
            parameter_clip=float(data.get("parameterClip", 25.0)),
        )

    def to_json(self) -> str:
        return json.dumps(self.to_dict())


def sample_index(probabilities: Sequence[float]) -> int:
    if not probabilities:
        return 0
    threshold = random.random()
    cumulative = 0.0
    for index, probability in enumerate(probabilities):
        cumulative += probability
        if threshold <= cumulative:
            return index
    return len(probabilities) - 1


def bootstrap_policy() -> LinearCardPolicy:
    return LinearCardPolicy(
        quote_weights=[list(row) for row in BOOTSTRAP_QUOTE_WEIGHTS],
        quote_bias=list(BOOTSTRAP_QUOTE_BIAS),
        take_candidate_weights=list(BOOTSTRAP_TAKE_CANDIDATE),
        take_pass_weights=list(BOOTSTRAP_TAKE_PASS),
        reveal_weights=list(BOOTSTRAP_REVEAL),
    )
