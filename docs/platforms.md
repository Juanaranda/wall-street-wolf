# Platform API Reference

## Polymarket

**Type**: Decentralized prediction market on Polygon blockchain
**CLOB**: Central Limit Order Book with off-chain matching, on-chain settlement

### Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/markets` | GET | List active markets (params: `active=true`, `limit`) |
| `/book` | GET | Get orderbook (params: `token_id`) |
| `/order` | POST | Place limit order |
| `/order/:id` | DELETE | Cancel order |
| `/prices-history` | GET | Price history (params: `market`, `startTs`, `fidelity`) |

### Authentication (EIP-712)
Orders must be signed with an Ethereum wallet using EIP-712 structured data.
- `POLYMARKET_PRIVATE_KEY` — Ethereum wallet private key
- Signature schema: defined in Polymarket CLOB API docs

### WebSocket
```
wss://ws-subscriptions-clob.polymarket.com/ws/market
```
Subscribe to live orderbook updates for real-time pricing.

### Key Notes
- Prices in range [0.01, 0.99]
- Contracts represent $0.01–$1.00 payouts
- Yes and No tokens are separate (token_id per outcome)
- Volume in contracts, not USD
- Geo-restrictions apply

### Official Docs
https://docs.polymarket.com

---

## Kalshi

**Type**: US-regulated CFTC-registered exchange
**Settlement**: USD cash settlement

### Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/login` | POST | Authenticate (returns JWT token) |
| `/markets` | GET | List markets (params: `status=open`, `limit`) |
| `/markets/:ticker` | GET | Get market details |
| `/markets/:ticker/orderbook` | GET | Get orderbook |
| `/portfolio/orders` | POST | Place order |
| `/portfolio/orders/:id` | DELETE | Cancel order |

### Authentication
```
POST /login { email, password }
→ Response: { token: "..." }
Use as: Authorization: Bearer <token>
```

### Order Payload
```json
{
  "order": {
    "ticker": "FED-23DEC-T5.5",
    "client_order_id": "uuid",
    "action": "buy",
    "side": "yes",
    "type": "limit",
    "count": 100,
    "yes_price": 45
  }
}
```
Note: Prices are in cents (0–99). Count = number of contracts ($1 face value each).

### Demo Environment
```
https://demo-api.kalshi.co/trade-api/v2
```
Use demo for testing — provides mock funds.

### Official Docs
https://trading-api.readme.io
