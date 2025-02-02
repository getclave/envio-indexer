/**
 * SyncswapHandler.ts
 * Handles events from Syncswap DEX contracts, managing pool creation, liquidity changes,
 * and user balances for the Clave indexer.
 */

import {
  ERC20_Transfer_event,
  handlerContext,
  SyncswapEarnBalance,
  SyncswapFactory,
  SyncswapFactory_PoolCreated_event,
  SyncswapPool,
} from "generated";
import { Address, getContract } from "viem";
import { SyncswapPool_t } from "generated/src/db/Entities.gen";
import { SyncswapPoolABI } from "./abi/SyncswapPool";
import { client } from "./viem/Client";
import { SyncswapPools } from "./ERC20Handler";
import { ClaggMainAddress } from "./constants/ClaggAddresses";
import { getOrCreateClaggPool } from "./ClaggHandler";
import { syncswapCache } from "./utils/SyncswapCache";
import { roundTimestamp } from "./utils/helpers";

/**
 * Handles new pool creation events from the Syncswap Factory
 * Creates and stores pool data including token pairs and initial state
 */
SyncswapFactory.PoolCreated.handler(async ({ event, context }) => {
  await createPool(event, context);
  if (process.env.NODE_ENV == "test") {
    SyncswapPools.add(event.params.pool.toLowerCase() as Address);
    return;
  }
  await syncswapCache.addPool(event.params.pool.toLowerCase() as Address);
});

/**
 * Registers new Syncswap pools for dynamic contract tracking
 */
SyncswapFactory.PoolCreated.contractRegister(
  async ({ event, context }) => {
    context.addSyncswapPool(event.params.pool.toLowerCase() as Address);
  },
  { preRegisterDynamicContracts: true }
);

/**
 * Updates pool reserves when sync events occur
 * Tracks the current state of liquidity in the pool
 */
SyncswapPool.Sync.handler(async ({ event, context }) => {
  const syncPool = (await context.SyncswapPool.get(
    event.srcAddress.toLowerCase() as Address
  )) as SyncswapPool_t;

  const adjustedPool = {
    ...syncPool,
    reserve0: event.params.reserve0,
    reserve1: event.params.reserve1,
  };

  context.SyncswapPool.set(adjustedPool);
  context.HistoricalSyncswapPool.set({
    ...adjustedPool,
    id: adjustedPool.id + roundTimestamp(event.block.timestamp),
    timestamp: BigInt(roundTimestamp(event.block.timestamp)),
  });
});

/**
 * Handles liquidity addition events
 * Updates pool's total supply when new liquidity is added
 */
SyncswapPool.Mint.handler(async ({ event, context }) => {
  const syncPool = await getOrCreateSyncswapPool(
    event.srcAddress.toLowerCase() as Address,
    context
  );

  const adjustedPool = {
    ...syncPool,
    totalSupply: syncPool.totalSupply + event.params.liquidity,
  };

  context.SyncswapPool.set(adjustedPool);
  context.HistoricalSyncswapPool.set({
    ...adjustedPool,
    id: adjustedPool.id + roundTimestamp(event.block.timestamp),
    timestamp: BigInt(roundTimestamp(event.block.timestamp)),
  });
});

/**
 * Handles liquidity removal events
 * Updates pool's total supply when liquidity is removed
 */
SyncswapPool.Burn.handler(async ({ event, context }) => {
  const syncPool = await getOrCreateSyncswapPool(
    event.srcAddress.toLowerCase() as Address,
    context
  );

  const adjustedPool = {
    ...syncPool,
    totalSupply: syncPool.totalSupply - event.params.liquidity,
  };

  context.SyncswapPool.set(adjustedPool);
  context.HistoricalSyncswapPool.set({
    ...adjustedPool,
    id: adjustedPool.id + roundTimestamp(event.block.timestamp),
    timestamp: BigInt(roundTimestamp(event.block.timestamp)),
  });
});

/**
 * Handles LP token transfers for Syncswap pools
 * Updates user account balances when LP tokens are transferred
 * @param event The transfer event details
 * @param context The handler context for database operations
 * @param loaderReturn Contains pre-loaded data including Clave addresses
 */
export const SyncswapAccountHandler = async ({
  event,
  context,
  loaderReturn,
}: {
  event: ERC20_Transfer_event;
  context: handlerContext;
  loaderReturn: any;
}) => {
  try {
    const { claveAddresses } = loaderReturn as {
      claveAddresses: Set<string>;
    };

    if (event.params.from.toLowerCase() == ClaggMainAddress.toLowerCase()) {
      const pool = await getOrCreateClaggPool(event.srcAddress.toLowerCase() as Address, context);

      const adjustedPool = {
        ...pool,
        totalSupply: pool.totalSupply - event.params.value,
      };

      context.ClaggPool.set(adjustedPool);
      context.HistoricalClaggPool.set({
        ...adjustedPool,
        id: adjustedPool.id + roundTimestamp(event.block.timestamp),
        timestamp: BigInt(roundTimestamp(event.block.timestamp)),
      });
      return;
    }

    if (event.params.to.toLowerCase() == ClaggMainAddress.toLowerCase()) {
      const pool = await getOrCreateClaggPool(event.srcAddress.toLowerCase() as Address, context);

      const adjustedPool = {
        ...pool,
        totalSupply: pool.totalSupply + event.params.value,
      };

      context.ClaggPool.set(adjustedPool);
      context.HistoricalClaggPool.set({
        ...adjustedPool,
        id: adjustedPool.id + roundTimestamp(event.block.timestamp),
        timestamp: BigInt(roundTimestamp(event.block.timestamp)),
      });
      return;
    }

    const fromAddress = event.params.from.toLowerCase();
    const toAddress = event.params.to.toLowerCase();
    const poolAddress = event.srcAddress.toLowerCase();

    const [senderAccountBalance, receiverAccountBalance] = await Promise.all([
      context.SyncswapEarnBalance.get(fromAddress + poolAddress),
      context.SyncswapEarnBalance.get(toAddress + poolAddress),
    ]);

    await getOrCreateSyncswapPool(poolAddress as Address, context);

    if (claveAddresses.has(fromAddress)) {
      // Update sender's account balance
      let accountObject: SyncswapEarnBalance = {
        id: fromAddress + poolAddress,
        shareBalance:
          senderAccountBalance == undefined
            ? 0n - event.params.value
            : senderAccountBalance.shareBalance - event.params.value,
        userAddress: fromAddress,
        syncswapPool_id: poolAddress,
      };

      context.SyncswapEarnBalance.set(accountObject);
      context.HistoricalSyncswapEarnBalance.set({
        ...accountObject,
        id: accountObject.id + roundTimestamp(event.block.timestamp, 3600),
        timestamp: BigInt(roundTimestamp(event.block.timestamp, 3600)),
      });
    }

    if (claveAddresses.has(toAddress)) {
      // Update receiver's account balance
      let accountObject: SyncswapEarnBalance = {
        id: toAddress + poolAddress,
        shareBalance:
          receiverAccountBalance == undefined
            ? event.params.value
            : event.params.value + receiverAccountBalance.shareBalance,
        userAddress: toAddress,
        syncswapPool_id: poolAddress,
      };

      context.SyncswapEarnBalance.set(accountObject);
      context.HistoricalSyncswapEarnBalance.set({
        ...accountObject,
        id: accountObject.id + roundTimestamp(event.block.timestamp, 3600),
        timestamp: BigInt(roundTimestamp(event.block.timestamp, 3600)),
      });
    }
  } catch (error) {
    context.log.error(`Error in SyncswapAccountHandler: ${error}`);
    throw error;
  }
};

/**
 * Creates a new Syncswap pool entry in the database
 * Fetches pool details including name, symbol, and precision multipliers
 * @param event The pool creation event
 * @param context The handler context
 * @returns The newly created pool object
 */
export async function createPool(
  event: SyncswapFactory_PoolCreated_event,
  context: handlerContext
) {
  const contract = getContract({
    address: event.params.pool.toLowerCase() as Address,
    abi: SyncswapPoolABI,
    client,
  });
  const [name, symbol, poolType, token0Precision, token1Precision, totalSupply] =
    await client.multicall({
      contracts: [
        { ...contract, functionName: "name" },
        { ...contract, functionName: "symbol" },
        { ...contract, functionName: "poolType" },
        { ...contract, functionName: "token0PrecisionMultiplier" },
        { ...contract, functionName: "token1PrecisionMultiplier" },
        { ...contract, functionName: "totalSupply" },
      ],
    });

  const newSyncswapPool: SyncswapPool_t = {
    id: event.params.pool.toLowerCase(),
    address: event.params.pool.toLowerCase(),
    underlyingToken: event.params.token0.toLowerCase(),
    underlyingToken2: event.params.token1.toLowerCase(),
    name: name.result as string,
    symbol: symbol.result as string,
    poolType: poolType.result as bigint,
    token0PrecisionMultiplier: (token0Precision.result as bigint) ?? 1n,
    token1PrecisionMultiplier: (token1Precision.result as bigint) ?? 1n,
    reserve0: 0n,
    reserve1: 0n,
    totalSupply: totalSupply.result as bigint,
  };

  context.PoolRegistry.set({
    id: event.params.pool.toLowerCase(),
    protocol: "Syncswap",
    pool: event.params.pool.toLowerCase(),
  });

  context.SyncswapPool.set(newSyncswapPool);

  return newSyncswapPool;
}

export async function getOrCreateSyncswapPool(poolAddress: Address, context: handlerContext) {
  const existingPool = await context.SyncswapPool.get(poolAddress.toLowerCase() as Address);
  if (existingPool != undefined) {
    return existingPool;
  }

  const contract = getContract({
    address: poolAddress.toLowerCase() as Address,
    abi: SyncswapPoolABI,
    client,
  });

  const [name, symbol, poolType, token0Precision, token1Precision, totalSupply, token0, token1] =
    await client.multicall({
      contracts: [
        { ...contract, functionName: "name" },
        { ...contract, functionName: "symbol" },
        { ...contract, functionName: "poolType" },
        { ...contract, functionName: "token0PrecisionMultiplier" },
        { ...contract, functionName: "token1PrecisionMultiplier" },
        { ...contract, functionName: "totalSupply" },
        { ...contract, functionName: "token0" },
        { ...contract, functionName: "token1" },
      ],
    });

  const newSyncswapPool: SyncswapPool_t = {
    id: poolAddress.toLowerCase(),
    address: poolAddress.toLowerCase(),
    underlyingToken: (token0.result as Address).toLowerCase(),
    underlyingToken2: (token1.result as Address).toLowerCase(),
    name: name.result as string,
    symbol: symbol.result as string,
    poolType: poolType.result as bigint,
    token0PrecisionMultiplier: (token0Precision.result as bigint) ?? 1n,
    token1PrecisionMultiplier: (token1Precision.result as bigint) ?? 1n,
    reserve0: 0n,
    reserve1: 0n,
    totalSupply: totalSupply.result as bigint,
  };

  context.PoolRegistry.set({
    id: poolAddress.toLowerCase(),
    protocol: "Syncswap",
    pool: poolAddress.toLowerCase(),
  });

  context.SyncswapPool.set(newSyncswapPool);

  return newSyncswapPool;
}
