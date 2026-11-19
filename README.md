# Katana Delta-Neutral

Self-hosted bots that earn Katana Perps funding with the price risk hedged out. Three strategies share
this code base:

| Strategy | How it works | Status | Yield so far |
|---|---|---|---|
| **ETH delta-neutral** (this repo, `apps/bot`) | Long spot vbETH on Sushi V3 + equal short ETH-USD on Katana Perps, 2x | Live pilot, auto-rebalance on | **~6.9% APR** on capital (funding, before costs) |
| **ETH delta-neutral + Yearn** (separate repo) | Same trade, spot leg parked in the Yearn vbETH vault | Live pilot, auto-rebalance on | **~7.9% APR**: ~6.5% funding + ~0.3% vault + ~1% KAT rewards |
| **WBTC carry** (`apps/wbtc`) | WBTC on Morpho, borrow vbUSDC, buy an extra WBTC slice, short that slice on BTC-USD | Live pilot | **~2.9–3.3% more BTC/yr** (funding minus borrow) |

Price moves cancel out; the return is perp funding, ≈0.01%/8h ≈ 10.9% APR on the short notional
through 2026. Yields are rough figures from small live pilots running since October 2026, before
costs; they are not a promise of future returns.

**Why Katana Perps for the hedge** (Mar 23 – Nov 18, 2026, ETH and BTC, from the public funding APIs
of each venue):

- Katana averaged **10.9% (ETH) and 11.0% (BTC) APR** paid to shorts; Hyperliquid, Lighter and Aster
  averaged 4.2–6.4%.
- **No negative 8h settlement on Katana.** The other venues were negative in 14–18% of 8h windows,
  down to −62% APR.
- **Sell-offs:** in the worst Hyperliquid window (Oct 30, ETH) Katana paid shorts +10.9% while
  Hyperliquid charged them 35.3%. In April's decline the others averaged −3% to +2%; Katana paid 10.9%.
- **After costs:** the same bot rules modeled on each venue net **6.9–7.0%** with Katana as the hedge vs
  2.4–3.9% elsewhere, and the pilot's equity stayed flat through the −11% ETH move of Oct 29–30.
- **Caveat:** Katana's rate is mostly its 0.01%/8h interest component, a protocol setting that could change.

The bot sizes the position from the capital it finds, keeps both legs matched and leverage in a band,
protects the short with an exchange-side stop, and reports everything to Telegram.

- **Hosting:** a self-hosted server. Eligibility to trade on Katana Perps is the operator's responsibility.

**Before you run it**

- **Use your own Katana Perps API key.** Create one in Katana Perps for the bot's wallet (read and trade
  scopes, plus withdraw if the bot should move margin) and set `KP_API_KEY` / `KP_API_SECRET`. Without
  your own key the API rate limits are strict enough to stall the bot's checks.
- **Season points are automatic.** The bot's perp trading counts as wallet activity for Katana Season
  points; nothing to set up.
- **Katana Quests need an opt-in.** To take part in quests with the bot's wallet, opt in at
  [app.katana.network/quests](https://app.katana.network/quests).
- **Trading competitions ($100K+ USDC) need an opt-in every time.** The bot doesn't join them for you;
  opt the wallet in for each competition at
  [perps.katana.network/rewards/competition](https://perps.katana.network/rewards/competition).

---

## Contents

1. [Architecture](#architecture)
2. [Repository layout](#repository-layout)
3. [Strategy math](#strategy-math)
4. [Control loop](#control-loop)
5. [Execution](#execution)
6. [Safety and failure handling](#safety-and-failure-handling)
7. [Data: database, logs, cost ledger](#data-database-logs-cost-ledger)
8. [Telegram](#telegram)
9. [Configuration](#configuration)
10. [Operations](#operations)
11. [CLI reference](#cli-reference)
12. [Security model](#security-model)
13. [Development](#development)
14. [Known limitations](#known-limitations)
15. [WBTC carry bot](#wbtc-carry-bot)

---

## Architecture

```
                 ┌──────────────────────────── host (user kdn, pm2-kdn) ────────────────────────────────┐
                 │                                                                                      │
 Telegram  ◀────▶│  telegram.ts ──┐                                                                     │
 (commands,      │                │       watch.ts                                                      │
  alerts)        │                ├──▶  every 15 s: fast risk check ──(urgent)──┐                       │
                 │  notify.ts ◀───┤      every 5 min: full check ───────────────┤                       │
                 │                │                                            ▼                       │
                 │  auto.ts  (pause, daily cap) ──▶ execute.ts: plan → steps → executor                 │
                 │                                   │            │             │                       │
                 │  db.ts (node:sqlite) ◀────────────┤      @kdn/core      protect.ts (stop upkeep)     │
                 │  log.ts (text + JSONL)            │   (pure planner,                                │
                 │                                   │    risk, costs)                                 │
                 │                          @kdn/katana                                                │
                 └───────────────┬─────────────────────┬───────────────────────┬──────────────────────┘
                                 │                     │                       │
                  Katana Perps REST API      Katana RPC (viem)          Sushi V3 contracts
                  (SDK: HMAC + EIP-712)      rpc.katana.network         QuoterV2 / SwapRouter
                  orders, stops, margin,     balances, receipts,        vbUSDC/vbETH pools
                  withdrawals, funding       logs, deposits
```

- **Signing:** the wallet private key signs onchain transactions (viem) and perp orders/withdrawals
  (SDK `SignTypedData`). The SDK accepts any signer, which is how a Circuit agent will plug in
  `wallet.messages.sign` later.
- **Chain:** Katana mainnet, chain id `747474`.

| Contract / token | Address |
|---|---|
| Katana Perps exchange | `0x62230CeA619F734cc215bB8074bbF07bE4Eb633e` |
| vbUSDC (6 dec, perp collateral) | `0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36` |
| vbETH (18 dec) | `0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62` |
| Sushi V3 Factory | `0x203e8740894c8955cB8950759876d7E7E45E04c1` |
| Sushi V3 SwapRouter | `0x4e1d81A3E627b9294532e990109e4c21d217376C` |
| Sushi V3 QuoterV2 | `0x92dea23ED1C683940fF1a2f8fE23FE98C5d3041c` |

---

## Repository layout

npm workspaces, TypeScript 7, Node 24, run with `tsx` (no build step).

```
packages/core/            Pure strategy logic: no I/O, no native modules (portable to Circuit)
  src/strategy.ts         computeTarget, planRebalance → ordered Steps
  src/risk.ts             evaluateAlerts (full), evaluateFastRisk (15 s), protectiveStopPrice
  src/costs.ts            cost ledger summary, order-book walk, scale projection
  src/report.ts           PnL, funding vs expected, hypotheses H1–H6
  src/metrics.ts          delta, basis, equity, liquidation maths, swap cost model
  src/plan.ts             perp order step/minimum, short adjustment
  src/types.ts            Snapshot, FundingPayment, PerpFill, SwapRecord, CostEntry, StateStore, …
  test/core.test.ts       node:test suite
packages/katana/          Katana I/O, runtime-agnostic (no fs, no native modules)
  src/perps.ts            SDK reader: account, fills, funding, open orders, order book, candles; throttling
  src/trader.ts           SDK trader: deposit, market orders, stops, cancels, withdrawals
  src/chain.ts            viem reader: balances, allowances, Sushi mid/quotes, swap parsing, logs
  src/routes.ts           Sushi V3 route search (direct tiers + two-hop) and direct-pool quote
  src/spot.ts             swap execution via SwapRouter exactInput, approvals
  src/execution.ts        TxExecutor interface (bot: viem wallet; Circuit: wallet.transactions.create)
  src/constants.ts        addresses, decimals, fee tiers, hop tokens
apps/bot/                 Self-hosted runtime
  src/cli.ts              command dispatch
  src/jobs/watch.ts       two-speed loop (15 s risk / 5 min full)
  src/jobs/execute.ts     rebalance + exit executor, start-state checks
  src/jobs/protect.ts     protective stop upkeep
  src/jobs/{sync,snapshot,report,costs}.ts
  src/auto.ts             auto-rebalance guards (pause, daily cap, blocked alerts)
  src/telegram.ts         command long-poll + replies, watch status
  src/notify.ts           alert dispatch with de-duplication
  src/db.ts               SqliteStore (node:sqlite) implementing StateStore
  src/log.ts              console mirror + JSONL events
  src/wallet.ts           local signer/executor (records gas per tx)
  src/env.ts              configuration
apps/circuit/             Placeholder for the Circuit agent
scripts/deploy.sh         push working tree to the droplet, install, test, reload
scripts/remote.sh         run a bot command on the droplet
scripts/kdn               root helper installed on the droplet as /usr/local/bin/kdn
ecosystem.config.cjs      pm2 process definition
```

---

## Strategy math

**Capital** is everything the strategy holds, valued at the perp index price `P`:

```
C = wallet vbUSDC + spot vbETH × P + perp equity
```

**Target split** at leverage `L = TARGET_LEVERAGE` (`computeTarget`):

```
reserve   R = C × RESERVE_PCT / 100                      kept as vbUSDC in the wallet
investable I = C − R
fee budget F = N₀ × (2 × swapCost%(N₀) + 2 × takerFee)   with N₀ = I × L / (L + 1)
spot      N = (I − F) × L / (L + 1)                      USD of vbETH
margin    M = (I − F) × 1 / (L + 1)                      perp collateral, so N / M = L
short       = floor(N / P, 0.001 ETH)                    perp order step
```

`swapCost%` is a size curve measured on the 0.05% pool (0.10% at $100 → 0.70% at $6.4k);
`takerFee` = 0.019%.

**Leverage** (computed from our own numbers, not the API's account-wide figure):
`lev = |short| × mark / perp equity`.

**Liquidation** of a short opened at `P₀` with leverage `L` and maintenance margin fraction `m`
(1% on ETH-USD) is at roughly `P₀ × (1 + (1/L − m) / (1 + m))`: about **+48.5% at 2x**.
The bot uses the exchange's reported `liquidationPrice` for everything live.

**Price levels with no rebalancing**, starting at 2x (ignoring fees):

| Move from entry | Leverage | Event |
|---|---|---|
| −10% | 1.5x | low band: grow legs / withdraw excess margin |
| +7.1% | 2.5x | high band: rebalance immediately |
| +12.5% | 3x | warning alert |
| +20% | 4x | kill alert |
| ≈+26% | — | protective stop fills (15% under liquidation) |
| ≈+48.5% | — | liquidation |

**Protective stop price:** `floor(liquidationPrice × (1 − STOP_BELOW_LIQ_PCT/100), 0.1)`.

**Breakeven days** = fee budget / (spot notional × funding rate × 3).

---

## Control loop

`watch` (`apps/bot/src/jobs/watch.ts`) is a single sequential loop, so checks and trades never overlap:

**Every `RISK_CHECK_INTERVAL_SEC` (15 s) — fast risk check.** One perps account call plus market
data; **no chain reads**. Computes leverage and distance to liquidation (`evaluateFastRisk`), sends
leverage/liquidation alerts, and if leverage > `MAX_LEVERAGE` or liquidation is within 20%, runs an
auto-rebalance **immediately** (then refreshes the stop). Urgent triggers have a 2-minute cooldown.

**Every `WATCH_INTERVAL_MIN` (5 min) — full check.**
1. Sync funding payments and rates; scan new swaps from vbETH transfer logs.
2. Auto-rebalance by the full rules (if enabled and not paused).
3. Maintain the protective stop.
4. Sync fills, take a snapshot (both legs, prices, basis), evaluate all alerts, dispatch.

**Rebalance planning** (`planRebalance`, pure). From current holdings and the target:

| Trigger | Steps |
|---|---|
| Funding negative 3 periods in a row, or the last `AVG_FUNDING_PERIODS` settlements average < 0 | `unwind` |
| Spot > `REBALANCE_BAND_PCT` (and `MIN_TRADE_USD`) off target, or leverage outside `[MIN_LEVERAGE, MAX_LEVERAGE]` | `marginTo` → `shrinkTo` → `marginTo` → `withdrawTo` → `growTo` → `hedge` (only the ones needed) |
| Legs > `ALERT_DELTA_PCT` apart (≥ 0.01 ETH) | `hedge` |
| Legs > `ALERT_DELTA_PCT` apart by less than 0.01 ETH (with a short open) | `alignSpot` → `hedge` |
| Otherwise | nothing |

Step order is chosen for safety: margin is topped up from the wallet reserve **first** (one
transaction), before slower spot sells; the short is covered **before** spot is sold; spot is bought
**before** the short is grown. Every step re-reads live balances and the position before acting, so
an interrupted run resumes cleanly on the next one.

Every spot change is at least one perp order (0.01 ETH, the ETH-USD minimum) away from the current
short, so the short can always follow: `growTo` grows ≥ 0.01 ETH past it, `shrinkTo` shrinks ≥ 0.01 ETH
below it and never sells spot the short still hedges. A smaller gap is closed by `alignSpot`, which
buys spot (may use half the reserve) or, without the vbUSDC, sells the spot over the short.
After executing, the rebalance re-reads both legs; if they are still > `ALERT_DELTA_PCT` apart the
Telegram message is 🚨 "Rebalanced but legs are X% apart" instead of 🔁 (the 2026-10-30 incident).

Growing (any plan with `growTo`) is refused while funding is under `MIN_GROW_FUNDING_RATE` (0.005%/8h)
or the recent settlements average negative: near zero, fees would take months to earn back.
Shrinks, hedges and unwinds are never blocked by funding.

**Auto-rebalance guards** (`auto.ts`): pauses itself after a failed rebalance or after
`MAX_AUTO_REBALANCES_PER_DAY` executed rebalances in 24 h, and tells Telegram why. A blocked
pre-check (not a failure) only alerts, at most hourly, and retries next tick. A run that executed
but changed nothing (no spot, short or wallet vbUSDC moved, e.g. no vbUSDC to buy with) doesn't count
toward the cap either: it sends ⚠️ "nothing could be traded" (at most hourly) and retries next tick.
`/resume` re-enables.
It also pauses when the short shrinks between two checks without our order (protective stop fill,
liquidation or ADL): spot is then unhedged, and a 🚨 message asks for a manual re-hedge or spot sale.
Legs ≥ `URGENT_DELTA_PCT` apart alert as 🚨 urgent (repeat every 15 min) instead of hourly ⚠️.

---

## Execution

### Spot (Sushi V3)

- **Routing** (`SWAP_ROUTING`):
  - `direct` (default): one QuoterV2 `quoteExactInput` call on the vbUSDC/vbETH **0.05%** pool.
    Light enough for the public RPC.
  - `search`: looks up pools for all four fee tiers directly and two-hop through USDT, AUSD, USDS,
    wstETH, weETH, WBTC (factory `getPool` multicall, cached per process), quotes each candidate as
    its own `eth_call` (a thin-pool route can burn millions of gas and would sink a shared
    multicall), picks the best. Needs a keyed RPC.
  - RPC errors abort the swap rather than silently picking from a partial set; quoter reverts
    (pool can't fill) just drop that route.
- **Swap:** SwapRouter `exactInput` with `amountOutMinimum = quote × (1 − MAX_SLIPPAGE_BPS)`, 5-minute
  deadline, one-time max approval per token. The input is capped at the exact onchain balance (a
  float can round a hair above it and make the router revert with `STF`).
- **Chunking:** buys of at most `MAX_CHUNK_USD`; each chunk is skipped if its quote is more than
  `MAX_SPOT_IMPACT_PCT` above the index; the short is matched after every chunk.
- **Recording:** every swap is stored with route, pool fee, amounts, the perp 1-minute close as a
  reference price (index if the candle isn't out yet) and gas.

### Perps (Katana Perps API via `@katanaperps/katana-perps-sdk`)

- **Auth:** API key + HMAC on every request; orders, cancels and withdrawals also carry an EIP-712
  signature from the wallet. Nonces are UUID v1.
- **Orders:** market orders (the exchange caps execution at 0.3% from mark). Covering uses
  `reduceOnly`. Quantities `toFixed(8)`, rounded down to 0.001 ETH, minimum 0.01 ETH. Fills are
  confirmed from the position itself, not just the order response.
- **Prices must be strings with 8 decimals** (`"3132.00000000"`), and limit prices must sit within
  50% of the market.
- **Deposits** are onchain: approve vbUSDC to the exchange, `deposit(amount, 0x0)`, then poll perp
  equity until credited (≤ 5 min).
- **Withdrawals** go through the API to `katana.katana` (stays on Katana); the exchange deducts a gas
  fee (≈$0.05), refused above $1. Needs an API key with Withdraw scope and `ALLOW_WITHDRAW=true`.
- **Protective stop** (`protect.ts`): exactly one reduce-only `stopLossMarket` buy of the whole short,
  triggered on the **index** price at `STOP_BELOW_LIQ_PCT` under liquidation. Anchored to liquidation
  (not mark) so it is only replaced when margin or size changes. Replacement places the new stop
  **before** cancelling the old one. Maintained by `watch` whenever auto-rebalance is enabled
  (paused or not), and after a manual `rebalance --go`.

### Rate limits

| Endpoint | Limit | Handling |
|---|---|---|
| Perps user-data / trade | ≈1 req/s per key | serialized, 1.1 s spacing, retry 429 up to 6× with backoff |
| Perps public | 5–10 req/s | 150 ms spacing, same 429 retry |
| Katana public RPC (Conduit) | meters `eth_call` work | viem retries 6× (400 ms base); `direct` routing; spaced quotes |

---

## Safety and failure handling

- **Dry run by default:** every trading command prints its plan and pre-checks; nothing is sent
  without `--go` (or `AUTO_REBALANCE=true` in `watch`).
- **Start state:** before any rebalance the perps account must have no positions in other markets
  (cross margin) and no open orders except our own stop (`cancel-orders --go` clears strays). An
  existing ETH-USD long is refused. Perp collateral already on the exchange counts toward capital.
- **Pre-checks:** refuse if gas < 0.0005 ETH or Sushi is ≥1% off index (possible depeg); refuse to
  grow if funding ≤ 0 or Sushi is ≥0.5% off index.
- **Kill rules:** 3 negative funding periods → unwind. Leverage ≥ 4x, basis ≥ 1% → kill alerts.
- **Unexpected position changes** (size moved with no fill of ours: ADL or liquidation) → alert.
- **Eligibility:** Katana Perps rejects orders from restricted jurisdictions (HTTP 451). Run the bot
  only where you are eligible to trade.
- **Crash safety:** pm2 restarts on crash (exponential backoff) and on reboot (`pm2-kdn` systemd
  unit); memory capped at 250 MB. Steps re-read state, so restarts don't double-trade.
- **SQLite concurrency:** WAL mode + 10 s busy timeout, so CLI commands and `watch` can write at once.

---

## Data: database, logs, cost ledger

**SQLite** (`data/bot.db`, Node's built-in `node:sqlite`, no native build):

| Table | Contents |
|---|---|
| `snapshots` | JSON snapshot every full check / `/balance` (both legs, prices, leverage, liquidation) |
| `funding_payments`, `funding_rates` | per-settlement payments received, published rates |
| `fills` | perp fills with fee and index at fill time |
| `swaps` | onchain swaps with route, pool fee, reference price, gas |
| `costs` | gas for every tx the bot sends, withdrawal fees |
| `capital` | capital in/out (`capital <usd>`) |
| `alerts_sent`, `meta` | alert de-dup; sync cursors, pause state, Telegram offset, run counts |

**Cost ledger** (`costs`, `report`, `/pnl`): swap pool fees, swap impact (execution vs perp price
minus pool fee), perp fees, perp slippage (fill vs index), gas, withdrawal fees, and total in bps of
notional traded. `costs` also projects round-trip cost, breakeven and 30-day net APR at larger
sizes from live Sushi quotes and the live perp order book.

**Logs** (`data/logs/`, UTC dates):

| File | Contents |
|---|---|
| `YYYY-MM-DD.log` | everything printed, timestamped, tagged with the command (`[watch]`, `[rebalance]`, …) |
| `events-YYYY-MM-DD.jsonl` | one line per action: `tx`, `order`, `swap`, `deposit`, `withdrawal`, `rebalance` (start/done/failed/urgent/paused), `alert`, `error`, `command` |

pm2 also keeps `~/.pm2/logs/kdn-watch-{out,error}.log`.

---

## Telegram

The bot long-polls `getUpdates` inside `watch` and answers **only**
`TELEGRAM_CHAT_ID`.

| Command | Reply |
|---|---|
| `/balance` | live: wallet vbUSDC, vbETH, margin, short + entry, net delta, leverage, liquidation, total value, basis, gas |
| `/pnl` | capital in, value, PnL before/after exit cost, funding vs expected, APR, cost breakdown |
| `/funding` | current rate, annualized, time to next settlement, last 5 payments |
| `/status` | uptime, last full/risk check, leverage, stop on exchange, auto mode (ON/off/PAUSED), rebalances in 24 h, active alerts |
| `/pause`, `/resume` | stop / allow automatic rebalancing (watching and alerts continue) |
| `/help` | list |

Nothing can trade through Telegram. Alerts and rebalance notices are pushed to the same chat.

---

## Configuration

`.env` (copy `.env.example`). Required: `WALLET_ADDRESS`, `KP_API_KEY`, `KP_API_SECRET`;
`WALLET_PRIVATE_KEY` for anything that trades.

| Variable | Default | Meaning |
|---|---|---|
| `KATANA_RPC_URL` | `https://rpc.katana.network` | Katana RPC |
| `DB_PATH` / `LOG_DIR` | `data/bot.db` / `data/logs` | storage |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | — | alerts + commands (stdout only if unset) |
| `WATCH_INTERVAL_MIN` | 5 | full check interval |
| `RISK_CHECK_INTERVAL_SEC` | 15 | fast risk check interval |
| `AUTO_REBALANCE` | false | `watch` executes rebalances itself |
| `MAX_AUTO_REBALANCES_PER_DAY` | 6 | auto mode pauses above this |
| `TARGET_LEVERAGE` | 2 | short notional / margin |
| `MIN_LEVERAGE`, `MAX_LEVERAGE` | 1.5, 2.5 | rebalance band |
| `RESERVE_PCT` | 5 | wallet reserve, % of capital |
| `REBALANCE_BAND_PCT` | 10 | re-size when spot is this % off target |
| `MIN_TRADE_USD` | 5 | ignore smaller moves |
| `ALERT_DELTA_PCT` | 2 | leg drift that triggers a hedge |
| `URGENT_DELTA_PCT` | 5 | leg drift alerted as 🚨 urgent |
| `MIN_GROW_FUNDING_RATE` | 0.00005 | don't add size under this 8h rate |
| `AVG_FUNDING_PERIODS` | 6 | unwind when this many latest settlements average < 0 |
| `ALERT_LEVERAGE` | 3 | leverage warning |
| `ALERT_BASIS_PCT` | 0.5 | Sushi vs index warning (and grow refusal) |
| `ALLOW_WITHDRAW` | false | rebalancer may withdraw excess margin |
| `PROTECTIVE_STOP` | true | maintain the exchange-side stop (auto mode / manual rebalance) |
| `STOP_BELOW_LIQ_PCT` | 15 | stop trigger under liquidation |
| `SWAP_ROUTING` | direct | `direct` or `search` |
| `MAX_CHUNK_USD` | 250 | largest single spot buy |
| `MAX_SLIPPAGE_BPS` | 30 | swap reverts if worse than quote by this |
| `MAX_SPOT_IMPACT_PCT` | 0.5 | skip a buy quoted this far above index |

Fixed thresholds (`DEFAULT_THRESHOLDS` in `packages/core/src/risk.ts`): kill leverage 4x, kill basis
1%, peg check 0.3%, unwind after 3 negative funding periods, liquidation alert within 20%, minimum
gas 0.0005 ETH.

---

## Operations

### Hosts

A small Linux VPS is enough: Ubuntu 24.04 LTS, 1 vCPU, 1 GB RAM + 1 GB swap, firewall allowing SSH only.
The deploy scripts reach it through an SSH alias set in `DEPLOY_HOST`.

On the host the bot runs as user **`kdn`** in `/home/kdn/app`, with its own Node 24
(`~/.local/node`) and pm2; `pm2-kdn` (systemd) starts it on boot. `.env` is mode 600, owned by `kdn`.

### Deploy and operate (from your PC)

```sh
scripts/deploy.sh            # tar working tree → rsync to /home/kdn/app → npm ci → typecheck → test → pm2 reload
scripts/deploy.sh --env      # same, plus upload .env (never goes through git)
scripts/remote.sh report     # any bot command on the host
scripts/remote.sh rebalance --go
scripts/remote.sh pm2 logs kdn-watch --lines 50 --nostream
DEPLOY_HOST=my-host scripts/remote.sh report       # target another host
```

`node_modules`, `data/` and `.env` on the host are never overwritten by a code deploy.

### On the host (as root, e.g. DigitalOcean web console)

```sh
kdn status        # pm2 status          kdn logs 100     # recent console output
kdn follow        # live output          kdn restart      # restart the bot
kdn report        # PnL + hypotheses     kdn rebalance    # dry-run plan (add --go)
kdn pause / kdn resume                   kdn cancel-orders
```

Run trades and `watch` **only on the host**; a second copy would split the database, ledger and logs
and fight over Telegram updates.

### Fresh host setup

swap file → `ufw allow OpenSSH && ufw enable` → `useradd kdn` → Node 24 tarball (checksum-verified) into
`/home/kdn/.local/node` → `npm i -g pm2` → `pm2 startup systemd -u kdn` → copy `data/` →
`scripts/deploy.sh --env` → install `scripts/kdn` as `/usr/local/bin/kdn` → verify a non-filling
post-only order is accepted before moving money.

---

## CLI reference

`npm run bot -- <command>` locally, `kdn <command>` on the host. Trading commands are dry runs
unless `--go`.

| Command | What it does |
|---|---|
| `market` | live price, Sushi basis, funding, margin params, liquidation table (no credentials) |
| `routes buy <usdc>` / `routes sell <eth>` | quote Sushi routes (no credentials) |
| `snapshot` | snapshot both legs, alerts, report |
| `sync` | fills, funding payments/rates, new swaps |
| `report` | PnL, funding, costs, H1–H6 |
| `costs [usd …]` | cost ledger + round-trip cost at each size |
| `logs [n]` | last n logged actions |
| `watch` | the monitoring/rebalancing loop |
| `capital <usd> [note]` | record capital in (+) / out (−) |
| `log-swap <tx>` | record a past swap |
| `rebalance [--go]` | plan from total capital and move to target |
| `exit [--go]` | close the short and sell all vbETH |
| `hedge [--go]` | resize the short to the vbETH held |
| `protect [--go]` | place/refresh the protective stop |
| `cancel-orders [--go]` | list / cancel all open perp orders |
| `swap buy <usdc>` / `swap sell <eth> [--go]` | single swap |
| `deposit <usd> [--go]` / `withdraw <usd> [--go]` | move margin |
| `pause [reason]` / `resume` | automatic rebalancing off / on |

---

## Security model

- **Keys:** `.env` holds the wallet private key, API key/secret and Telegram token. It is gitignored
  (`.env*` except `.env.example`), copied to the host only over SSH, mode 600, owned by `kdn`.
- **Dedicated wallet and API key:** the strategy wallet holds only strategy funds; its Katana Perps
  API key is linked to that wallet alone.
- **No secrets in logs:** errors are logged by message only (SDK errors carry request headers
  containing the API key).
- **Telegram** answers one chat id and cannot trade.
- **Host isolation:** separate `kdn` user, own Node and pm2; firewall allows SSH only; SSH key auth
  (`~/.ssh/kdn_droplet`).
- **Not yet:** delegated trading key for perp orders, hardware/KMS signing, heartbeat monitor.

---

## Development

```sh
npm install
npm run typecheck      # tsc over all workspaces
npm test               # node:test via tsx (packages/*/test)
npm run market         # smoke test against mainnet, no credentials
```

Rules: `packages/core` stays pure; `packages/katana` stays free of fs/native modules (both must run
inside Circuit later). Commits carry no AI co-author lines and are GPG-signed by the user.

---

## Known limitations

- **Spot liquidity** is the scaling limit, not the perp book (≤0.014% even at $100k). Entering and
  exiting at 2x with one Sushi swap per leg, against funding at 0.01%/8h (measured 2026-10-21):

  | Capital | Round trip | bps of spot | Breakeven | APR if exited after 30 days |
  |---|---|---|---|---|
  | $300 | $0.35 | 18 | 6 days | 5.5% |
  | $1k | $1.75 | 28 | 9 days | 4.8% |
  | $5k | $25 | 80 | 27 days | 0.7% |
  | $10k | $79 | 126 | 42 days | −2.8% |
  | $100k | $1,746 | 304 | 101 days | −15% |

  Above ~$5k, spot has to be built and unwound slowly (spaced chunks so arbitrage refills the pool),
  held for months, or routed through deeper liquidity. `npm run bot -- costs` re-measures this live.
- **Public RPC** rate-limits heavy `eth_call` use; `search` routing needs a keyed RPC.
- **Polling, not streaming:** 15 s risk checks; WebSocket feeds are on the roadmap.
- **No heartbeat:** if the host dies, Telegram goes quiet; the exchange-side stop still protects
  the short.
- **Evergreen routing** (app.katana.network's default) isn't a route source yet.
- **Geo-restriction:** perp trading only works from hosts (and for operators) Katana Perps permits.

## WBTC carry bot

A second strategy in `apps/wbtc`, scoped in the "WBTC Carry Bot — Scope" doc. You deposit WBTC and get
more WBTC out. The deposit sits as Morpho collateral (vbWBTC/vbUSDC, LLTV 86%). The bot borrows vbUSDC
against it, buys an extra slice of vbWBTC (also collateral) and shorts exactly the slice on BTC-USD. Net
BTC stays equal to the deposit; funding on the short minus interest on the debt is the yield, in BTC.

- **Sizing (Config A):** 40% LTV on all collateral, slice hedged at 3.3x → slice 44.3% of the deposit,
  debt 57.7%, margin 13.4%. Yield = x·F − l(1+x)·r; break-even borrow APY F / (1 + 1/k) ≈ 8.4–8.6%.
- **Rebalancing:** Kind 1 moves USDC between Morpho and the perp account when perp leverage leaves
  2.5–4.5x (one move restores leverage and LTV together). Kind 2 resizes the slice on Sushi (entry, added
  deposit, LTV < 30%, halving after 24h of borrow APY ≥ 7%). Kind 3 is the liquidation ladder: shrink at
  9.8x perp leverage or 60% LTV, unwind at 70% LTV, borrow APY ≥ 10% or 3 negative funding periods.
  Shrinks close the short and sell the same vbWBTC in LTV-safe chunks, so they never wait on a perp
  withdrawal. Exchange stop 5% below liquidation.
- **Isolation:** its own `.env.wbtc` (see `.env.wbtc.example`), wallet, Katana Perps API key, database
  (`data/wbtc/wbtc.db`) and logs (`data/wbtc/logs`). Telegram is send-only with a `[WBTC]` prefix.
  Deployed to `/home/kdn/wbtc` as pm2 process `kdn-wbtc` by `scripts/deploy-wbtc.sh`, so it never
  restarts the ETH bot.
- **Without a wallet** it runs only the market tracker: every 15 min it records funding, Morpho borrow
  APY, utilization, free liquidity, oracle and Sushi prices, the Sushi cost of the modeled slice and the
  model yield.

```
npm run wbtc -- track | model | report | status | watch
npm run wbtc -- deposit <btc> [--go]      # supply wallet vbWBTC, record it as target net BTC
npm run wbtc -- rebalance [--go]          # entry, margin moves, resize, ladder
npm run wbtc -- exit [--go]               # unwind the slice; deposit stays on Morpho
npm run wbtc -- withdraw-btc <btc|all> [--go]
kdn wbtc report                           # on the droplet as root
```
