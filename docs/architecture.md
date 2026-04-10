# Wall Street Wolf — Architecture

## Overview

An AI-powered prediction market trading bot that scans Polymarket and Kalshi, uses a multi-model AI ensemble to find mispricings, and trades with strict risk management.

## Pipeline

```
Scan → Research → Predict → Risk → Execute → Compound
```

Each stage is an independent service. Data flows downstream. Failure at any stage aborts the trade gracefully.

## Services

### 1. Scanner (`src/scanner/`)
- Fetches markets from Polymarket CLOB API and Kalshi REST API
- Filters by volume, liquidity, and time to expiry
- Detects anomalies (price moves, volume spikes, wide spreads)
- Runs every 15–30 minutes via `node-schedule`

### 2. Research (`src/research/`)
- Parallel scraping: news (NewsAPI) + Reddit
- Sentiment analysis using `sentiment` library + financial word extensions
- Credibility weighting by source domain
- Prompt injection protection: all external content is sanitized

### 3. Prediction (`src/prediction/`)
- 5-model ensemble: 2× Claude Sonnet + 3× GPT-4o
- Each model plays a role: primary, news analyst, bull, bear, risk
- Weighted consensus probability
- Calibration tracking via Brier Score
- Only signals with edge > 4% and confidence > 55% become trades

### 4. Risk Management (`src/risk/`)
- 8 deterministic pre-trade checks (TypeScript + Python backup)
- Kelly Criterion position sizing (fractional Kelly = 0.25)
- Hard cap: 5% of bankroll per trade, $500 absolute max
- Kill switch: check for `./STOP` file
- Daily state tracking: loss, API cost, drawdown

### 5. Execution (`src/execution/`)
- Limit orders only (never market orders)
- Slippage guard: abort if price moved > 2%
- Platform-specific clients: Polymarket (EIP-712 signing) + Kalshi (JWT auth)
- Graceful error handling — never leave orphaned positions

### 6. Compound (`src/compound/`)
- JSONL trade log with full history
- Failure classification: bad_prediction | bad_timing | bad_execution | external_shock
- Lessons stored in `data/knowledge_base.jsonl`
- Nightly consolidation at 23:59
- Performance metrics: win rate, Sharpe, drawdown, profit factor, Brier score

## Directory Structure

```
/src
  /scanner      — market discovery
  /research     — intelligence gathering
  /prediction   — probability estimation
  /risk         — position sizing & guards
  /execution    — order placement
  /compound     — learning & logging
  /shared       — types, config, logger, utils
  orchestrator.ts
  index.ts
/scripts
  validate_risk.py   — deterministic risk checker
  kelly_size.py      — position size calculator
/config/skills     — Claude SKILL.md files
/tests             — Jest unit tests
/docs              — documentation
/data              — runtime data (gitignored)
```

## Technology Stack
- **Runtime**: Node.js 20+ with TypeScript
- **AI**: Anthropic SDK (`@anthropic-ai/sdk`) + OpenAI SDK
- **APIs**: Polymarket CLOB, Kalshi REST
- **Blockchain**: ethers.js for Polymarket EIP-712 signing
- **Scheduling**: node-schedule
- **Testing**: Jest + ts-jest
- **Python**: Risk validation scripts (Python 3.9+)
