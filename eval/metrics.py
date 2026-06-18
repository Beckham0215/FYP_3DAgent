"""Metric computation utilities for 3DAgent evaluation."""

import math
from typing import List, Dict, Optional, Tuple


def accuracy(predictions: List, ground_truth: List) -> float:
    if not ground_truth:
        return 0.0
    return sum(p == g for p, g in zip(predictions, ground_truth)) / len(ground_truth)


def mean_absolute_error(predictions: List[int], ground_truth: List[int]) -> float:
    if not ground_truth:
        return 0.0
    return sum(abs(p - g) for p, g in zip(predictions, ground_truth)) / len(ground_truth)


def precision_recall_f1_per_class(
    predictions: List[str],
    ground_truth: List[str],
    classes: List[str],
) -> Dict[str, Dict[str, float]]:
    """Return per-class precision, recall, F1 and raw counts."""
    results: Dict[str, Dict[str, float]] = {}
    for cls in classes:
        tp = sum(1 for p, g in zip(predictions, ground_truth) if p == cls and g == cls)
        fp = sum(1 for p, g in zip(predictions, ground_truth) if p == cls and g != cls)
        fn = sum(1 for p, g in zip(predictions, ground_truth) if p != cls and g == cls)
        prec = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        rec  = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1   = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0
        results[cls] = {"precision": prec, "recall": rec, "f1": f1,
                        "tp": tp, "fp": fp, "fn": fn}
    return results


def macro_f1(per_class: Dict[str, Dict[str, float]]) -> float:
    """Unweighted mean of per-class F1 (treats every class equally)."""
    scores = [v["f1"] for v in per_class.values()]
    return sum(scores) / len(scores) if scores else 0.0


def weighted_f1(per_class: Dict[str, Dict[str, float]]) -> float:
    """Support-weighted mean of per-class F1.

    Support for a class = tp + fn (number of ground-truth instances).
    Robust to class imbalance in a way macro-F1 is not.
    """
    total_support = sum(v["tp"] + v["fn"] for v in per_class.values())
    if total_support == 0:
        return 0.0
    return sum(v["f1"] * (v["tp"] + v["fn"]) for v in per_class.values()) / total_support


def wilson_ci(correct: int, total: int, z: float = 1.96) -> Tuple[float, float]:
    """Wilson score 95% confidence interval for a binomial proportion.

    Preferred over the normal approximation for small n and proportions
    near 0 or 1 (both common in this suite). Returns (low, high) in [0, 1].
    """
    if total == 0:
        return (0.0, 0.0)
    p = correct / total
    denom = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denom
    margin = (z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))) / denom
    return (max(0.0, centre - margin), min(1.0, centre + margin))


def mean_std(values: List[float]) -> Tuple[float, float]:
    """Population mean and standard deviation of a list of floats."""
    if not values:
        return (0.0, 0.0)
    mean = sum(values) / len(values)
    var = sum((v - mean) ** 2 for v in values) / len(values)
    return (mean, math.sqrt(var))


def confusion_matrix(
    predictions: List[str],
    ground_truth: List[str],
    classes: List[str],
) -> Dict[str, Dict[str, int]]:
    """cm[actual][predicted] = count."""
    cm: Dict[str, Dict[str, int]] = {c: {c2: 0 for c2 in classes} for c in classes}
    for pred, actual in zip(predictions, ground_truth):
        if actual in cm and pred in cm[actual]:
            cm[actual][pred] += 1
    return cm


def percentile(values: List[float], p: float) -> float:
    if not values:
        return 0.0
    sv = sorted(values)
    idx = (p / 100.0) * (len(sv) - 1)
    lo = int(idx)
    hi = min(lo + 1, len(sv) - 1)
    return sv[lo] * (1 - (idx - lo)) + sv[hi] * (idx - lo)


def score_badge(score: float) -> str:
    """Return a CSS class name based on a 0-1 score."""
    if score >= 0.9:
        return "pass"
    if score >= 0.7:
        return "warn"
    return "fail"
