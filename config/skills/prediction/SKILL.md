---
name: predict-market-prediction
description: Estimates true probability using multi-model AI ensemble. Use when "predict probability", "what are the odds", "ensemble forecast", "model prediction", "calculate edge".
metadata:
  version: 1.0.0
  pattern: ensemble
  tags: [prediction, ensemble, probability, edge, calibration]
---

# Prediction Engine Skill

## Purpose
Calculate the true probability of a market outcome using multiple AI models. Step 3 of the pipeline.

## Ensemble Architecture (5 models)
| Model | Role | Weight | Provider |
|-------|------|--------|----------|
| claude-sonnet-4-6 | Primary Forecaster | 30% | Anthropic |
| claude-sonnet-4-6 | News Analyst | 20% | Anthropic |
| gpt-4o | Bull Advocate | 20% | OpenAI |
| gpt-4o | Bear Advocate | 15% | OpenAI |
| gpt-4o | Risk Manager | 15% | OpenAI |

Each model votes independently. Final probability = weighted average by (model_weight × confidence).

## Key Formulas

### Edge Calculation
```
edge = model_probability - market_probability
Trade only when |edge| > 0.04 (4%)
```

### Expected Value
```
EV = p × b - (1 - p)
where b = (1 / market_price) - 1
```

### Mispricing Z-Score
```
z = (model_prob - market_prob) / std_dev
Higher z = stronger signal
```

### Brier Score (calibration)
```
BS = (predicted - outcome)²
Target: < 0.25 (better than random)
Track per market, per model, overall average
```

## Trade Signal Rules
- `direction = 'yes'` if edge > +0.04 AND confidence > 0.55
- `direction = 'no'` if edge < -0.04 AND confidence > 0.55
- `direction = 'pass'` otherwise (DO NOT TRADE)

## Output
```json
{
  "marketId": "...",
  "modelProbability": 0.68,
  "marketProbability": 0.45,
  "edge": 0.23,
  "confidence": 0.78,
  "direction": "yes",
  "expectedValue": 0.15,
  "mispricingScore": 1.53
}
```
