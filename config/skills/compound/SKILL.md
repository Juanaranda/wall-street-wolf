---
name: predict-market-compound
description: Post-trade learning and performance tracking. Use when "analyze trades", "what went wrong", "performance metrics", "brier score", "win rate", "sharpe ratio", "daily consolidation", "lessons learned".
metadata:
  version: 1.0.0
  pattern: learning
  tags: [compound, learning, performance, calibration, postmortem]
---

# Compound Learning Skill

## Purpose
Learn from every trade. Classify failures. Update the knowledge base. Step 6 of the pipeline.

## After Every Trade Loss
Run post-mortem and classify failure:
1. **bad_prediction**: Model estimated probability incorrectly
2. **bad_timing**: Correct direction but wrong timing
3. **bad_execution**: Slippage, liquidity issues, API errors
4. **external_shock**: Unpredictable event changed the outcome

Save the lesson to `data/knowledge_base.jsonl`. Future scans check this first.

## Performance Targets
| Metric | Target | Action if Below |
|--------|--------|-----------------|
| Win Rate | ≥ 60% | Review model calibration |
| Sharpe Ratio | > 2.0 | Review position sizing |
| Max Drawdown | < 8% | Reduce position sizes |
| Profit Factor | > 1.5 | Review edge threshold |
| Brier Score | < 0.25 | Review research sources |

## Nightly Consolidation (11:59 PM)
1. Calculate daily metrics
2. Classify all today's losses
3. Update knowledge base
4. Log performance summary
5. Alert if any metric is below target

## Key Metrics Formulas

### Brier Score (calibration accuracy)
```
BS = (predicted - outcome)²  — lower is better (random = 0.25)
```

### Profit Factor
```
PF = gross_profit / gross_loss  — target > 1.5
```

### Sharpe Ratio (annualized, simplified)
```
Sharpe = (avg_daily_pnl / std_daily_pnl) × √252  — target > 2.0
```

### Win Rate
```
win_rate = profitable_trades / total_settled_trades  — target ≥ 0.60
```
