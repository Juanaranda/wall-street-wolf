#!/usr/bin/env python3
"""
Train XGBoost + Random Forest models on historical trade records.
Both models are trained together. RF is the fallback when XGBoost fails.
Run this nightly (or after 50+ settled trades) to keep models fresh.

Usage:
    python scripts/train_xgboost.py --trades data/trades.jsonl --output data/xgboost_model.json
"""

import argparse
import json
import sys
import os
import joblib
from datetime import datetime
from typing import List, Dict, Any

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import cross_val_score

try:
    import xgboost as xgb
    HAS_XGBOOST = True
except Exception:
    HAS_XGBOOST = False

CATEGORY_MAP = {
    "politics": 0, "finance": 1, "crypto": 2, "weather": 3,
    "sports": 4, "science": 5, "entertainment": 6, "general": 7,
}

def load_trades(path: str) -> List[Dict[str, Any]]:
    if not os.path.exists(path):
        return []
    records = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                # Only use settled trades with known outcome
                if r.get("outcome") is not None and r.get("pnl") is not None:
                    records.append(r)
            except json.JSONDecodeError:
                continue
    return records


def extract_features(record: Dict[str, Any]) -> List[float]:
    opened_at = datetime.fromisoformat(record.get("openedAt", datetime.now().isoformat()))
    category = record.get("category", "general")

    return [
        float(record.get("marketProbabilityAtEntry", 0.5)),
        float(record.get("daysToExpiry", 7.0)),
        float(record.get("volume24h", 500.0)),
        float(record.get("totalLiquidity", 1000.0)),
        float(record.get("sentimentScore", 0.0)),
        float(record.get("volumeSpike", 1.0)),
        float(record.get("spreadWidth", 0.03)),
        float(record.get("anomalyScore", 50.0)),
        float(record.get("sourceCount", 0)),
        float(record.get("sentimentConfidence", 0.5)),
        float(record.get("estimatedEdge", 0.0)),
        float(CATEGORY_MAP.get(category, 7)),
        float(opened_at.hour),
        float(opened_at.weekday()),
    ]


def extract_label(record: Dict[str, Any]) -> int:
    """1 if the trade was profitable, 0 if not."""
    return 1 if (record.get("pnl", 0) or 0) > 0 else 0


RF_MODEL_PATH = "data/rf_model.pkl"

FEATURE_NAMES = [
    "market_price", "days_to_expiry", "volume_24h", "total_liquidity",
    "sentiment_score", "volume_spike", "spread_width", "anomaly_score",
    "source_count", "sentiment_confidence", "estimated_edge",
    "category_encoded", "hour_of_day", "day_of_week",
]


def train_random_forest(X: np.ndarray, y: np.ndarray, output_path: str) -> Dict[str, Any]:
    """Train Random Forest — no OpenMP dependency, always available."""
    positive_rate = y.mean()
    rf = RandomForestClassifier(
        n_estimators=200,
        max_depth=6,
        min_samples_leaf=3,
        class_weight="balanced",
        random_state=42,
        n_jobs=-1,
    )
    rf.fit(X, y)

    cv_scores = cross_val_score(rf, X, y, cv=min(5, len(y) // 4), scoring="roc_auc")

    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else ".", exist_ok=True)
    joblib.dump(rf, output_path)

    importance = dict(zip(FEATURE_NAMES, rf.feature_importances_.tolist()))
    return {
        "status": "trained",
        "model": "random_forest",
        "trades_used": len(y),
        "win_rate": float(positive_rate),
        "cv_auc_mean": float(cv_scores.mean()),
        "cv_auc_std": float(cv_scores.std()),
        "output_path": output_path,
        "feature_importance": importance,
    }


def train_xgboost(X: np.ndarray, y: np.ndarray, output_path: str) -> Dict[str, Any]:
    """Train XGBoost — higher accuracy but requires libomp on macOS."""
    if not HAS_XGBOOST:
        return {"error": "xgboost not available"}

    positive_rate = y.mean()
    dtrain = xgb.DMatrix(X, label=y, feature_names=FEATURE_NAMES)
    params = {
        "objective": "binary:logistic",
        "eval_metric": "logloss",
        "max_depth": 4,
        "eta": 0.1,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "min_child_weight": 3,
        "scale_pos_weight": (1 - positive_rate) / max(positive_rate, 0.01),
        "seed": 42,
    }
    model = xgb.train(params, dtrain, num_boost_round=100, verbose_eval=False)

    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else ".", exist_ok=True)
    model.save_model(output_path)

    preds = model.predict(dtrain)
    accuracy = float(np.mean((preds > 0.5).astype(int) == y))
    return {
        "status": "trained",
        "model": "xgboost",
        "trades_used": len(y),
        "win_rate": float(positive_rate),
        "train_accuracy": float(accuracy),
        "output_path": output_path,
        "feature_importance": model.get_score(importance_type="gain"),
    }


def train(trades: List[Dict[str, Any]], xgb_path: str, rf_path: str) -> Dict[str, Any]:
    if len(trades) < 20:
        return {"error": f"Insufficient data: {len(trades)} settled trades (need >= 20)"}

    X = np.array([extract_features(t) for t in trades], dtype=np.float32)
    y = np.array([extract_label(t) for t in trades], dtype=np.int32)
    print(f"Training on {len(trades)} trades — win rate: {y.mean():.2%}", file=sys.stderr)

    results: Dict[str, Any] = {"trades_used": len(trades)}

    # Always train Random Forest (no system dependencies)
    print("Training Random Forest...", file=sys.stderr)
    results["random_forest"] = train_random_forest(X, y, rf_path)

    # Train XGBoost if available
    if HAS_XGBOOST:
        print("Training XGBoost...", file=sys.stderr)
        results["xgboost"] = train_xgboost(X, y, xgb_path)
    else:
        results["xgboost"] = {"error": "xgboost not available — using RF only"}

    results["status"] = "trained"
    return results


def main():
    parser = argparse.ArgumentParser(description="Train XGBoost + Random Forest prediction models")
    parser.add_argument("--trades", default="data/trades.jsonl", help="Path to trades JSONL file")
    parser.add_argument("--output", default="data/xgboost_model.json", help="XGBoost output path")
    parser.add_argument("--rf-output", default=RF_MODEL_PATH, help="Random Forest output path")
    args = parser.parse_args()

    trades = load_trades(args.trades)
    result = train(trades, args.output, args.rf_output)
    print(json.dumps(result, indent=2))
    sys.exit(0 if result.get("status") == "trained" else 1)


if __name__ == "__main__":
    main()
