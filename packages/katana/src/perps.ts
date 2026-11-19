import { CandleInterval, RestAuthenticatedClient, RestPublicClient } from "@katanaperps/katana-perps-sdk";
import type { BookSide, FundingPayment, FundingRate, PerpFill } from "@kdn/core";
import { v1 as uuidv1 } from "uuid";
import { MARKET as DEFAULT_MARKET } from "./constants";

export interface PerpsReaderOptions {
  apiKey: string;
  apiSecret: string;
  wallet: string;
  sandbox?: boolean;
  /** Perp market traded; defaults to ETH-USD. */
  market?: string;
}

export interface PerpsAccount {
  equity: number;
  leverage: number;
  marginRatio: number;
  freeCollateral: number;
  position:
    | {
        qty: number; // signed, negative = short
        entryPrice: number;
        markPrice: number;
        indexPrice: number;
        liquidationPrice: number;
        totalFunding: number;
      }
    | undefined;
  /** Positions in any other market. The account is cross-margin, so these share our margin. */
  otherPositions: { market: string; qty: number }[];
}

export interface OpenOrder {
  orderId: string;
  market: string;
  type: string;
  side: "buy" | "sell";
  qty: number;
  price?: number;
  triggerPrice?: number;
}

export interface PerpsMarketInfo {
  indexPrice: number;
  markPrice: number;
  currentFundingRate: number;
  nextFundingTime: number;
  initialMarginFraction: number;
  maintenanceMarginFraction: number;
  makerFeeRate: number;
  takerFeeRate: number;
}

const PAGE = 500;
/** User-data endpoints allow ~1 request/second per key. */
export const AUTH_MIN_INTERVAL_MS = 1_100;
const PUBLIC_MIN_INTERVAL_MS = 150;
const RATE_LIMIT_RETRIES = 6;

type Range = { start?: number; end?: number; limit: number };

/** Drops undefined keys: the SDK signs every key it is given, so an undefined one breaks the HMAC (401). */
function defined(range: Range): Range {
  return Object.fromEntries(Object.entries(range).filter(([, v]) => v !== undefined)) as Range;
}

/** Runs authenticated calls one at a time, spaced out, retrying on HTTP 429. */
export function createThrottle(minIntervalMs: number) {
  let chain: Promise<unknown> = Promise.resolve();
  let last = 0;
  return function throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        const wait = last + minIntervalMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        try {
          return await fn();
        } catch (err) {
          const status = (err as { response?: { status?: number } }).response?.status;
          if (status !== 429 || attempt >= RATE_LIMIT_RETRIES) throw err;
          last = Date.now() + minIntervalMs * 2 ** attempt;
        }
      }
    };
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  };
}

/** Pages backwards through an endpoint that returns newest-first results bounded by start/end. */
async function collect<T extends { time: number }>(
  fetchPage: (range: Range) => Promise<T[]>,
  start?: number,
): Promise<T[]> {
  const out: T[] = [];
  let end: number | undefined;
  for (;;) {
    const page = await fetchPage(defined({ start, end, limit: PAGE }));
    out.push(...page);
    if (page.length < PAGE) break;
    const oldest = Math.min(...page.map((p) => p.time));
    end = oldest - 1;
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Read-only access to Katana Perps. Needs an API key, never a private key. */
export function createPerpsReader(opts: PerpsReaderOptions) {
  const MARKET = opts.market ?? DEFAULT_MARKET;
  const auth = new RestAuthenticatedClient({ apiKey: opts.apiKey, apiSecret: opts.apiSecret, sandbox: opts.sandbox });
  const pub = new RestPublicClient({ apiKey: opts.apiKey, sandbox: opts.sandbox });
  const byWallet = () => ({ wallet: opts.wallet, nonce: uuidv1() });
  const throttled = createThrottle(AUTH_MIN_INTERVAL_MS);

  return {
    async account(): Promise<PerpsAccount> {
      const [w] = await throttled(() => auth.getWallets({ ...byWallet(), includePositions: true }));
      if (!w) throw new Error(`Wallet ${opts.wallet} is not associated with Katana Perps`);
      const p = w.positions?.find((x) => x.market === MARKET);
      return {
        equity: Number(w.equity),
        leverage: Number(w.leverage),
        marginRatio: Number(w.marginRatio),
        freeCollateral: Number(w.freeCollateral),
        otherPositions: (w.positions ?? [])
          .filter((x) => x.market !== MARKET && Number(x.quantity) !== 0)
          .map((x) => ({ market: x.market, qty: Number(x.quantity) })),
        position: p && {
          qty: Number(p.quantity),
          entryPrice: Number(p.entryPrice),
          markPrice: Number(p.markPrice),
          indexPrice: Number(p.indexPrice),
          liquidationPrice: Number(p.liquidationPrice),
          totalFunding: Number(p.totalFunding),
        },
      };
    },

    /** Open (and untriggered conditional) orders in every market. */
    async openOrders(): Promise<OpenOrder[]> {
      const orders = await throttled(() => auth.getOrders({ ...byWallet(), limit: 100 }));
      return orders
        .filter((o) => ["open", "active", "partiallyFilled"].includes(o.status))
        .map((o) => ({
          orderId: o.orderId,
          market: o.market,
          type: o.type,
          side: o.side,
          qty: Number(o.originalQuantity) - Number(o.executedQuantity),
          price: o.price === undefined ? undefined : Number(o.price),
          triggerPrice: o.triggerPrice === undefined ? undefined : Number(o.triggerPrice),
        }));
    },

    async fundingPayments(start?: number): Promise<FundingPayment[]> {
      const rows = await collect(
        (range) => throttled(() => auth.getFundingPayments({ ...byWallet(), market: MARKET, ...range })),
        start,
      );
      return rows.map((r) => ({
        time: r.time,
        market: r.market,
        paymentUsd: Number(r.paymentQuantity),
        positionQty: Number(r.positionQuantity),
        rate: Number(r.fundingRate),
        indexPrice: Number(r.indexPrice),
      }));
    },

    async fills(start?: number): Promise<PerpFill[]> {
      const rows = await collect((range) => throttled(() => auth.getFills({ ...byWallet(), market: MARKET, ...range })), start);
      return rows.map((f) => ({
        fillId: f.fillId,
        time: f.time,
        side: f.side,
        price: Number(f.price),
        qty: Number(f.quantity),
        quoteQty: Number(f.quoteQuantity),
        feeUsd: Number(f.fee ?? 0),
        indexPrice: f.indexPrice === undefined ? undefined : Number(f.indexPrice),
      }));
    },

    ...createPerpsPublicReader(pub, MARKET),
  };
}

/** Public market data. Works without any credentials. */
export function createPerpsPublicReader(pub = new RestPublicClient(), MARKET = DEFAULT_MARKET) {
  // Public endpoints allow ~5–10 requests/second; space them and retry on 429 like the user-data calls.
  const throttled = createThrottle(PUBLIC_MIN_INTERVAL_MS);
  return {
    async market(): Promise<PerpsMarketInfo> {
      const [[m], [t]] = await Promise.all([
        throttled(() => pub.getMarkets({ market: MARKET })),
        throttled(() => pub.getTickers({ market: MARKET })),
      ]);
      if (!m || !t) throw new Error(`Market ${MARKET} not found`);
      return {
        indexPrice: Number(m.indexPrice),
        markPrice: Number(t.markPrice ?? m.indexPrice),
        currentFundingRate: Number(m.currentFundingRate),
        nextFundingTime: m.nextFundingTime,
        initialMarginFraction: Number(m.initialMarginFraction),
        maintenanceMarginFraction: Number(m.maintenanceMarginFraction),
        makerFeeRate: Number(m.makerFeeRate),
        takerFeeRate: Number(m.takerFeeRate),
      };
    },

    async fundingRates(start?: number): Promise<FundingRate[]> {
      const rows = await collect(
        async (range) => (await throttled(() => pub.getFundingRates({ market: MARKET, ...range }))).map((r) => ({ ...r, time: r.time })),
        start,
      );
      return rows.map((r) => ({ time: r.time, rate: Number(r.fundingRate), indexPrice: Number(r.indexPrice) }));
    },

    /** Level-2 order book, best levels first, as [price, quantity] in numbers. */
    async orderBook(limit = 500): Promise<{ bids: BookSide; asks: BookSide; markPrice: number; indexPrice: number }> {
      const book = await throttled(() => pub.getOrderBookLevel2({ market: MARKET, limit }));
      const side = (levels: ReadonlyArray<readonly [string, string, ...unknown[]]>) =>
        levels.map(([price, qty]) => [Number(price), Number(qty)] as const);
      return {
        bids: side(book.bids),
        asks: side(book.asks),
        markPrice: Number(book.markPrice),
        indexPrice: Number(book.indexPrice),
      };
    },

    /** Perp 1-minute close nearest to `time`, used as the reference price for swaps. */
    async priceAt(time: number): Promise<number> {
      const candles = await throttled(() =>
        pub.getCandles({
          market: MARKET,
          interval: CandleInterval.ONE_MINUTE,
          start: time - 120_000,
          end: time + 120_000,
        }),
      );
      if (candles.length === 0) {
        // The current minute's candle may not exist yet; for a swap that just happened, index is as good.
        if (Date.now() - time < 10 * 60_000) return (await this.market()).indexPrice;
        throw new Error(`No candles around ${new Date(time).toISOString()}`);
      }
      const nearest = candles.reduce((a, b) => (Math.abs(b.start - time) < Math.abs(a.start - time) ? b : a));
      return Number(nearest.close);
    },
  };
}

export type PerpsReader = ReturnType<typeof createPerpsReader>;
export type PerpsPublicReader = ReturnType<typeof createPerpsPublicReader>;
