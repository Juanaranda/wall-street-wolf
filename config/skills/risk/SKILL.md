---
name: predict-market-risk
description: Risk validation and position sizing for prediction market trades. Use when "check risk", "kelly sizing", "size position", "validate trade", "max exposure", "should I trade this".
metadata:
  version: 1.2.0
  pattern: deterministic
  tags: [risk, kelly, position-sizing, guards, drawdown]
---

# Risk Management Skill

## Purpose
Validate every trade before execution. All 8 checks must pass. Step 4 of the pipeline.

## CRITICAL: Use Python Scripts for Risk Calculations
Risk checks MUST run through deterministic Python scripts:
```bash
python scripts/validate_risk.py < trade_input.json
python scripts/kelly_size.py --prob 0.65 --price 0.45 --bankroll 10000 --fraction 0.25
```
**Never use LLM reasoning for position sizing.** Code is deterministic; language is not.

## 8 Pre-Trade Checks (ALL must pass)
1. **Kill Switch**: `./STOP` file must NOT exist
2. **Edge Check**: |modelP - marketP| ≥ 0.04
3. **Position Size**: Size ≤ Kelly recommendation AND ≤ $500 hard cap
4. **Total Exposure**: Current exposure + new size ≤ $5,000
5. **Daily Loss**: Daily loss < max daily loss limit
6. **Max Drawdown**: Portfolio drawdown < 8%
7. **Concurrent Positions**: Open positions < 15
8. **API Cost**: Daily AI API spend < $50

## Kelly Criterion Position Sizing

### Full Kelly
```
f* = (p × b - q) / b
where p = win prob, q = 1-p, b = (1/price) - 1
```

### Fractional Kelly (USE THIS)
```
position_size = bankroll × f* × 0.25
Hard cap: max 5% of bankroll per trade
```

### Example
- Bankroll: $10,000
- Win probability: 70%
- Market price: 0.45 → net odds b = 1.22
- Full Kelly: f* = (0.70×1.22 - 0.30) / 1.22 = 0.45
- Fractional Kelly (25%): 10,000 × 0.45 × 0.25 = $1,125
- After 5% hard cap: min($1,125, $500) = **$500**

## Value at Risk (95%)
```
VaR = position_size × (1 - win_prob) × 1.645
```

## Kill Switch
Create a file called `./STOP` to immediately halt all new orders:
```bash
touch ./STOP
```
Delete it to resume trading:
```bash
rm ./STOP
```
