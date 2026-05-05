# CoinGecko

Access **CoinGecko** crypto market data from the terminal via the public API (no authentication required).

**Mode**: 🌐 Public · **Domain**: `api.coingecko.com`

## Commands

| Command | Description |
|---------|-------------|
| `opencli coingecko top` | Top coins by market cap |

## Usage Examples

```bash
# Top 10 coins in USD (default)
opencli coingecko top

# Top 5 coins priced in CNY
opencli coingecko top --currency cny --limit 5

# Top 50 coins in EUR
opencli coingecko top --currency eur --limit 50

# JSON output
opencli coingecko top -f json
```

## Options

| Option | Description |
|--------|-------------|
| `--currency` | Quote currency (`usd` / `cny` / `eur` / `jpy` / etc., default: `usd`) |
| `--limit` | Number of coins to return (1–250, default: 10) |

## Output Columns

`rank, symbol, name, price, change24hPct, marketCap, volume24h, high24h, low24h`

## Prerequisites

- No browser required — uses CoinGecko's public market-data endpoint

## Notes

- The public endpoint is rate-limited; retry briefly if you hit transient `HTTP 429` responses
- All numeric values are denominated in the selected `--currency`
- `change24hPct` is a raw percent (e.g. `2.34` means `+2.34%`), not a fraction
