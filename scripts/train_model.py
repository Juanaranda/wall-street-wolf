#!/usr/bin/env python3
"""
Train a gradient-boosted classifier on the GOLD feature store to predict whether
a stock's forward return is positive — and, more importantly, whether the model's
ranking earns money OUT-OF-SAMPLE.

Honest design:
  - Chronological split: train on pre-TRAIN_END rows, test on the rest (no leakage
    of the future into training).
  - HistGradientBoosting captures the non-linear ("U-shaped") momentum relationship
    a single threshold can't.
  - The headline metric is NOT accuracy (the base rate is ~60% up). It's whether the
    top-decile predicted picks beat the bottom decile on realized forward return,
    in the test period.

Caveat: 21-day overlapping samples are autocorrelated, and the universe is today's
survivors — so treat absolute numbers as optimistic. Relative spread is the signal.

Usage: python3 scripts/train_model.py   (after `npm run export-gold`)
"""
import csv
import sys
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score, accuracy_score

CSV_PATH = "data/gold.csv"
FEATURES = [
    "ret_1d", "ret_21d", "ret_63d", "ret_126d", "ret_252d",
    "mom_12_1", "rsi_14", "macd_hist", "ema_gap", "vol_21", "dist_252high",
]


def load():
    Xtr, ytr, rtr, Xte, yte, rte = [], [], [], [], [], []
    with open(CSV_PATH) as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                feats = [float(row[c]) if row[c] != "" else np.nan for c in FEATURES]
                label = int(row["label_up"])
                fwd = float(row["fwd_ret"])
            except (ValueError, KeyError):
                continue
            if row["split"] == "train":
                Xtr.append(feats); ytr.append(label); rtr.append(fwd)
            else:
                Xte.append(feats); yte.append(label); rte.append(fwd)
    return (np.array(Xtr), np.array(ytr), np.array(rtr),
            np.array(Xte), np.array(yte), np.array(rte))


def decile_table(prob, fwd):
    """Avg forward return by predicted-probability decile (test set)."""
    order = np.argsort(prob)
    n = len(prob)
    print("\n  Decile (by predicted P(up))   n      avg fwd_ret   win%")
    print("  " + "-" * 52)
    for d in range(10):
        lo, hi = int(d * n / 10), int((d + 1) * n / 10)
        idx = order[lo:hi]
        avg = fwd[idx].mean() * 100
        win = (fwd[idx] > 0).mean() * 100
        tag = "  <- bottom" if d == 0 else ("  <- TOP" if d == 9 else "")
        print(f"  D{d+1:<2} {len(idx):>6}   {avg:>8.2f}%   {win:>5.1f}%{tag}")


def main():
    Xtr, ytr, rtr, Xte, yte, rte = load()
    if len(Xtr) == 0 or len(Xte) == 0:
        print("No data — run `npm run export-gold` first.", file=sys.stderr)
        sys.exit(1)

    print(f"Train: {len(Xtr):,} rows ({ytr.mean()*100:.1f}% up)   "
          f"Test: {len(Xte):,} rows ({yte.mean()*100:.1f}% up)")

    model = HistGradientBoostingClassifier(
        max_iter=300, learning_rate=0.05, max_depth=4,
        l2_regularization=1.0, random_state=42,
    )
    model.fit(Xtr, ytr)

    prob = model.predict_proba(Xte)[:, 1]
    pred = (prob >= 0.5).astype(int)
    auc = roc_auc_score(yte, prob)
    acc = accuracy_score(yte, pred)
    base = max(yte.mean(), 1 - yte.mean())

    print(f"\nOUT-OF-SAMPLE: AUC={auc:.3f}  accuracy={acc*100:.1f}%  "
          f"(base rate {base*100:.1f}%)")
    print("AUC>0.5 = real ranking signal; accuracy must beat the base rate.")

    decile_table(prob, rte)

    top = rte[np.argsort(prob)[int(0.9*len(prob)):]].mean() * 100
    bot = rte[np.argsort(prob)[:int(0.1*len(prob))]].mean() * 100
    print(f"\n  Top-decile avg fwd_ret {top:.2f}% vs bottom-decile {bot:.2f}% "
          f"(spread {top-bot:.2f} pts).")
    print("  Positive spread OOS = the model's picks add value.")


if __name__ == "__main__":
    main()
