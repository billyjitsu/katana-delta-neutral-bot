/** Point-in-time view of both legs. All prices USD per ETH, all quantities in ETH unless noted. */
export interface Snapshot {
  time: number; // unix ms
  indexPrice: number;
  markPrice: number;
  sushiPrice: number; // vbUSDC/vbETH pool mid
  spotEth: number; // vbETH held in the wallet
  walletUsdc: number; // vbUSDC held in the wallet (reserve)
  gasEth: number; // native ETH for gas, excluded from equity
  perpQty: number; // signed, negative = short
  perpEntryPrice: number;
  perpEquity: number; // USD, perp account equity incl. unrealized PnL
  perpLeverage: number;
  marginRatio: number;
  liquidationPrice: number; // 0 when no position
  perpTotalFunding: number; // USD, lifetime funding on the open position
}

export interface FundingPayment {
  time: number;
  market: string;
  paymentUsd: number; // positive = received
  positionQty: number;
  rate: number;
  indexPrice: number;
}

export interface FundingRate {
  time: number;
  rate: number;
  indexPrice: number;
}

export interface PerpFill {
  fillId: string;
  time: number;
  side: "buy" | "sell";
  price: number;
  qty: number;
  quoteQty: number;
  feeUsd: number;
  indexPrice?: number; // index at fill time, to measure slippage
}

/** An onchain vbUSDC <-> vbETH swap made by the strategy wallet. */
export interface SwapRecord {
  txHash: string;
  time: number;
  direction: "buy" | "sell"; // buy = USDC -> ETH
  ethAmount: number;
  usdcAmount: number;
  refPrice: number; // perp price at swap time, used to measure execution cost
  gasEth: number;
  route?: string; // e.g. "vbUSDC -0.05%-> vbETH", when the bot made the swap
  poolFeePct?: number; // total pool fee along the route, in %
}

/** A cost that isn't a swap or a perp fill: gas on approvals/deposits, withdrawal fees. */
export interface CostEntry {
  time: number;
  kind: "gas" | "withdrawal";
  label: string;
  usd: number;
  txHash?: string;
}

/** Money moved into (+) or out of (-) the strategy, in USD. */
export interface CapitalFlow {
  time: number;
  usd: number;
  note: string;
}

export interface Thresholds {
  alertLeverage: number;
  killLeverage: number;
  alertDeltaPct: number;
  /** Legs this far apart are urgent: something failed to hedge. */
  urgentDeltaPct: number;
  alertBasisPct: number;
  killBasisPct: number;
  pegBasisPct: number;
  killNegativeFundingPeriods: number;
  /** Unwind when the average of this many latest settlements is negative (catches alternating bleeds). */
  avgFundingPeriods: number;
  alertRallyToLiquidationPct: number;
  minGasEth: number;
}

export interface Alert {
  code: string;
  /** warn = look when convenient; urgent = look now; kill = unwind both legs. */
  level: "warn" | "urgent" | "kill";
  message: string;
}

/**
 * Persistence used by the strategy. The self-hosted bot implements it with SQLite;
 * a Circuit agent would implement it with agent.memory.
 */
export interface StateStore {
  saveSnapshot(s: Snapshot): Promise<void>;
  latestSnapshot(): Promise<Snapshot | undefined>;
  snapshots(since?: number): Promise<Snapshot[]>;
  saveFundingPayments(p: FundingPayment[]): Promise<void>;
  fundingPayments(): Promise<FundingPayment[]>;
  saveFundingRates(r: FundingRate[]): Promise<void>;
  fundingRates(since?: number): Promise<FundingRate[]>;
  saveFills(f: PerpFill[]): Promise<void>;
  fills(since?: number): Promise<PerpFill[]>;
  saveSwap(s: SwapRecord): Promise<void>;
  swaps(): Promise<SwapRecord[]>;
  addCapital(c: CapitalFlow): Promise<void>;
  capitalFlows(): Promise<CapitalFlow[]>;
  saveCost(c: CostEntry): Promise<void>;
  costs(): Promise<CostEntry[]>;
}
