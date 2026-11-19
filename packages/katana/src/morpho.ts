import { encodeFunctionData, formatUnits, parseAbi, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import type { ChainReader } from "./chain";
import { ADDRESSES } from "./constants";
import type { TxExecutor } from "./execution";
import { ensureAllowance } from "./spot";

const morphoAbi = parseAbi([
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function supplyCollateral((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, address onBehalf, bytes data)",
  "function withdrawCollateral((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, address onBehalf, address receiver)",
  "function borrow((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
  "function repay((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
]);
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
const irmAbi = parseAbi([
  "function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)",
]);

const WAD = 10n ** 18n;
const SECONDS_PER_YEAR = 365 * 86_400;
/** Morpho's share math adds these so the first depositor can't inflate the share price. */
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;

export interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface MorphoMarketState {
  /** Loan-token amounts in whole units (vbUSDC), interest accrued to now. */
  totalSupply: number;
  totalBorrow: number;
  available: number;
  utilization: number;
  /** Borrow APY as a fraction (0.034 = 3.4%), continuously compounded from the per-second rate. */
  borrowApy: number;
  lltv: number;
  /** Oracle price of one whole collateral token in loan-token units (USD per BTC). */
  oraclePrice: number;
}

export interface MorphoPosition {
  /** Collateral in whole collateral-token units (BTC). */
  collateral: number;
  /** Debt in whole loan-token units (USD), interest accrued to now. */
  debt: number;
  borrowShares: bigint;
  collateralRaw: bigint;
}

function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y + d - 1n) / d;
}

/** Morpho's wTaylorCompounded: e^(rate·t) − 1 to three terms, in WAD. */
function taylorCompounded(ratePerSecond: bigint, seconds: bigint): bigint {
  const first = ratePerSecond * seconds;
  const second = (first * first) / (2n * WAD);
  const third = (second * first) / (3n * WAD);
  return first + second + third;
}

/**
 * Morpho Blue reader and transactions for one market. Reads accrue interest to the current time
 * (Morpho itself only accrues on interaction), so debt and utilization match what a repay would see.
 */
export function createMorphoMarket(chain: ChainReader, marketId: Hex, loanDecimals: number, collateralDecimals: number) {
  const client = chain.client as PublicClient;
  const morpho = ADDRESSES.morphoBlue;
  let params: MarketParams | undefined;

  async function marketParams(): Promise<MarketParams> {
    if (!params) {
      const [loanToken, collateralToken, oracle, irm, lltv] = await client.readContract({
        address: morpho,
        abi: morphoAbi,
        functionName: "idToMarketParams",
        args: [marketId],
      });
      params = { loanToken, collateralToken, oracle, irm, lltv };
    }
    return params;
  }

  const loan = (raw: bigint) => Number(formatUnits(raw, loanDecimals));

  /** Raw market totals with interest accrued to `now`, plus the per-second borrow rate. */
  async function accruedMarket(now = BigInt(Math.floor(Date.now() / 1000))) {
    const p = await marketParams();
    const m = await client.readContract({ address: morpho, abi: morphoAbi, functionName: "market", args: [marketId] });
    const [supplyAssets, supplyShares, borrowAssets, borrowShares, lastUpdate, fee] = m;
    const rate = await client.readContract({
      address: p.irm,
      abi: irmAbi,
      functionName: "borrowRateView",
      args: [p, { totalSupplyAssets: supplyAssets, totalSupplyShares: supplyShares, totalBorrowAssets: borrowAssets, totalBorrowShares: borrowShares, lastUpdate, fee }],
    });
    const elapsed = now > lastUpdate ? now - lastUpdate : 0n;
    const interest = (borrowAssets * taylorCompounded(rate, elapsed)) / WAD;
    return { supplyAssets: supplyAssets + interest, borrowAssets: borrowAssets + interest, borrowShares, rate };
  }

  async function state(accrued?: Awaited<ReturnType<typeof accruedMarket>>): Promise<MorphoMarketState> {
    const p = await marketParams();
    const [m, price] = await Promise.all([
      accrued ?? accruedMarket(),
      client.readContract({ address: p.oracle, abi: oracleAbi, functionName: "price" }),
    ]);
    const supply = loan(m.supplyAssets);
    const borrow = loan(m.borrowAssets);
    return {
      totalSupply: supply,
      totalBorrow: borrow,
      available: supply - borrow,
      utilization: supply > 0 ? borrow / supply : 0,
      borrowApy: Math.expm1((Number(m.rate) / 1e18) * SECONDS_PER_YEAR),
      lltv: Number(p.lltv) / 1e18,
      // Morpho oracles quote 1 raw collateral unit in raw loan units, scaled by 1e36.
      oraclePrice: (Number(price) / 1e36) * 10 ** (collateralDecimals - loanDecimals),
    };
  }

  async function position(user: Address, accrued?: Awaited<ReturnType<typeof accruedMarket>>): Promise<MorphoPosition> {
    const [[, borrowShares, collateral], m] = await Promise.all([
      client.readContract({ address: morpho, abi: morphoAbi, functionName: "position", args: [marketId, user] }),
      accrued ?? accruedMarket(),
    ]);
    const debtRaw = mulDivUp(borrowShares, m.borrowAssets + VIRTUAL_ASSETS, m.borrowShares + VIRTUAL_SHARES);
    return {
      collateral: Number(formatUnits(collateral, collateralDecimals)),
      debt: loan(debtRaw),
      borrowShares,
      collateralRaw: collateral,
    };
  }

  /** Market state and `user`'s position from one read of the market totals. */
  async function read(user: Address): Promise<{ state: MorphoMarketState; position: MorphoPosition }> {
    const accrued = await accruedMarket();
    const [st, pos] = await Promise.all([state(accrued), position(user, accrued)]);
    return { state: st, position: pos };
  }

  return { marketId, marketParams, state: () => state(), position: (user: Address) => position(user), read };
}

export type MorphoMarket = ReturnType<typeof createMorphoMarket>;

/** Signed Morpho actions for the strategy wallet, always on its own behalf. */
export function createMorphoTrader(market: MorphoMarket, chain: ChainReader, exec: TxExecutor, loanDecimals: number, collateralDecimals: number) {
  const morpho = ADDRESSES.morphoBlue;
  const me = exec.address;
  const send = async (data: Hex, label: string) => exec.send({ to: morpho, data }, label);
  const tuple = () => market.marketParams();

  return {
    /** Supplies `amount` collateral (whole units) from the wallet, capped at what it holds. */
    async supplyCollateral(amount: number) {
      const p = await market.marketParams();
      const held = await chain.tokenBalance(p.collateralToken, me);
      const wanted = parseUnits(amount.toFixed(collateralDecimals), collateralDecimals);
      const raw = wanted > held ? held : wanted;
      if (raw === 0n) throw new Error("No collateral in the wallet to supply");
      await ensureAllowance(chain, exec, p.collateralToken, morpho, raw);
      const data = encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [await tuple(), raw, me, "0x"] });
      await send(data, `supply ${formatUnits(raw, collateralDecimals)} collateral to Morpho`);
      return Number(formatUnits(raw, collateralDecimals));
    },

    async withdrawCollateral(amount: number) {
      const raw = parseUnits(amount.toFixed(collateralDecimals), collateralDecimals);
      const data = encodeFunctionData({ abi: morphoAbi, functionName: "withdrawCollateral", args: [await tuple(), raw, me, me] });
      await send(data, `withdraw ${formatUnits(raw, collateralDecimals)} collateral from Morpho`);
    },

    async borrow(usd: number) {
      const raw = parseUnits(usd.toFixed(loanDecimals), loanDecimals);
      const data = encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [await tuple(), raw, 0n, me, me] });
      await send(data, `borrow ${usd.toFixed(2)} vbUSDC from Morpho`);
    },

    /**
     * Repays up to `usd` from wallet vbUSDC. When that covers the whole debt it repays by shares,
     * so no dust of interest is left behind. Returns the USD amount repaid (approximate for full repays).
     */
    async repay(usd: number): Promise<number> {
      const p = await market.marketParams();
      const [pos, held] = await Promise.all([market.position(me), chain.tokenBalance(p.loanToken, me)]);
      if (pos.borrowShares === 0n) return 0;
      const wanted = parseUnits(usd.toFixed(loanDecimals), loanDecimals);
      const available = wanted > held ? held : wanted;
      // Interest keeps accruing between the read and the block; leave a little headroom on a full repay.
      const fullRaw = parseUnits((pos.debt * 1.0001 + 0.01).toFixed(loanDecimals), loanDecimals);
      const full = available >= fullRaw;
      if (available === 0n) throw new Error("No vbUSDC in the wallet to repay with");
      await ensureAllowance(chain, exec, p.loanToken, morpho, full ? fullRaw : available);
      const data = full
        ? encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [await tuple(), 0n, pos.borrowShares, me, "0x"] })
        : encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [await tuple(), available, 0n, me, "0x"] });
      await send(data, full ? `repay all Morpho debt (~${pos.debt.toFixed(2)} vbUSDC)` : `repay ${formatUnits(available, loanDecimals)} vbUSDC to Morpho`);
      return full ? pos.debt : Number(formatUnits(available, loanDecimals));
    },
  };
}

export type MorphoTrader = ReturnType<typeof createMorphoTrader>;
