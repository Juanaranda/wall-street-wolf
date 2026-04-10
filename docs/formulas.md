# Prediction Market Trading — Formula Reference

## Core Trading Formulas

### Edge
```
edge = model_probability - market_probability
```
Minimum required edge to trade: **0.04** (4%)

### Expected Value
```
EV = p × b - (1 - p)
where:
  p = win probability (model estimate)
  b = net odds = (1 / market_price) - 1
```
Example: p=0.70, market_price=0.45 → b=1.22 → EV = 0.70×1.22 - 0.30 = **0.554**

### Mispricing Z-Score
```
z = (model_prob - market_prob) / std_dev
```
Use std_dev ≈ 0.15 (estimated cross-model standard deviation)
A z-score > 1.5 is a strong signal.

## Kelly Criterion

### Full Kelly Fraction
```
f* = (p × b - q) / b
where p = win prob, q = 1 - p, b = net odds
```

### Fractional Kelly (USE THIS — 0.25×)
```
position_fraction = f* × 0.25
position_size_usd = bankroll × position_fraction
```
Hard cap: **min(position_size, 5% of bankroll, $500)**

### Why Fractional Kelly?
Full Kelly maximizes long-run growth but produces extreme variance.
Quarter-Kelly (0.25×) sacrifices ~10% of optimal growth for 75% less variance.
Most professional prediction market traders use 0.25–0.5× Kelly.

## Risk Metrics

### Value at Risk (95% confidence)
```
VaR_95 = position_size × (1 - win_prob) × 1.645
```

### Maximum Drawdown
```
MDD = (peak_equity - trough_equity) / peak_equity
```
Block all new trades if MDD ≥ **0.08** (8%).

## Performance Metrics

### Brier Score (calibration)
```
BS = (1/n) × Σ(predicted_i - outcome_i)²
```
- Random prediction: BS = 0.25
- Perfect calibration: BS = 0
- **Target: BS < 0.20**

### Profit Factor
```
PF = gross_profit / gross_loss
```
Target: PF > **1.5**

### Sharpe Ratio (annualized)
```
Sharpe = (mean_return / std_return) × √252
```
Target: Sharpe > **2.0**

### Win Rate
```
WR = profitable_trades / total_settled_trades
```
Target: WR ≥ **0.60** (60%)
