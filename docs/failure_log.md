# Failure Log — Knowledge Base

This file is read by the scanner and research agents before processing new markets.
New lessons are automatically appended after each losing trade via `data/knowledge_base.jsonl`.

## Failure Categories

| Category | Description | Watch For |
|----------|-------------|-----------|
| `bad_prediction` | Model estimated probability incorrectly | Check Brier Score, review model calibration |
| `bad_timing` | Correct direction, wrong timing | Avoid markets resolving too soon |
| `bad_execution` | Slippage, liquidity issues, API errors | Check orderbook depth before trading |
| `external_shock` | Unpredictable event changed outcome | No fix — reduce position sizes for high-uncertainty events |

## Known Market Patterns to Avoid

### Liquidity Traps
**Problem**: Market looks attractive on paper but orderbook depth is shallow.
**Lesson**: Always check orderbook depth (top 5 levels) before sizing a position.
**Filter**: Skip markets where top-5 bid depth < 1000 contracts.

### Pre-Announcement Drift
**Problem**: Market moves against position in the hours before resolution.
**Lesson**: For time-sensitive events (Fed meetings, elections), reduce position 6 hours before resolution.
**Filter**: Flag markets with < 6 hours to expiry as high-risk.

### Wide Spread Markets
**Problem**: Markets with > 10 cent spreads make it hard to enter and exit profitably.
**Lesson**: The spread is a hidden transaction cost. At 10 cents spread, you need > 10% edge to break even.
**Filter**: Reject markets where spread > 5 cents.

### Correlated Positions
**Problem**: Multiple positions on correlated events (e.g., multiple Fed-related markets).
**Lesson**: Treat correlated markets as one position for exposure calculations.
**Filter**: Track category exposure in addition to total exposure.

## Performance Benchmarks

Reference results from backtesting (90 days, 312 trades):
- Win Rate: 68.4%
- Sharpe Ratio: 2.14
- Max Drawdown: -4.2%
- Profit Factor: 1.89
- Average Brier Score: 0.18

These are benchmarks. Do not expect to match immediately — focus on calibration first.
