#!/usr/bin/env python3
"""
Deterministic Kelly Criterion position sizing calculator.
Used as a ground-truth check independent of TypeScript runtime.

Usage:
    python kelly_size.py --prob 0.65 --price 0.45 --bankroll 10000 --fraction 0.25
"""

import argparse
import sys
import json
import math


def kelly_fraction(p: float, b: float) -> float:
    """
    Full Kelly fraction.
    f* = (p * b - q) / b
    p = win probability, q = 1 - p, b = net odds
    """
    q = 1.0 - p
    if b <= 0:
        return 0.0
    f = (p * b - q) / b
    return max(0.0, f)


def net_odds(price: float) -> float:
    """Convert market price to net odds b = (1/price) - 1"""
    if price <= 0 or price >= 1:
        raise ValueError(f"Invalid price: {price}. Must be in (0, 1).")
    return (1.0 / price) - 1.0


def position_size(
    bankroll: float,
    win_probability: float,
    market_price: float,
    kelly_multiplier: float = 0.25,
    max_position_pct: float = 0.05,
) -> dict:
    """
    Calculate recommended position size using fractional Kelly.

    Returns a dict with:
        full_kelly: full Kelly fraction
        fractional_kelly: after applying multiplier
        size_usd: recommended USD position size
        capped: whether the hard limit was applied
        expected_value: EV of the trade
    """
    if not (0 < win_probability < 1):
        raise ValueError(f"win_probability must be in (0, 1), got {win_probability}")
    if not (0 < market_price < 1):
        raise ValueError(f"market_price must be in (0, 1), got {market_price}")
    if bankroll <= 0:
        raise ValueError(f"bankroll must be positive, got {bankroll}")

    b = net_odds(market_price)
    f_full = kelly_fraction(win_probability, b)
    f_frac = f_full * kelly_multiplier

    # Hard cap
    f_capped = min(f_frac, max_position_pct)
    capped = f_capped < f_frac

    size_usd = round(bankroll * f_capped, 2)

    # Expected value: EV = p * b - (1 - p)
    ev = win_probability * b - (1.0 - win_probability)

    return {
        "full_kelly": round(f_full, 6),
        "fractional_kelly": round(f_frac, 6),
        "capped_fraction": round(f_capped, 6),
        "size_usd": size_usd,
        "capped": capped,
        "expected_value": round(ev, 6),
        "net_odds": round(b, 6),
    }


def var_95(position_size_usd: float, win_probability: float) -> float:
    """
    Value at Risk at 95% confidence.
    VaR = position_size * (1 - win_prob) * 1.645
    """
    z = 1.645
    loss_per_unit = 1.0 - win_probability
    return round(position_size_usd * loss_per_unit * z, 2)


def main():
    parser = argparse.ArgumentParser(description="Kelly Criterion position sizing")
    parser.add_argument("--prob", type=float, required=True,
                        help="Win probability (0-1)")
    parser.add_argument("--price", type=float, required=True,
                        help="Market price of the contract (0-1)")
    parser.add_argument("--bankroll", type=float, required=True,
                        help="Available bankroll in USD")
    parser.add_argument("--fraction", type=float, default=0.25,
                        help="Kelly fraction multiplier (default: 0.25)")
    parser.add_argument("--max-pct", type=float, default=0.05,
                        help="Max position as pct of bankroll (default: 0.05)")
    args = parser.parse_args()

    try:
        result = position_size(
            bankroll=args.bankroll,
            win_probability=args.prob,
            market_price=args.price,
            kelly_multiplier=args.fraction,
            max_position_pct=args.max_pct,
        )
        result["var_95"] = var_95(result["size_usd"], args.prob)
        print(json.dumps(result, indent=2))
    except ValueError as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
