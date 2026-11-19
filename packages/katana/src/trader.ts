import { BridgeTarget, OrderType, RestAuthenticatedClient, type SignTypedData } from "@katanaperps/katana-perps-sdk";
import { v1 as uuidv1 } from "uuid";
import { encodeFunctionData, parseAbi, parseUnits, zeroAddress } from "viem";
import type { ChainReader } from "./chain";
import { ADDRESSES, DECIMALS, MARKET as DEFAULT_MARKET } from "./constants";
import type { TxExecutor } from "./execution";
import { AUTH_MIN_INTERVAL_MS, createThrottle, type PerpsReader } from "./perps";
import { ensureAllowance } from "./spot";

const exchangeAbi = parseAbi(["function deposit(uint256 quantityInAssetUnits, address depositorWallet)"]);

const DEPOSIT_POLL_MS = 3_000;
const DEPOSIT_TIMEOUT_MS = 5 * 60_000;
const MAX_WITHDRAWAL_GAS_FEE_USD = 1;

export interface PerpsTraderOptions {
  apiKey: string;
  apiSecret: string;
  /** Signs orders and withdrawals. The bot uses a private-key signer; Circuit would use wallet.messages.sign. */
  signer: SignTypedData;
  sandbox?: boolean;
  /** Perp market traded; defaults to ETH-USD. */
  market?: string;
}

export interface OrderResult {
  orderId: string;
  status: string;
  executedQty: number;
  avgPrice: number;
}

export function createPerpsTrader(opts: PerpsTraderOptions, reader: PerpsReader, chain: ChainReader, exec: TxExecutor) {
  const auth = new RestAuthenticatedClient({ apiKey: opts.apiKey, apiSecret: opts.apiSecret, sandbox: opts.sandbox });
  const throttled = createThrottle(AUTH_MIN_INTERVAL_MS);
  const wallet = exec.address;
  const MARKET = opts.market ?? DEFAULT_MARKET;

  return {
    /** Deposits vbUSDC as margin and waits until the exchange credits it. */
    async deposit(usd: number): Promise<void> {
      const raw = parseUnits(usd.toFixed(DECIMALS.vbUSDC), DECIMALS.vbUSDC);
      const before = (await reader.account()).equity;
      await ensureAllowance(chain, exec, ADDRESSES.vbUSDC, ADDRESSES.perpsExchange, raw);
      await exec.send(
        {
          to: ADDRESSES.perpsExchange,
          data: encodeFunctionData({ abi: exchangeAbi, functionName: "deposit", args: [raw, zeroAddress] }),
        },
        `deposit ${usd.toFixed(2)} vbUSDC as perp margin`,
      );

      const deadline = Date.now() + DEPOSIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, DEPOSIT_POLL_MS));
        if ((await reader.account()).equity >= before + usd * 0.99) return;
      }
      throw new Error(`Deposit of $${usd.toFixed(2)} not credited after ${DEPOSIT_TIMEOUT_MS / 60_000} min`);
    },

    /** Market order on the trader's market (ETH-USD by default). The exchange caps execution at 0.3% from mark. */
    async marketOrder(side: "buy" | "sell", qty: number, reduceOnly = false): Promise<OrderResult> {
      const order = await throttled(() =>
        auth.createOrder(
          {
            wallet,
            nonce: uuidv1(),
            market: MARKET,
            type: OrderType.market,
            side,
            quantity: qty.toFixed(8),
            reduceOnly,
          },
          opts.signer,
        ),
      );
      if (order.errorCode) throw new Error(`Order rejected: ${order.errorCode} ${order.errorMessage ?? ""}`);
      return {
        orderId: order.orderId,
        status: order.status,
        executedQty: Number(order.executedQuantity),
        avgPrice: Number(order.avgExecutionPrice ?? 0),
      };
    },

    /** Our open and untriggered stop orders on the trader's market. */
    async openStops(): Promise<{ orderId: string; qty: number; triggerPrice: number }[]> {
      const orders = await throttled(() => auth.getOrders({ wallet, nonce: uuidv1(), market: MARKET, limit: 100 }));
      return orders
        .filter((o) => o.type === OrderType.stopLossMarket && o.side === "buy" && (o.status === "active" || o.status === "open"))
        .map((o) => ({ orderId: o.orderId, qty: Number(o.originalQuantity), triggerPrice: Number(o.triggerPrice) }));
    },

    /**
     * Reduce-only stop that buys back `qty` if the index price rises to `triggerPrice`.
     * It lives on the exchange, so it protects the short even when the bot is down.
     */
    async placeStop(qty: number, triggerPrice: number): Promise<string> {
      const order = await throttled(() =>
        auth.createOrder(
          {
            wallet,
            nonce: uuidv1(),
            market: MARKET,
            type: OrderType.stopLossMarket,
            side: "buy",
            quantity: qty.toFixed(8),
            // The API requires 8 decimal places on prices (e.g. "3145.10000000").
            triggerPrice: triggerPrice.toFixed(8),
            triggerType: "index",
            reduceOnly: true,
          },
          opts.signer,
        ),
      );
      if (order.errorCode) throw new Error(`Stop rejected: ${order.errorCode} ${order.errorMessage ?? ""}`);
      return order.orderId;
    },

    async cancelOrders(orderIds: string[]): Promise<void> {
      if (!orderIds.length) return;
      await throttled(() => auth.cancelOrders({ wallet, nonce: uuidv1(), orderIds }, opts.signer));
    },

    /**
     * Withdraws margin back to the wallet on Katana. Needs an API key with Withdraw scope.
     * Returns the gas fee (USD) the exchange deducted from the amount.
     */
    async withdraw(usd: number): Promise<{ gasFeeUsd: number; txHash: string | null }> {
      const maximumGasFee = await throttled(() =>
        auth.calculateWithdrawalMaximumGasFee({ bridgeTarget: BridgeTarget.KATANA_KATANA, maximumSlippagePercent: "0.10000000" }),
      );
      if (Number(maximumGasFee) > MAX_WITHDRAWAL_GAS_FEE_USD) {
        throw new Error(`Withdrawal gas fee $${maximumGasFee} is above $${MAX_WITHDRAWAL_GAS_FEE_USD}`);
      }
      const withdrawal = await throttled(() =>
        auth.withdraw(
          { wallet, nonce: uuidv1(), quantity: usd.toFixed(8), maximumGasFee, bridgeTarget: BridgeTarget.KATANA_KATANA },
          opts.signer,
        ),
      );
      return { gasFeeUsd: Number(withdrawal.gas), txHash: withdrawal.katanaTxId };
    },
  };
}

export type PerpsTrader = ReturnType<typeof createPerpsTrader>;
