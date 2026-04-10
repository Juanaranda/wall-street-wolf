---
name: predict-market-scanner
description: Scans Polymarket and Kalshi for tradeable prediction markets. Use when "scan markets", "find opportunities", "check markets", "what markets are tradeable", "list active markets".
metadata:
  version: 1.0.0
  pattern: scheduled
  tags: [scanner, polymarket, kalshi, markets]
---

# Market Scanner Skill

## Purpose
Find and rank prediction markets worth researching. This is Step 1 of the trading pipeline.

## Trigger Conditions
Activate when:
- User asks to scan for tradeable markets
- Scheduled scan interval fires (every 15–30 minutes)
- User asks "what should I trade" or "find opportunities"

## Market Quality Filters (ALL must pass)
1. **Minimum Volume**: 24h volume ≥ 200 contracts
2. **Minimum Liquidity**: Total liquidity ≥ $500
3. **Time to Expiry**: Between 12 hours and 30 days
4. **Spread**: Between 1 cent and 15 cents (wider = illiquid)

## Anomaly Detection (flag if any present)
- **Price Move >10%**: Recent sudden price change — may indicate news
- **Wide Spread >5 cents**: Illiquid, hard to fill cleanly
- **Volume Spike**: Current volume > 2x 7-day average — unusual activity
- **Low Liquidity**: Total liquidity < $500

## Platforms
- **Polymarket**: CLOB API at `https://clob.polymarket.com` — WebSocket for live updates
- **Kalshi**: REST API at `https://demo-api.kalshi.co/trade-api/v2` — use demo for testing

## Output Format
Return a ranked list of markets sorted by opportunity score (0–100):
```
[RANK] MarketID | Platform | Question | YesPrice | Volume24h | AnomalyFlags | Score
```
Only pass markets with score ≥ 60 to the Research stage.

## Safety Rules
- Never trade markets expiring in less than 6 hours (insufficient time to exit)
- Never trade markets with spread > 15 cents (slippage will eat the edge)
- Check the `./STOP` kill switch file before any API calls
