export const CHAIN_ID = 747474;
export const MARKET = "ETH-USD";
export const BTC_MARKET = "BTC-USD";

export const ADDRESSES = {
  perpsExchange: "0x62230CeA619F734cc215bB8074bbF07bE4Eb633e",
  vbUSDC: "0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36",
  vbETH: "0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62",
  sushiV3Factory: "0x203e8740894c8955cB8950759876d7E7E45E04c1",
  sushiV3SwapRouter: "0x4e1d81A3E627b9294532e990109e4c21d217376C",
  sushiV3QuoterV2: "0x92dea23ED1C683940fF1a2f8fE23FE98C5d3041c",
  vbWBTC: "0x0913DA6Da4b42f538B445599b46Bb4622342Cf52",
  morphoBlue: "0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc",
} as const;

export const DECIMALS = { vbUSDC: 6, vbETH: 18, vbWBTC: 8 } as const;

/** Morpho Blue vbWBTC collateral / vbUSDC loan market (LLTV 86%). */
export const WBTC_MORPHO_MARKET = "0xcd2dc555dced7422a3144a4126286675449019366f83e9717be7c2deb3daae3e" as const;

/** Deepest vbUSDC/vbETH pool on Sushi V3. Used as the price reference for basis checks. */
export const SUSHI_FEE_TIER = 500;

export const SUSHI_V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

/** Intermediate tokens tried for two-hop routes between vbUSDC and vbETH. */
export const HOP_TOKENS = {
  USDT: "0x2DCa96907fde857dd3D816880A0df407eeB2D2F2",
  AUSD: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
  USDS: "0x62D6A123E8D19d06d68cf0d2294F9A3A0362c6b3",
  wstETH: "0x7Fb4D0f51544F24F385a421Db6e7D4fC71Ad8e5C",
  weETH: "0x9893989433e7a383Cb313953e4c2365107dc19a7",
  WBTC: "0x0913DA6Da4b42f538B445599b46Bb4622342Cf52",
} as const;

/** Funding settles at 00:00, 08:00 and 16:00 UTC. */
export const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
