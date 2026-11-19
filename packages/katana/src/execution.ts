import type { Address, Hex } from "viem";

export interface TxRequest {
  to: Address;
  data: Hex;
  value?: bigint;
}

/**
 * Sends a transaction from the strategy wallet and resolves once it is mined, throwing if it
 * reverted. The bot implements this with a viem wallet client; a Circuit agent would use
 * wallet.transactions.create.
 */
export interface TxExecutor {
  readonly address: Address;
  send(request: TxRequest, label: string): Promise<{ hash: Hex }>;
}
