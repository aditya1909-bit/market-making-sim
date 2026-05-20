from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from typing import Dict, List, Sequence

from .features import BASE_FEATURE_NAMES, QUOTE_FEATURE_NAMES, TAKE_FEATURE_NAMES, base_feature_vector, quote_features, take_features
from .heuristic import hybrid_as_quote_from_params, quote_from_template
from .rules import MAX_QUOTE_SIZE, QUOTE_TEMPLATES

MODEL_COMPATIBILITY_VERSION = 2
INTENT_LABELS = ["take", "quote", "reveal", "wait"]
QUOTE_EXTRA_FEATURE_COUNT = len(QUOTE_FEATURE_NAMES) - len(BASE_FEATURE_NAMES)
TAKE_EXTRA_FEATURE_COUNT = len(TAKE_FEATURE_NAMES) - len(BASE_FEATURE_NAMES)


def build_hybrid_as_params(templates: Sequence[Dict] | None = None) -> List[Dict]:
    params = []
    for template in templates or QUOTE_TEMPLATES:
        if template.get("noop"):
            params.append({"id": "noop", "noop": True})
            continue
        offset = float(template.get("reservationOffset", 0.0))
        spread = float(template.get("spreadScale", 1.0))
        size = int(template.get("size", 1))
        params.append(
            {
                "id": template.get("id", "hybrid"),
                "risk_aversion": max(0.0, min(1.0, 0.28 + abs(offset) * 1.6 + (spread - 0.75) * 0.22)),
                "inventory_skew": max(0.25, min(1.35, 0.55 + abs(offset) * 1.4)),
                "spread_multiplier": max(0.7, min(2.2, spread)),
                "quote_mode": "bid" if offset < -0.005 else "ask" if offset > 0.005 else "balanced",
                "take_threshold": max(0.006, 0.012 + abs(offset) * 0.04 + max(0.0, spread - 1.0) * 0.01),
                "reveal_threshold": max(0.08, min(0.32, 0.2 - (spread - 1.0) * 0.04)),
                "private_skew_scale": max(0.0, min(0.65, 0.25 + abs(offset) * 1.1)),
                "size": size,
            }
        )
    return params


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


def tanh(value: float) -> float:
    return math.tanh(value)


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


def _intent_index_for_decision(decision_type: str) -> int:
    if decision_type == "taker_action":
        return 0
    if decision_type == "submit_quote":
        return 1
    if decision_type == "request_next_reveal":
        return 2
    return 3


def _ensure_matrix(rows: int, cols: int, payload: Sequence[Sequence[float]] | None = None) -> List[List[float]]:
    if not payload:
        return [[0.0] * cols for _ in range(rows)]
    out = [[0.0] * cols for _ in range(rows)]
    for row_index in range(min(rows, len(payload))):
        for col_index in range(min(cols, len(payload[row_index]))):
            out[row_index][col_index] = float(payload[row_index][col_index])
    return out


def _ensure_vector(size: int, payload: Sequence[float] | None = None) -> List[float]:
    out = [0.0] * size
    if not payload:
        return out
    for index in range(min(size, len(payload))):
        out[index] = float(payload[index])
    return out


def _clone_gradient_value(value):
    if isinstance(value, list):
        return [_clone_gradient_value(item) for item in value]
    return float(value)


def _decision_from_components(intent_label: str, take: Dict, quote: Dict, reveal: Dict) -> tuple[str, Dict]:
    if intent_label == "take" and take["payload"]["action"] != "pass":
        return "taker_action", take["payload"]
    if intent_label == "quote" and quote["payload"] is not None:
        return "submit_quote", quote["payload"]
    if intent_label == "reveal" and reveal["vote"]:
        return "request_next_reveal", {}
    if intent_label == "wait":
        return "wait", {}

    if take["payload"]["action"] != "pass":
        return "taker_action", take["payload"]
    if quote["payload"] is not None:
        return "submit_quote", quote["payload"]
    if reveal["vote"]:
        return "request_next_reveal", {}
    return "wait", {}


def _take_edge_from_choice(take: Dict) -> float:
    action_index = int(take.get("action_index", 0))
    if action_index <= 0:
        return 0.0
    entry = take["entries"][action_index - 1]
    base = take["base"]
    buy_edge = (base["stats"]["mean"] - float(entry["quote"]["ask"])) / base["stats"]["width"]
    sell_edge = (float(entry["quote"]["bid"]) - base["stats"]["mean"]) / base["stats"]["width"]
    return max(float(buy_edge), float(sell_edge))


def _strongest_take_payload(base: Dict) -> Dict | None:
    best = None
    for entry in base["quotes"]:
        buy_edge = (base["stats"]["mean"] - float(entry["quote"]["ask"])) / base["stats"]["width"]
        sell_edge = (float(entry["quote"]["bid"]) - base["stats"]["mean"]) / base["stats"]["width"]
        edge = max(float(buy_edge), float(sell_edge))
        action = "buy" if buy_edge >= sell_edge else "sell"
        if best is None or edge > best["edge"]:
            best = {
                "edge": edge,
                "payload": {
                    "targetPlayerId": entry["target_player_id"],
                    "action": action,
                },
            }
    return best


def _take_edge_thresholds(model_type: str, base: Dict) -> tuple[float, float]:
    stdev = float(base["values"][1])
    seat_ratio = float(base["values"][4])
    reveal_progress = float(base["values"][3])
    best_quote_age = float(base["values"][22])
    neural_padding = 0.004 if model_type != "linear" else 0.0
    take_floor = max(0.006, 0.009 + seat_ratio * 0.004 + stdev * 0.014 - best_quote_age * 0.014 + neural_padding)
    strong_take_floor = max(
        0.012,
        0.018 + seat_ratio * 0.009 + stdev * 0.028 - reveal_progress * 0.012 - best_quote_age * 0.016 + neural_padding,
    )
    return take_floor, strong_take_floor


def _stabilize_action_decision(model_type: str, base: Dict, intent_label: str, take: Dict, quote: Dict, reveal: Dict) -> tuple[str, Dict]:
    best_take_edge = max(float(base["values"][6]), float(base["values"][7]))
    selected_take_edge = _take_edge_from_choice(take)
    live_quote_count = float(base["values"][5])
    stdev = float(base["values"][1])
    has_own_quote = bool(base["own_quote"])
    reveal_progress = float(base["values"][3])
    take_floor, strong_take_floor = _take_edge_thresholds(model_type, base)
    quote_floor_when_idle = 0.28 if model_type == "linear" else 0.34
    strongest_take = _strongest_take_payload(base)

    if strongest_take and strongest_take["edge"] >= strong_take_floor:
        return "taker_action", strongest_take["payload"]

    if intent_label == "take" and (take["payload"]["action"] == "pass" or selected_take_edge < take_floor):
        intent_label = "quote" if not has_own_quote or live_quote_count <= quote_floor_when_idle else "wait"

    if intent_label == "reveal":
        reveal_ready = reveal["vote"] and (
            stdev <= 0.08 or (reveal_progress >= 0.75 and best_take_edge < 0.02) or (live_quote_count <= 0.01 and not has_own_quote)
        )
        if not reveal_ready:
            intent_label = "quote" if not has_own_quote else "wait"

    if intent_label == "wait" and not has_own_quote and live_quote_count <= quote_floor_when_idle and best_take_edge < take_floor:
        intent_label = "quote"

    if strongest_take and intent_label in {"wait", "quote"} and strongest_take["edge"] >= take_floor:
        return "taker_action", strongest_take["payload"]

    return _decision_from_components(intent_label, take, quote, reveal)


@dataclass
class LinearCardPolicy:
    quote_templates: List[Dict] = field(default_factory=lambda: [dict(entry) for entry in QUOTE_TEMPLATES])
    intent_weights: List[List[float]] = field(default_factory=list)
    intent_bias: List[float] = field(default_factory=list)
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
    hybrid_as_params: List[Dict] = field(default_factory=list)
    parameter_clip: float = 25.0
    model_type: str = "linear"

    def __post_init__(self) -> None:
        self.intent_weights = _ensure_matrix(len(INTENT_LABELS), len(BASE_FEATURE_NAMES), self.intent_weights)
        self.intent_bias = _ensure_vector(len(INTENT_LABELS), self.intent_bias)
        self.quote_weights = _ensure_matrix(len(self.quote_templates), len(QUOTE_FEATURE_NAMES), self.quote_weights)
        self.quote_bias = _ensure_vector(len(self.quote_templates), self.quote_bias)
        self.take_candidate_weights = _ensure_vector(len(TAKE_FEATURE_NAMES), self.take_candidate_weights)
        self.take_pass_weights = _ensure_vector(len(BASE_FEATURE_NAMES), self.take_pass_weights)
        self.reveal_weights = _ensure_vector(len(BASE_FEATURE_NAMES), self.reveal_weights)
        self.value_weights = _ensure_vector(len(BASE_FEATURE_NAMES), self.value_weights)
        if not self.hybrid_as_params or len(self.hybrid_as_params) != len(self.quote_templates):
            self.hybrid_as_params = build_hybrid_as_params(self.quote_templates)

    def copy(self) -> "LinearCardPolicy":
        return LinearCardPolicy.from_dict(self.to_dict())

    def value(self, base_values: Sequence[float]) -> float:
        return dot(self.value_weights, base_values) + self.value_bias

    def choose_intent(self, state: Dict, player_id: str, now_step: int = 0, base: Dict | None = None) -> Dict:
        resolved_base = base or base_feature_vector(state, player_id, now_step)
        logits = [dot(weights, resolved_base["values"]) + bias for weights, bias in zip(self.intent_weights, self.intent_bias)]
        probabilities = softmax(logits)
        action_index = sample_index(probabilities)
        return {
            "type": INTENT_LABELS[action_index],
            "action_index": action_index,
            "probabilities": probabilities,
            "features": list(resolved_base["values"]),
            "base": resolved_base,
        }

    def choose_quote(self, state: Dict, player_id: str, now_step: int = 0, base: Dict | None = None) -> Dict:
        resolved_base = base or base_feature_vector(state, player_id, now_step)
        logits = []
        feature_rows = []
        for template, weights, bias in zip(self.quote_templates, self.quote_weights, self.quote_bias):
            features = quote_features(resolved_base, template)
            feature_rows.append(features)
            logits.append(dot(weights, features) + bias)
        probabilities = softmax(logits)
        action_index = sample_index(probabilities)
        template = self.quote_templates[action_index]
        params = self.hybrid_as_params[action_index] if self.model_type == "linear_hybrid_as" else None
        return {
            "type": "submit_quote",
            "template_index": action_index,
            "template": template,
            "hybridAsParams": params,
            "payload": hybrid_as_quote_from_params(state, player_id, params, now_step) if params else quote_from_template(state, player_id, template, now_step),
            "probabilities": probabilities,
            "features": feature_rows,
            "base": resolved_base,
        }

    def choose_take(self, state: Dict, player_id: str, now_step: int = 0, base: Dict | None = None) -> Dict:
        resolved_base = base or base_feature_vector(state, player_id, now_step)
        feature_rows = [resolved_base["values"]]
        logits = [dot(self.take_pass_weights, resolved_base["values"]) + self.take_pass_bias]
        entries = resolved_base["quotes"]
        for entry in entries:
            features = take_features(resolved_base, entry)
            feature_rows.append(features)
            logits.append(dot(self.take_candidate_weights, features) + self.take_candidate_bias)
        probabilities = softmax(logits)
        action_index = sample_index(probabilities)
        if action_index == 0:
            payload = {"action": "pass", "targetPlayerId": None}
        else:
            entry = entries[action_index - 1]
            buy_edge = (resolved_base["stats"]["mean"] - float(entry["quote"]["ask"])) / resolved_base["stats"]["width"]
            sell_edge = (float(entry["quote"]["bid"]) - resolved_base["stats"]["mean"]) / resolved_base["stats"]["width"]
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
            "base": resolved_base,
            "action_index": action_index,
        }

    def choose_reveal(self, state: Dict, player_id: str, now_step: int = 0, base: Dict | None = None) -> Dict:
        resolved_base = base or base_feature_vector(state, player_id, now_step)
        probability = sigmoid(dot(self.reveal_weights, resolved_base["values"]) + self.reveal_bias)
        vote = random.random() < probability
        return {
            "type": "request_next_reveal" if vote else "wait",
            "vote": vote,
            "probability": probability,
            "base": resolved_base,
        }

    def choose_action(self, state: Dict, player_id: str, now_step: int = 0) -> Dict:
        base = base_feature_vector(state, player_id, now_step)
        intent = self.choose_intent(state, player_id, now_step, base)
        take = self.choose_take(state, player_id, now_step, base)
        quote = self.choose_quote(state, player_id, now_step, base)
        reveal = self.choose_reveal(state, player_id, now_step, base)
        intent_label = INTENT_LABELS[int(intent["action_index"])]
        locked_role = (state.get("role_constraints") or {}).get(player_id)
        strongest_take = _strongest_take_payload(base)
        take_floor, strong_take_floor = _take_edge_thresholds(self.model_type, base)
        role_take_floor = -0.005 if self.model_type == "linear_hybrid_as" else take_floor
        if locked_role == "taker" and strongest_take and strongest_take["edge"] >= role_take_floor:
            action_type, payload = "taker_action", strongest_take["payload"]
        elif locked_role == "maker" and quote["payload"] is not None:
            action_type, payload = "submit_quote", quote["payload"]
        else:
            action_type, payload = _stabilize_action_decision(self.model_type, base, intent_label, take, quote, reveal)
        return {
            "type": action_type,
            "payload": payload,
            "base": base,
            "intent": intent,
            "quote": quote,
            "take": take,
            "reveal": reveal,
        }

    def zero_gradients(self) -> Dict:
        return {
            "intent_weights": [[0.0] * len(BASE_FEATURE_NAMES) for _ in INTENT_LABELS],
            "intent_bias": [0.0 for _ in INTENT_LABELS],
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
        for key in target:
            if isinstance(target[key], list):
                if target[key] and isinstance(target[key][0], list):
                    for row_index, row in enumerate(source[key]):
                        for feature_index, value in enumerate(row):
                            target[key][row_index][feature_index] += float(value)
                else:
                    for index, value in enumerate(source[key]):
                        target[key][index] += float(value)
            else:
                target[key] += float(source[key])

    def apply_gradients(self, gradients: Dict, lr: float) -> None:
        for row_index, row in enumerate(gradients["intent_weights"]):
            for feature_index, value in enumerate(row):
                self.intent_weights[row_index][feature_index] += lr * float(value)
        for index, value in enumerate(gradients["intent_bias"]):
            self.intent_bias[index] += lr * float(value)
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
        for key in ("intent_weights", "quote_weights"):
            matrix = getattr(self, key)
            for row_index, row in enumerate(matrix):
                for feature_index, value in enumerate(row):
                    matrix[row_index][feature_index] = max(-limit, min(limit, float(value)))
        for key in ("intent_bias", "quote_bias", "take_candidate_weights", "take_pass_weights", "reveal_weights", "value_weights"):
            vector = getattr(self, key)
            for index, value in enumerate(vector):
                vector[index] = max(-limit, min(limit, float(value)))
        self.take_candidate_bias = max(-limit, min(limit, float(self.take_candidate_bias)))
        self.take_pass_bias = max(-limit, min(limit, float(self.take_pass_bias)))
        self.reveal_bias = max(-limit, min(limit, float(self.reveal_bias)))
        self.value_bias = max(-limit, min(limit, float(self.value_bias)))

    def accumulate_intent_gradient(self, gradients: Dict, features: Sequence[float], probabilities: List[float], action_index: int, advantage: float) -> None:
        for row_index, probability in enumerate(probabilities):
            scale = ((1.0 if row_index == action_index else 0.0) - probability) * advantage
            for feature_index, feature_value in enumerate(features):
                gradients["intent_weights"][row_index][feature_index] += scale * float(feature_value)
            gradients["intent_bias"][row_index] += scale

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

    def accumulate_value_gradient(self, gradients: Dict, base_values: Sequence[float], target: float, scale: float = 1.0) -> None:
        prediction = self.value(base_values)
        error = (target - prediction) * float(scale)
        for index, value in enumerate(base_values):
            gradients["value_weights"][index] += error * float(value)
        gradients["value_bias"] += error

    def update_intent_policy(self, features: Sequence[float], probabilities: List[float], action_index: int, advantage: float, lr: float) -> None:
        gradients = self.zero_gradients()
        self.accumulate_intent_gradient(gradients, features, probabilities, action_index, advantage)
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

    def update_value(self, base_values: Sequence[float], target: float, lr: float) -> None:
        gradients = self.zero_gradients()
        self.accumulate_value_gradient(gradients, base_values, target)
        self.apply_gradients(gradients, lr)

    def to_dict(self) -> Dict:
        return {
            "modelType": self.model_type,
            "compatibilityVersion": MODEL_COMPATIBILITY_VERSION,
            "quoteTemplates": self.quote_templates,
            "hybridAsParams": self.hybrid_as_params if self.model_type == "linear_hybrid_as" else [],
            "featureNames": {
                "base": BASE_FEATURE_NAMES,
                "quote": QUOTE_FEATURE_NAMES,
                "take": TAKE_FEATURE_NAMES,
                "reveal": BASE_FEATURE_NAMES,
                "intent": BASE_FEATURE_NAMES,
            },
            "intentHead": {"weights": self.intent_weights, "bias": self.intent_bias, "labels": INTENT_LABELS},
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
            quote_templates=[dict(entry) for entry in data.get("quoteTemplates", QUOTE_TEMPLATES)],
            intent_weights=[list(map(float, row)) for row in data.get("intentHead", {}).get("weights", [])],
            intent_bias=list(map(float, data.get("intentHead", {}).get("bias", []))),
            quote_weights=[list(map(float, row)) for row in data.get("quoteHead", {}).get("weights", [])],
            quote_bias=list(map(float, data.get("quoteHead", {}).get("bias", []))),
            take_candidate_weights=list(map(float, data.get("takeHead", {}).get("candidateWeights", []))),
            take_candidate_bias=float(data.get("takeHead", {}).get("candidateBias", -0.18)),
            take_pass_weights=list(map(float, data.get("takeHead", {}).get("passWeights", []))),
            take_pass_bias=float(data.get("takeHead", {}).get("passBias", 0.12)),
            reveal_weights=list(map(float, data.get("revealHead", {}).get("weights", []))),
            reveal_bias=float(data.get("revealHead", {}).get("bias", -0.65)),
            value_weights=list(map(float, data.get("valueHead", {}).get("weights", []))),
            value_bias=float(data.get("valueHead", {}).get("bias", 0.0)),
            hybrid_as_params=[dict(entry) for entry in data.get("hybridAsParams", [])],
            parameter_clip=float(data.get("parameterClip", 25.0)),
            model_type=str(data.get("modelType", "linear")),
        )

    def to_json(self) -> str:
        return json.dumps(self.to_dict())


@dataclass
class NeuralCardPolicy:
    quote_templates: List[Dict] = field(default_factory=lambda: [dict(entry) for entry in QUOTE_TEMPLATES])
    hidden_size: int = len(BASE_FEATURE_NAMES)
    trunk_weights: List[List[float]] = field(default_factory=list)
    trunk_bias: List[float] = field(default_factory=list)
    intent_weights: List[List[float]] = field(default_factory=list)
    intent_bias: List[float] = field(default_factory=list)
    quote_state_weights: List[List[float]] = field(default_factory=list)
    quote_template_weights: List[List[float]] = field(default_factory=list)
    quote_bias: List[float] = field(default_factory=list)
    take_candidate_state_weights: List[float] = field(default_factory=list)
    take_candidate_extra_weights: List[float] = field(default_factory=list)
    take_candidate_bias: float = -0.12
    take_pass_weights: List[float] = field(default_factory=list)
    take_pass_bias: float = 0.06
    reveal_weights: List[float] = field(default_factory=list)
    reveal_bias: float = -0.55
    value_weights: List[float] = field(default_factory=list)
    value_bias: float = 0.0
    parameter_clip: float = 18.0
    model_type: str = "neural_mlp"

    def __post_init__(self) -> None:
        self.hidden_size = max(4, int(self.hidden_size))
        self.trunk_weights = _ensure_matrix(self.hidden_size, len(BASE_FEATURE_NAMES), self.trunk_weights)
        self.trunk_bias = _ensure_vector(self.hidden_size, self.trunk_bias)
        self.intent_weights = _ensure_matrix(len(INTENT_LABELS), self.hidden_size, self.intent_weights)
        self.intent_bias = _ensure_vector(len(INTENT_LABELS), self.intent_bias)
        self.quote_state_weights = _ensure_matrix(len(self.quote_templates), self.hidden_size, self.quote_state_weights)
        self.quote_template_weights = _ensure_matrix(len(self.quote_templates), QUOTE_EXTRA_FEATURE_COUNT, self.quote_template_weights)
        self.quote_bias = _ensure_vector(len(self.quote_templates), self.quote_bias)
        self.take_candidate_state_weights = _ensure_vector(self.hidden_size, self.take_candidate_state_weights)
        self.take_candidate_extra_weights = _ensure_vector(TAKE_EXTRA_FEATURE_COUNT, self.take_candidate_extra_weights)
        self.take_pass_weights = _ensure_vector(self.hidden_size, self.take_pass_weights)
        self.reveal_weights = _ensure_vector(self.hidden_size, self.reveal_weights)
        self.value_weights = _ensure_vector(self.hidden_size, self.value_weights)

    def copy(self) -> "NeuralCardPolicy":
        return NeuralCardPolicy.from_dict(self.to_dict())

    def _encode(self, base_values: Sequence[float]) -> Dict:
        preactivations = []
        hidden = []
        for weights, bias in zip(self.trunk_weights, self.trunk_bias):
            preactivation = dot(weights, base_values) + bias
            preactivations.append(preactivation)
            hidden.append(tanh(preactivation))
        return {"base_values": list(base_values), "preactivations": preactivations, "hidden": hidden}

    def value(self, base_values: Sequence[float]) -> float:
        encoded = self._encode(base_values)
        return dot(self.value_weights, encoded["hidden"]) + self.value_bias

    def choose_intent(self, state: Dict, player_id: str, now_step: int = 0, base: Dict | None = None, encoded: Dict | None = None) -> Dict:
        resolved_base = base or base_feature_vector(state, player_id, now_step)
        resolved_encoded = encoded or self._encode(resolved_base["values"])
        logits = [dot(weights, resolved_encoded["hidden"]) + bias for weights, bias in zip(self.intent_weights, self.intent_bias)]
        probabilities = softmax(logits)
        action_index = sample_index(probabilities)
        return {
            "type": INTENT_LABELS[action_index],
            "action_index": action_index,
            "probabilities": probabilities,
            "features": resolved_encoded,
            "base": resolved_base,
        }

    def choose_quote(self, state: Dict, player_id: str, now_step: int = 0, base: Dict | None = None, encoded: Dict | None = None) -> Dict:
        resolved_base = base or base_feature_vector(state, player_id, now_step)
        resolved_encoded = encoded or self._encode(resolved_base["values"])
        logits = []
        template_extras = []
        for index, template in enumerate(self.quote_templates):
            full_features = quote_features(resolved_base, template)
            extras = list(full_features[len(BASE_FEATURE_NAMES) :])
            template_extras.append(extras)
            logits.append(
                dot(self.quote_state_weights[index], resolved_encoded["hidden"])
                + dot(self.quote_template_weights[index], extras)
                + self.quote_bias[index]
            )
        probabilities = softmax(logits)
        action_index = sample_index(probabilities)
        template = self.quote_templates[action_index]
        return {
            "type": "submit_quote",
            "template_index": action_index,
            "template": template,
            "payload": quote_from_template(state, player_id, template, now_step),
            "probabilities": probabilities,
            "features": {
                **resolved_encoded,
                "template_extras": template_extras,
            },
            "base": resolved_base,
        }

    def choose_take(self, state: Dict, player_id: str, now_step: int = 0, base: Dict | None = None, encoded: Dict | None = None) -> Dict:
        resolved_base = base or base_feature_vector(state, player_id, now_step)
        resolved_encoded = encoded or self._encode(resolved_base["values"])
        extras_rows: List[List[float]] = []
        entries = resolved_base["quotes"]
        logits = [dot(self.take_pass_weights, resolved_encoded["hidden"]) + self.take_pass_bias]
        for entry in entries:
            full_features = take_features(resolved_base, entry)
            extras = list(full_features[len(BASE_FEATURE_NAMES) :])
            extras_rows.append(extras)
            logits.append(
                dot(self.take_candidate_state_weights, resolved_encoded["hidden"])
                + dot(self.take_candidate_extra_weights, extras)
                + self.take_candidate_bias
            )
        probabilities = softmax(logits)
        action_index = sample_index(probabilities)
        if action_index == 0:
            payload = {"action": "pass", "targetPlayerId": None}
        else:
            entry = entries[action_index - 1]
            buy_edge = (resolved_base["stats"]["mean"] - float(entry["quote"]["ask"])) / resolved_base["stats"]["width"]
            sell_edge = (float(entry["quote"]["bid"]) - resolved_base["stats"]["mean"]) / resolved_base["stats"]["width"]
            payload = {
                "action": "buy" if buy_edge >= sell_edge else "sell",
                "targetPlayerId": entry["target_player_id"],
            }
        return {
            "type": "taker_action",
            "payload": payload,
            "probabilities": probabilities,
            "features": {
                **resolved_encoded,
                "candidate_extras": extras_rows,
            },
            "entries": entries,
            "base": resolved_base,
            "action_index": action_index,
        }

    def choose_reveal(self, state: Dict, player_id: str, now_step: int = 0, base: Dict | None = None, encoded: Dict | None = None) -> Dict:
        resolved_base = base or base_feature_vector(state, player_id, now_step)
        resolved_encoded = encoded or self._encode(resolved_base["values"])
        probability = sigmoid(dot(self.reveal_weights, resolved_encoded["hidden"]) + self.reveal_bias)
        vote = random.random() < probability
        return {
            "type": "request_next_reveal" if vote else "wait",
            "vote": vote,
            "probability": probability,
            "base": resolved_base,
            "features": resolved_encoded,
        }

    def choose_action(self, state: Dict, player_id: str, now_step: int = 0) -> Dict:
        base = base_feature_vector(state, player_id, now_step)
        encoded = self._encode(base["values"])
        intent = self.choose_intent(state, player_id, now_step, base, encoded)
        take = self.choose_take(state, player_id, now_step, base, encoded)
        quote = self.choose_quote(state, player_id, now_step, base, encoded)
        reveal = self.choose_reveal(state, player_id, now_step, base, encoded)
        intent_label = INTENT_LABELS[int(intent["action_index"])]
        action_type, payload = _stabilize_action_decision(self.model_type, base, intent_label, take, quote, reveal)
        return {
            "type": action_type,
            "payload": payload,
            "base": base,
            "intent": intent,
            "quote": quote,
            "take": take,
            "reveal": reveal,
        }

    def zero_gradients(self) -> Dict:
        return {
            "trunk_weights": [[0.0] * len(BASE_FEATURE_NAMES) for _ in range(self.hidden_size)],
            "trunk_bias": [0.0] * self.hidden_size,
            "intent_weights": [[0.0] * self.hidden_size for _ in INTENT_LABELS],
            "intent_bias": [0.0 for _ in INTENT_LABELS],
            "quote_state_weights": [[0.0] * self.hidden_size for _ in self.quote_templates],
            "quote_template_weights": [[0.0] * QUOTE_EXTRA_FEATURE_COUNT for _ in self.quote_templates],
            "quote_bias": [0.0 for _ in self.quote_templates],
            "take_candidate_state_weights": [0.0] * self.hidden_size,
            "take_candidate_extra_weights": [0.0] * TAKE_EXTRA_FEATURE_COUNT,
            "take_candidate_bias": 0.0,
            "take_pass_weights": [0.0] * self.hidden_size,
            "take_pass_bias": 0.0,
            "reveal_weights": [0.0] * self.hidden_size,
            "reveal_bias": 0.0,
            "value_weights": [0.0] * self.hidden_size,
            "value_bias": 0.0,
        }

    def merge_gradients(self, target: Dict, source: Dict) -> None:
        for key in target:
            if isinstance(target[key], list):
                if target[key] and isinstance(target[key][0], list):
                    for row_index, row in enumerate(source[key]):
                        for feature_index, value in enumerate(row):
                            target[key][row_index][feature_index] += float(value)
                else:
                    for index, value in enumerate(source[key]):
                        target[key][index] += float(value)
            else:
                target[key] += float(source[key])

    def apply_gradients(self, gradients: Dict, lr: float) -> None:
        for key in ("trunk_weights", "intent_weights", "quote_state_weights", "quote_template_weights"):
            matrix = getattr(self, key)
            for row_index, row in enumerate(gradients[key]):
                for feature_index, value in enumerate(row):
                    matrix[row_index][feature_index] += lr * float(value)
        for key in ("trunk_bias", "intent_bias", "quote_bias", "take_candidate_state_weights", "take_candidate_extra_weights", "take_pass_weights", "reveal_weights", "value_weights"):
            vector = getattr(self, key)
            for index, value in enumerate(gradients[key]):
                vector[index] += lr * float(value)
        self.take_candidate_bias += lr * float(gradients["take_candidate_bias"])
        self.take_pass_bias += lr * float(gradients["take_pass_bias"])
        self.reveal_bias += lr * float(gradients["reveal_bias"])
        self.value_bias += lr * float(gradients["value_bias"])
        self.clip_parameters()

    def clip_parameters(self) -> None:
        limit = abs(float(self.parameter_clip))
        for key in ("trunk_weights", "intent_weights", "quote_state_weights", "quote_template_weights"):
            matrix = getattr(self, key)
            for row_index, row in enumerate(matrix):
                for feature_index, value in enumerate(row):
                    matrix[row_index][feature_index] = max(-limit, min(limit, float(value)))
        for key in ("trunk_bias", "intent_bias", "quote_bias", "take_candidate_state_weights", "take_candidate_extra_weights", "take_pass_weights", "reveal_weights", "value_weights"):
            vector = getattr(self, key)
            for index, value in enumerate(vector):
                vector[index] = max(-limit, min(limit, float(value)))
        self.take_candidate_bias = max(-limit, min(limit, float(self.take_candidate_bias)))
        self.take_pass_bias = max(-limit, min(limit, float(self.take_pass_bias)))
        self.reveal_bias = max(-limit, min(limit, float(self.reveal_bias)))
        self.value_bias = max(-limit, min(limit, float(self.value_bias)))

    def _backprop_hidden(self, gradients: Dict, features: Dict, hidden_gradient: Sequence[float]) -> None:
        for hidden_index, upstream in enumerate(hidden_gradient):
            hidden_value = float(features["hidden"][hidden_index])
            delta = float(upstream) * (1.0 - hidden_value * hidden_value)
            gradients["trunk_bias"][hidden_index] += delta
            for feature_index, base_value in enumerate(features["base_values"]):
                gradients["trunk_weights"][hidden_index][feature_index] += delta * float(base_value)

    def accumulate_intent_gradient(self, gradients: Dict, features: Dict, probabilities: List[float], action_index: int, advantage: float) -> None:
        hidden_gradient = [0.0] * self.hidden_size
        for row_index, probability in enumerate(probabilities):
            scale = ((1.0 if row_index == action_index else 0.0) - probability) * advantage
            for hidden_index, hidden_value in enumerate(features["hidden"]):
                gradients["intent_weights"][row_index][hidden_index] += scale * float(hidden_value)
                hidden_gradient[hidden_index] += scale * float(self.intent_weights[row_index][hidden_index])
            gradients["intent_bias"][row_index] += scale
        self._backprop_hidden(gradients, features, hidden_gradient)

    def accumulate_quote_gradient(self, gradients: Dict, features: Dict, probabilities: List[float], action_index: int, advantage: float) -> None:
        hidden_gradient = [0.0] * self.hidden_size
        for row_index, probability in enumerate(probabilities):
            scale = ((1.0 if row_index == action_index else 0.0) - probability) * advantage
            for hidden_index, hidden_value in enumerate(features["hidden"]):
                gradients["quote_state_weights"][row_index][hidden_index] += scale * float(hidden_value)
                hidden_gradient[hidden_index] += scale * float(self.quote_state_weights[row_index][hidden_index])
            for feature_index, extra_value in enumerate(features["template_extras"][row_index]):
                gradients["quote_template_weights"][row_index][feature_index] += scale * float(extra_value)
            gradients["quote_bias"][row_index] += scale
        self._backprop_hidden(gradients, features, hidden_gradient)

    def accumulate_take_gradient(self, gradients: Dict, features: Dict, probabilities: List[float], action_index: int, advantage: float) -> None:
        hidden_gradient = [0.0] * self.hidden_size
        for row_index, probability in enumerate(probabilities):
            scale = ((1.0 if row_index == action_index else 0.0) - probability) * advantage
            if row_index == 0:
                for hidden_index, hidden_value in enumerate(features["hidden"]):
                    gradients["take_pass_weights"][hidden_index] += scale * float(hidden_value)
                    hidden_gradient[hidden_index] += scale * float(self.take_pass_weights[hidden_index])
                gradients["take_pass_bias"] += scale
                continue
            for hidden_index, hidden_value in enumerate(features["hidden"]):
                gradients["take_candidate_state_weights"][hidden_index] += scale * float(hidden_value)
                hidden_gradient[hidden_index] += scale * float(self.take_candidate_state_weights[hidden_index])
            extras = features["candidate_extras"][row_index - 1]
            for feature_index, extra_value in enumerate(extras):
                gradients["take_candidate_extra_weights"][feature_index] += scale * float(extra_value)
            gradients["take_candidate_bias"] += scale
        self._backprop_hidden(gradients, features, hidden_gradient)

    def accumulate_reveal_gradient(self, gradients: Dict, features: Dict, probability: float, vote: bool, advantage: float) -> None:
        scale = ((1.0 if vote else 0.0) - probability) * advantage
        hidden_gradient = [0.0] * self.hidden_size
        for hidden_index, hidden_value in enumerate(features["hidden"]):
            gradients["reveal_weights"][hidden_index] += scale * float(hidden_value)
            hidden_gradient[hidden_index] += scale * float(self.reveal_weights[hidden_index])
        gradients["reveal_bias"] += scale
        self._backprop_hidden(gradients, features, hidden_gradient)

    def accumulate_value_gradient(self, gradients: Dict, base_values: Sequence[float], target: float, scale: float = 1.0) -> None:
        features = self._encode(base_values)
        prediction = dot(self.value_weights, features["hidden"]) + self.value_bias
        error = (target - prediction) * float(scale)
        hidden_gradient = [0.0] * self.hidden_size
        for hidden_index, hidden_value in enumerate(features["hidden"]):
            gradients["value_weights"][hidden_index] += error * float(hidden_value)
            hidden_gradient[hidden_index] += error * float(self.value_weights[hidden_index])
        gradients["value_bias"] += error
        self._backprop_hidden(gradients, features, hidden_gradient)

    def update_intent_policy(self, features: Dict, probabilities: List[float], action_index: int, advantage: float, lr: float) -> None:
        gradients = self.zero_gradients()
        self.accumulate_intent_gradient(gradients, features, probabilities, action_index, advantage)
        self.apply_gradients(gradients, lr)

    def update_quote_policy(self, features: Dict, probabilities: List[float], action_index: int, advantage: float, lr: float) -> None:
        gradients = self.zero_gradients()
        self.accumulate_quote_gradient(gradients, features, probabilities, action_index, advantage)
        self.apply_gradients(gradients, lr)

    def update_take_policy(self, features: Dict, probabilities: List[float], action_index: int, advantage: float, lr: float) -> None:
        gradients = self.zero_gradients()
        self.accumulate_take_gradient(gradients, features, probabilities, action_index, advantage)
        self.apply_gradients(gradients, lr)

    def update_reveal_policy(self, features: Dict, probability: float, vote: bool, advantage: float, lr: float) -> None:
        gradients = self.zero_gradients()
        self.accumulate_reveal_gradient(gradients, features, probability, vote, advantage)
        self.apply_gradients(gradients, lr)

    def update_value(self, base_values: Sequence[float], target: float, lr: float) -> None:
        gradients = self.zero_gradients()
        self.accumulate_value_gradient(gradients, base_values, target)
        self.apply_gradients(gradients, lr)

    def to_dict(self) -> Dict:
        return {
            "modelType": self.model_type,
            "compatibilityVersion": MODEL_COMPATIBILITY_VERSION,
            "quoteTemplates": self.quote_templates,
            "hiddenSize": self.hidden_size,
            "featureNames": {
                "base": BASE_FEATURE_NAMES,
                "quote": QUOTE_FEATURE_NAMES,
                "take": TAKE_FEATURE_NAMES,
                "reveal": BASE_FEATURE_NAMES,
                "intent": BASE_FEATURE_NAMES,
            },
            "trunk": {"weights": self.trunk_weights, "bias": self.trunk_bias, "activation": "tanh"},
            "intentHead": {"weights": self.intent_weights, "bias": self.intent_bias, "labels": INTENT_LABELS},
            "quoteHead": {
                "stateWeights": self.quote_state_weights,
                "templateWeights": self.quote_template_weights,
                "bias": self.quote_bias,
            },
            "takeHead": {
                "candidateStateWeights": self.take_candidate_state_weights,
                "candidateExtraWeights": self.take_candidate_extra_weights,
                "candidateBias": self.take_candidate_bias,
                "passWeights": self.take_pass_weights,
                "passBias": self.take_pass_bias,
            },
            "revealHead": {"weights": self.reveal_weights, "bias": self.reveal_bias},
            "valueHead": {"weights": self.value_weights, "bias": self.value_bias},
            "parameterClip": self.parameter_clip,
        }

    @classmethod
    def from_dict(cls, data: Dict) -> "NeuralCardPolicy":
        return cls(
            quote_templates=[dict(entry) for entry in data.get("quoteTemplates", QUOTE_TEMPLATES)],
            hidden_size=int(data.get("hiddenSize", len(BASE_FEATURE_NAMES))),
            trunk_weights=[list(map(float, row)) for row in data.get("trunk", {}).get("weights", [])],
            trunk_bias=list(map(float, data.get("trunk", {}).get("bias", []))),
            intent_weights=[list(map(float, row)) for row in data.get("intentHead", {}).get("weights", [])],
            intent_bias=list(map(float, data.get("intentHead", {}).get("bias", []))),
            quote_state_weights=[list(map(float, row)) for row in data.get("quoteHead", {}).get("stateWeights", [])],
            quote_template_weights=[list(map(float, row)) for row in data.get("quoteHead", {}).get("templateWeights", [])],
            quote_bias=list(map(float, data.get("quoteHead", {}).get("bias", []))),
            take_candidate_state_weights=list(map(float, data.get("takeHead", {}).get("candidateStateWeights", []))),
            take_candidate_extra_weights=list(map(float, data.get("takeHead", {}).get("candidateExtraWeights", []))),
            take_candidate_bias=float(data.get("takeHead", {}).get("candidateBias", -0.12)),
            take_pass_weights=list(map(float, data.get("takeHead", {}).get("passWeights", []))),
            take_pass_bias=float(data.get("takeHead", {}).get("passBias", 0.06)),
            reveal_weights=list(map(float, data.get("revealHead", {}).get("weights", []))),
            reveal_bias=float(data.get("revealHead", {}).get("bias", -0.55)),
            value_weights=list(map(float, data.get("valueHead", {}).get("weights", []))),
            value_bias=float(data.get("valueHead", {}).get("bias", 0.0)),
            parameter_clip=float(data.get("parameterClip", 18.0)),
            model_type=str(data.get("modelType", "neural_mlp")),
        )

    def to_json(self) -> str:
        return json.dumps(self.to_dict())


def policy_from_dict(data: Dict):
    model_type = str(data.get("modelType", "linear"))
    if model_type in {"neural", "neural_mlp", "mlp"}:
        return NeuralCardPolicy.from_dict(data)
    return LinearCardPolicy.from_dict(data)


def _seed_intent_weights(policy: LinearCardPolicy) -> None:
    mean_bias_index = 0
    stdev_index = 1
    reveal_progress_index = 3
    live_quote_count_index = 5
    best_buy_edge_index = 6
    best_sell_edge_index = 7
    own_spread_index = 8
    unknown_ratio_index = 14
    best_quote_age_index = 22

    policy.intent_weights[0][best_buy_edge_index] = 3.4
    policy.intent_weights[0][best_sell_edge_index] = 3.4
    policy.intent_weights[0][best_quote_age_index] = 0.35
    policy.intent_weights[0][reveal_progress_index] = 0.15
    policy.intent_bias[0] = -0.22

    policy.intent_weights[1][stdev_index] = 1.1
    policy.intent_weights[1][live_quote_count_index] = -0.45
    policy.intent_weights[1][unknown_ratio_index] = 0.55
    policy.intent_weights[1][best_buy_edge_index] = -1.2
    policy.intent_weights[1][best_sell_edge_index] = -1.2
    policy.intent_weights[1][mean_bias_index] = 0.15
    policy.intent_bias[1] = 0.52

    policy.intent_weights[2][reveal_progress_index] = 1.6
    policy.intent_weights[2][stdev_index] = -1.8
    policy.intent_weights[2][live_quote_count_index] = -0.65
    policy.intent_bias[2] = -0.45

    policy.intent_weights[3][own_spread_index] = 0.25
    policy.intent_weights[3][best_buy_edge_index] = -1.0
    policy.intent_weights[3][best_sell_edge_index] = -1.0
    policy.intent_bias[3] = -0.3


def _seed_quote_head(policy: LinearCardPolicy) -> None:
    inventory_index = 2
    stdev_index = 1
    live_quote_count_index = 5
    best_buy_edge_index = 6
    best_sell_edge_index = 7
    would_improve_bid_index = 20
    would_improve_ask_index = 21
    offset_index = len(BASE_FEATURE_NAMES)
    spread_index = len(BASE_FEATURE_NAMES) + 1
    size_index = len(BASE_FEATURE_NAMES) + 2
    for row_index, template in enumerate(policy.quote_templates):
        row = policy.quote_weights[row_index]
        offset = float(template.get("reservationOffset", 0.0))
        spread = float(template.get("spreadScale", 0.0))
        size = float(template.get("size", 0.0)) / MAX_QUOTE_SIZE
        if template.get("noop"):
            row[live_quote_count_index] = 0.4
            row[best_buy_edge_index] = 0.8
            row[best_sell_edge_index] = 0.8
            policy.quote_bias[row_index] = -0.95
            continue
        row[inventory_index] = -offset * 5.5
        row[stdev_index] = spread * 0.75
        row[live_quote_count_index] = -0.1 * spread
        row[best_buy_edge_index] = -0.55
        row[best_sell_edge_index] = -0.55
        row[would_improve_bid_index] = max(0.0, -offset) * 0.9 + 0.12
        row[would_improve_ask_index] = max(0.0, offset) * 0.9 + 0.12
        row[offset_index] = abs(offset) * 0.35
        row[spread_index] = -abs(spread - 1.05) * 0.65
        row[size_index] = -abs(size - 0.25) * 0.3
        policy.quote_bias[row_index] = -abs(offset) * 0.75 - abs(spread - 1.0) * 0.15


def _seed_take_head(policy: LinearCardPolicy) -> None:
    candidate_buy_edge_index = len(BASE_FEATURE_NAMES)
    candidate_sell_edge_index = len(BASE_FEATURE_NAMES) + 1
    candidate_spread_index = len(BASE_FEATURE_NAMES) + 2
    candidate_size_index = len(BASE_FEATURE_NAMES) + 3
    candidate_age_index = len(BASE_FEATURE_NAMES) + 4
    policy.take_candidate_weights[candidate_buy_edge_index] = 2.8
    policy.take_candidate_weights[candidate_sell_edge_index] = 2.8
    policy.take_candidate_weights[candidate_spread_index] = -0.75
    policy.take_candidate_weights[candidate_size_index] = 0.12
    policy.take_candidate_weights[candidate_age_index] = 0.22
    policy.take_candidate_weights[1] = -0.18
    policy.take_candidate_bias = -0.06
    policy.take_pass_weights[6] = -2.25
    policy.take_pass_weights[7] = -2.25
    policy.take_pass_weights[5] = 0.25
    policy.take_pass_bias = 0.08


def _seed_reveal_and_value(policy: LinearCardPolicy) -> None:
    policy.reveal_weights[3] = 1.5
    policy.reveal_weights[1] = -1.35
    policy.reveal_weights[5] = -0.45
    policy.reveal_bias = -0.45
    policy.value_weights[0] = 0.8
    policy.value_weights[2] = -0.22
    policy.value_weights[15] = 0.5


def bootstrap_policy() -> LinearCardPolicy:
    policy = LinearCardPolicy()
    _seed_intent_weights(policy)
    _seed_quote_head(policy)
    _seed_take_head(policy)
    _seed_reveal_and_value(policy)
    return policy


def bootstrap_hybrid_as_policy() -> LinearCardPolicy:
    policy = bootstrap_policy()
    policy.model_type = "linear_hybrid_as"
    policy.hybrid_as_params = build_hybrid_as_params(policy.quote_templates)
    return policy


def bootstrap_neural_policy() -> NeuralCardPolicy:
    linear = bootstrap_policy()
    hidden_size = len(BASE_FEATURE_NAMES)
    trunk_weights = [[0.0] * len(BASE_FEATURE_NAMES) for _ in range(hidden_size)]
    for index in range(min(hidden_size, len(BASE_FEATURE_NAMES))):
        trunk_weights[index][index] = 1.25
    policy = NeuralCardPolicy(
        hidden_size=hidden_size,
        trunk_weights=trunk_weights,
        trunk_bias=[0.0] * hidden_size,
        intent_weights=[list(row) for row in linear.intent_weights],
        intent_bias=list(linear.intent_bias),
        quote_state_weights=[list(row[: len(BASE_FEATURE_NAMES)]) for row in linear.quote_weights],
        quote_template_weights=[list(row[len(BASE_FEATURE_NAMES) :]) for row in linear.quote_weights],
        quote_bias=list(linear.quote_bias),
        take_candidate_state_weights=list(linear.take_candidate_weights[: len(BASE_FEATURE_NAMES)]),
        take_candidate_extra_weights=list(linear.take_candidate_weights[len(BASE_FEATURE_NAMES) :]),
        take_candidate_bias=float(linear.take_candidate_bias),
        take_pass_weights=list(linear.take_pass_weights),
        take_pass_bias=float(linear.take_pass_bias),
        reveal_weights=list(linear.reveal_weights),
        reveal_bias=float(linear.reveal_bias),
        value_weights=list(linear.value_weights),
        value_bias=float(linear.value_bias),
    )
    return policy
