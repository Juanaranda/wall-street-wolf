#!/usr/bin/env python3
"""
Deterministic pre-trade risk validator.
All risk checks run here in pure Python — no LLM involvement.
This is the ground-truth safety layer.

Usage:
    python validate_risk.py --config config.json --trade trade.json
    echo '{"edge": 0.08, ...}' | python validate_risk.py
"""

import argparse
import json
import sys
import os
from typing import Dict, Any, List


REQUIRED_TRADE_FIELDS = [
    "market_id", "edge", "model_probability", "market_probability",
    "position_size_usd", "direction",
]

REQUIRED_PORTFOLIO_FIELDS = [
    "bankroll", "available_cash", "total_exposure_usd",
    "open_position_count", "daily_loss_usd", "max_drawdown",
    "daily_api_cost_usd",
]

REQUIRED_CONFIG_FIELDS = [
    "min_edge", "max_position_size_usd", "max_total_exposure_usd",
    "max_daily_loss_usd", "max_drawdown_pct", "max_concurrent_positions",
    "max_daily_api_cost_usd",
]


def check_kill_switch() -> Dict[str, Any]:
    """Check if the STOP kill switch file exists."""
    active = os.path.exists("./STOP")
    return {
        "name": "kill_switch",
        "passed": not active,
        "value": 1.0 if active else 0.0,
        "threshold": 0.5,
        "reason": "STOP file detected — kill switch active" if active else "",
    }


def check_edge(trade: Dict, config: Dict) -> Dict[str, Any]:
    edge = abs(float(trade["edge"]))
    min_edge = float(config["min_edge"])
    passed = edge >= min_edge
    return {
        "name": "edge",
        "passed": passed,
        "value": edge,
        "threshold": min_edge,
        "reason": "" if passed else f"Edge {edge:.4f} < min {min_edge:.4f}",
    }


def check_position_size(trade: Dict, config: Dict) -> Dict[str, Any]:
    size = float(trade["position_size_usd"])
    max_size = float(config["max_position_size_usd"])
    passed = size <= max_size
    return {
        "name": "position_size",
        "passed": passed,
        "value": size,
        "threshold": max_size,
        "reason": "" if passed else f"Position size ${size:.2f} > max ${max_size:.2f}",
    }


def check_total_exposure(portfolio: Dict, trade: Dict, config: Dict) -> Dict[str, Any]:
    current = float(portfolio["total_exposure_usd"])
    new_size = float(trade["position_size_usd"])
    total = current + new_size
    max_exp = float(config["max_total_exposure_usd"])
    passed = total <= max_exp
    return {
        "name": "total_exposure",
        "passed": passed,
        "value": total,
        "threshold": max_exp,
        "reason": "" if passed else f"Total exposure ${total:.2f} > max ${max_exp:.2f}",
    }


def check_daily_loss(portfolio: Dict, config: Dict) -> Dict[str, Any]:
    loss = float(portfolio["daily_loss_usd"])
    max_loss = float(config["max_daily_loss_usd"])
    passed = loss < max_loss
    return {
        "name": "daily_loss",
        "passed": passed,
        "value": loss,
        "threshold": max_loss,
        "reason": "" if passed else f"Daily loss ${loss:.2f} >= limit ${max_loss:.2f}",
    }


def check_drawdown(portfolio: Dict, config: Dict) -> Dict[str, Any]:
    drawdown = float(portfolio["max_drawdown"])
    max_dd = float(config["max_drawdown_pct"])
    passed = drawdown < max_dd
    return {
        "name": "max_drawdown",
        "passed": passed,
        "value": drawdown,
        "threshold": max_dd,
        "reason": "" if passed else f"Drawdown {drawdown:.2%} >= limit {max_dd:.2%}",
    }


def check_concurrent_positions(portfolio: Dict, config: Dict) -> Dict[str, Any]:
    count = int(portfolio["open_position_count"])
    max_count = int(config["max_concurrent_positions"])
    passed = count < max_count
    return {
        "name": "concurrent_positions",
        "passed": passed,
        "value": float(count),
        "threshold": float(max_count),
        "reason": "" if passed else f"{count} open positions >= max {max_count}",
    }


def check_api_cost(portfolio: Dict, config: Dict) -> Dict[str, Any]:
    cost = float(portfolio["daily_api_cost_usd"])
    max_cost = float(config["max_daily_api_cost_usd"])
    passed = cost < max_cost
    return {
        "name": "api_cost",
        "passed": passed,
        "value": cost,
        "threshold": max_cost,
        "reason": "" if passed else f"Daily API cost ${cost:.2f} >= limit ${max_cost:.2f}",
    }


def validate(trade: Dict, portfolio: Dict, config: Dict) -> Dict[str, Any]:
    checks: List[Dict] = [
        check_kill_switch(),
        check_edge(trade, config),
        check_position_size(trade, config),
        check_total_exposure(portfolio, trade, config),
        check_daily_loss(portfolio, config),
        check_drawdown(portfolio, config),
        check_concurrent_positions(portfolio, config),
        check_api_cost(portfolio, config),
    ]

    failures = [c for c in checks if not c["passed"]]
    approved = len(failures) == 0

    return {
        "market_id": trade.get("market_id", "unknown"),
        "approved": approved,
        "rejection_reasons": [c["reason"] for c in failures],
        "checks": checks,
        "check_count": len(checks),
        "failed_count": len(failures),
    }


def main():
    parser = argparse.ArgumentParser(description="Deterministic pre-trade risk validator")
    parser.add_argument("--trade", type=str, help="JSON file with trade details")
    parser.add_argument("--portfolio", type=str, help="JSON file with portfolio state")
    parser.add_argument("--config", type=str, help="JSON file with risk config")
    args = parser.parse_args()

    try:
        if args.trade:
            with open(args.trade) as f:
                input_data = json.load(f)
        else:
            input_data = json.load(sys.stdin)

        trade = input_data.get("trade", input_data)
        portfolio = input_data.get("portfolio", {})
        config = input_data.get("config", {})

        if args.portfolio:
            with open(args.portfolio) as f:
                portfolio = json.load(f)
        if args.config:
            with open(args.config) as f:
                config = json.load(f)

        # Apply defaults if missing
        config.setdefault("min_edge", 0.04)
        config.setdefault("max_position_size_usd", 500)
        config.setdefault("max_total_exposure_usd", 5000)
        config.setdefault("max_daily_loss_usd", 750)
        config.setdefault("max_drawdown_pct", 0.08)
        config.setdefault("max_concurrent_positions", 15)
        config.setdefault("max_daily_api_cost_usd", 50)

        portfolio.setdefault("bankroll", 10000)
        portfolio.setdefault("available_cash", 10000)
        portfolio.setdefault("total_exposure_usd", 0)
        portfolio.setdefault("open_position_count", 0)
        portfolio.setdefault("daily_loss_usd", 0)
        portfolio.setdefault("max_drawdown", 0)
        portfolio.setdefault("daily_api_cost_usd", 0)

        result = validate(trade, portfolio, config)
        print(json.dumps(result, indent=2))
        sys.exit(0 if result["approved"] else 1)

    except (json.JSONDecodeError, KeyError) as e:
        print(json.dumps({"error": str(e), "approved": False}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
