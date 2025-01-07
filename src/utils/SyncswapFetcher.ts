//!!! DEPRECATED !!!

import { ERC20_Transfer_event, handlerContext } from "generated";
import { Address, getContract } from "viem";
import { client } from "../viem/Client";
import { SyncswapPoolABI } from "../abi/SyncswapPool";

const THRESHOLD_BLOCK_NUMBER = 52500000;

export const SyncswapPoolsToFetchShare = new Set<Address>();

class SyncswapShareFetcher {
  latestHandledBlock = 0;
  syncInterval = 86400;
  asyncInterval = 1000000;

  public async genSyncswapPoolShares(
    context: handlerContext,
    event: ERC20_Transfer_event
  ): Promise<void> {
    const interval =
      event.block.number > THRESHOLD_BLOCK_NUMBER ? this.syncInterval : this.asyncInterval;
    if (event.block.number <= this.latestHandledBlock + interval) {
      return;
    }
    if (SyncswapPoolsToFetchShare.size == 0) {
      return;
    }

    this.latestHandledBlock = event.block.number;

    const poolList = Array.from(SyncswapPoolsToFetchShare);
    context.log.info("Fetching Sync shares for " + poolList.length + " pools");
    for (let address of poolList) {
      const pool = await context.SyncswapPool.get(address);
      const contract = getContract({ address, abi: SyncswapPoolABI, client });
      const [reserves, totalSupply, token0Precision, token1Precision] = await client.multicall({
        contracts: [
          { ...contract, functionName: "getReserves" },
          { ...contract, functionName: "totalSupply" },
          { ...contract, functionName: "token0PrecisionMultiplier" },
          { ...contract, functionName: "token1PrecisionMultiplier" },
        ],
      });
      const price = calculateLPTokenPrice(
        (reserves.result as Array<bigint>)[0],
        totalSupply.result as bigint,
        pool?.poolType as bigint,
        token0Precision.result as bigint
      );
      const price2 = calculateLPTokenPrice(
        (reserves.result as Array<bigint>)[1],
        totalSupply.result as bigint,
        pool?.poolType as bigint,
        token1Precision.result as bigint
      );
      context.SyncswapPool.set({
        id: address,
        address,
        name: pool?.name,
        symbol: pool?.symbol,
        poolType: pool?.poolType,
        underlyingToken_id: pool?.underlyingToken_id,
        underlyingToken2_id: pool?.underlyingToken2_id,
        reserve0: (reserves.result as Array<bigint>)[0],
        reserve1: (reserves.result as Array<bigint>)[1],
        totalSupply: totalSupply.result as bigint,
        token0PrecisionMultiplier: token0Precision.result as bigint,
        token1PrecisionMultiplier: token1Precision.result as bigint,
      });
    }
  }
}

function calculateLPTokenPrice(
  reserve0: bigint,
  totalSupply: bigint,
  poolType: bigint,
  token0PrecisionMultiplier: bigint = 1n
) {
  if (totalSupply === 0n) return 0n;

  // Convert to BigInt
  reserve0 = BigInt(reserve0);
  totalSupply = BigInt(totalSupply);

  if (poolType === 1n) {
    // Classic Pool
    // Each LP token represents a proportional share of the reserves
    return (reserve0 * BigInt(1e18)) / totalSupply;
  } else if (poolType === 2n) {
    // Stable Pool
    // Adjust reserves using precision multipliers
    const adjustedReserve0 = reserve0 * token0PrecisionMultiplier;
    return (adjustedReserve0 * BigInt(1e18)) / (totalSupply * token0PrecisionMultiplier);
  }

  throw new Error("Invalid pool type");
}

export const syncswapShareFetcher = new SyncswapShareFetcher();
