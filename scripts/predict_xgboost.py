#!/usr/bin/env python3
"""
Fast model inference: XGBoost → Random Forest → logistic fallback.
Called from TypeScript via child_process spawn (stdin JSON).

Fallback hierarchy:
  1. XGBoost  — highest accuracy, requires libomp on macOS
  2. Random Forest — no system deps, always available after training
  3. Logistic rule — cold start, no trained model needed

Usage:
    echo '{"market_price": 0.45, ...}' | python scripts/predict_xgboost.py
    python scripts/predict_xgboost.py --model data/xgboost_model.json --rf-model data/rf_model.pkl
"""

import sys
import json
import os
import argparse
from datetime import datetime
from typing import Dict, Any, List, Optional

import numpy as np
import joblib

try:
    import xgboost as xgb
    HAS_XGBOOST = True
except Exception:
    HAS_XGBOOST = False

CATEGORY_MAP = {
    "politics": 0, "finance": 1, "crypto": 2, "weather": 3,
    "sports": 4, "science": 5, "entertainment": 6, "general": 7,
}

XGB_MODEL_PATH = "data/xgboost_model.json"
RF_MODEL_PATH  = "data/rf_model.pkl"

_xgb_model = None
_rf_model   = None


def load_xgb(path: str) -> Optional[Any]:
    global _xgb_model
    if not HAS_XGBOOST or not os.path.exists(path):
        return None
    if _xgb_model is None:
        try:
            m = xgb.Booster()
            m.load_model(path)
            _xgb_model = m
        except Exception:
            return None
    return _xgb_model


def load_rf(path: str) -> Optional[Any]:
    global _rf_model
    if not os.path.exists(path):
        return None
    if _rf_model is None:
        try:
            _rf_model = joblib.load(path)
        except Exception:
            return None
    return _rf_model


def build_features(data: Dict[str, Any]) -> List[float]:
    now = datetime.now()
    category = data.get("category", "general")
    return [
        float(data.get("market_price", 0.5)),
        float(data.get("days_to_expiry", 7.0)),
        float(data.get("volume_24h", 500.0)),
        float(data.get("total_liquidity", 1000.0)),
        float(data.get("sentiment_score", 0.0)),
        float(data.get("volume_spike", 1.0)),
        float(data.get("spread_width", 0.03)),
        float(data.get("anomaly_score", 50.0)),
        float(data.get("source_count", 0)),
        float(data.get("sentiment_confidence", 0.5)),
        float(data.get("estimated_edge", 0.0)),
        float(CATEGORY_MAP.get(category, 7)),
        float(now.hour),
        float(now.weekday()),
    ]


def logistic_fallback(market_price: float, sentiment_score: float, estimated_edge: float) -> float:
    p = market_price + sentiment_score * 0.15 + estimated_edge * 0.5
    return max(0.05, min(0.95, p))


def predict(data: Dict[str, Any], xgb_path: str, rf_path: str) -> Dict[str, Any]:
    features = build_features(data)
    market_price = float(data.get("market_price", 0.5))
    X = np.array([features], dtype=np.float32)
    model_used = "logistic_fallback"

    # Tier 1: XGBoost
    xgb_model = load_xgb(xgb_path)
    if xgb_model is not None:
        try:
            raw_prob = float(xgb_model.predict(xgb.DMatrix(X))[0])
            model_used = "xgboost"
        except Exception:
            xgb_model = None

    # Tier 2: Random Forest
    if xgb_model is None:
        rf_model = load_rf(rf_path)
        if rf_model is not None:
            try:
                raw_prob = float(rf_model.predict_proba(X)[0][1])
                model_used = "random_forest"
            except Exception:
                rf_model = None
        else:
            rf_model = None

        # Tier 3: Logistic rule (cold start)
        if rf_model is None:
            raw_prob = logistic_fallback(
                market_price=market_price,
                sentiment_score=float(data.get("sentiment_score", 0.0)),
                estimated_edge=float(data.get("estimated_edge", 0.0)),
            )

    edge = raw_prob - market_price
    return {
        "probability": round(raw_prob, 6),
        "edge": round(edge, 6),
        "market_price": market_price,
        "model_used": model_used,
        "used_fallback": model_used != "xgboost",
        "has_model": model_used in ("xgboost", "random_forest"),
        "feature_count": len(features),
    }


def main():
    parser = argparse.ArgumentParser(description="Fast model inference (XGBoost > RF > logistic)")
    parser.add_argument("--model",    default=XGB_MODEL_PATH, help="XGBoost model path")
    parser.add_argument("--rf-model", default=RF_MODEL_PATH,  help="Random Forest model path")
    parser.add_argument("payload", nargs="?", help="JSON payload (if omitted, reads from stdin)")
    args = parser.parse_args()

    try:
        raw = args.payload if args.payload else sys.stdin.read()
        data = json.loads(raw)
        result = predict(data, args.model, args.rf_model)
        print(json.dumps(result))
        sys.exit(0)
    except (json.JSONDecodeError, KeyError, ValueError) as e:
        print(json.dumps({"error": str(e), "probability": 0.5, "edge": 0.0,
                          "used_fallback": True, "model_used": "error"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
