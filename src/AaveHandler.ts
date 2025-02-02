import { getContract } from "viem";
import { client } from "./viem/Client";
import { ERC20_Transfer_event, handlerContext } from "generated/src/Types.gen";
import { Address } from "viem";
import { AaveEarnBalance_t, AavePool_t } from "generated/src/db/Entities.gen";
import { Aave } from "generated";
import { walletCache } from "./utils/WalletCache";
import { ClaggMainAddress } from "./constants/ClaggAddresses";
import { getOrCreateClaggPool } from "./ClaggHandler";
import { roundTimestamp } from "./utils/helpers";

Aave.Mint.handlerWithLoader({
  loader: async ({ event, context }) => {
    const [userBalance, claveAddresses] = await Promise.all([
      context.AaveEarnBalance.get(event.params.onBehalfOf.toLowerCase()),
      walletCache.bulkCheckClaveWallets([event.params.onBehalfOf.toLowerCase()]),
    ]);

    return { userBalance, claveAddresses };
  },
  handler: async ({ event, context, loaderReturn }) => {
    const { userBalance, claveAddresses } = loaderReturn;

    const createdPool = await getOrCreateAavePool(
      event.srcAddress.toLowerCase() as Address,
      context
    );

    context.AavePool.set({
      ...createdPool,
      lastIndex: event.params.index,
    });

    context.HistoricalAavePool.set({
      ...createdPool,
      id: createdPool.id + roundTimestamp(event.block.timestamp),
      timestamp: BigInt(roundTimestamp(event.block.timestamp)),
    });

    if (
      !claveAddresses.has(event.params.onBehalfOf.toLowerCase()) &&
      process.env.NODE_ENV !== "test"
    ) {
      return;
    }

    context.Account.set({
      id: event.params.onBehalfOf.toLowerCase(),
      address: event.params.onBehalfOf.toLowerCase(),
    });

    const aaveEarnBalance: AaveEarnBalance_t = {
      id: event.params.onBehalfOf.toLowerCase() + createdPool.id,
      userAddress: event.params.onBehalfOf.toLowerCase(),
      aavePool_id: createdPool.id,
      userIndex: event.params.index,
      shareBalance: userBalance ? userBalance.shareBalance : 0n,
    };

    context.AaveEarnBalance.set(aaveEarnBalance);
    context.HistoricalAaveEarnBalance.set({
      ...aaveEarnBalance,
      id: aaveEarnBalance.id + roundTimestamp(event.block.timestamp, 3600),
      timestamp: BigInt(roundTimestamp(event.block.timestamp, 3600)),
    });
  },
});

Aave.Burn.handlerWithLoader({
  loader: async ({ event, context }) => {
    const [userBalance, claveAddresses] = await Promise.all([
      context.AaveEarnBalance.get(event.params.from.toLowerCase()),
      walletCache.bulkCheckClaveWallets([event.params.from.toLowerCase()]),
    ]);

    return { userBalance, claveAddresses };
  },
  handler: async ({ event, context, loaderReturn }) => {
    const { userBalance, claveAddresses } = loaderReturn;

    const createdPool = await getOrCreateAavePool(
      event.srcAddress.toLowerCase() as Address,
      context
    );

    context.AavePool.set({
      ...createdPool,
      lastIndex: event.params.index,
    });

    context.HistoricalAavePool.set({
      ...createdPool,
      id: createdPool.id + roundTimestamp(event.block.timestamp),
      timestamp: BigInt(roundTimestamp(event.block.timestamp)),
    });

    if (!claveAddresses.has(event.params.from.toLowerCase()) && process.env.NODE_ENV !== "test") {
      return;
    }

    context.Account.set({
      id: event.params.from.toLowerCase(),
      address: event.params.from.toLowerCase(),
    });

    const aaveEarnBalance: AaveEarnBalance_t = {
      id: event.params.from.toLowerCase() + createdPool.id,
      userAddress: event.params.from.toLowerCase(),
      aavePool_id: createdPool.id,
      userIndex: event.params.index,
      shareBalance: userBalance ? userBalance.shareBalance : 0n,
    };

    context.AaveEarnBalance.set(aaveEarnBalance);
    context.HistoricalAaveEarnBalance.set({
      ...aaveEarnBalance,
      id: aaveEarnBalance.id + roundTimestamp(event.block.timestamp, 3600),
      timestamp: BigInt(roundTimestamp(event.block.timestamp, 3600)),
    });
  },
});

export const AaveAccountHandler = async ({
  event,
  context,
  loaderReturn,
}: {
  event: ERC20_Transfer_event;
  context: handlerContext;
  loaderReturn: any;
}) => {
  const { claveAddresses } = loaderReturn as {
    claveAddresses: Set<string>;
  };

  const pool = await getOrCreateAavePool(event.srcAddress.toLowerCase() as Address, context);

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

  const senderAccountBalance = await context.AaveEarnBalance.get(
    event.params.from.toLowerCase() + pool.id
  );

  const receiverAccountBalance = await context.AaveEarnBalance.get(
    event.params.to.toLowerCase() + pool.id
  );

  if (claveAddresses.has(event.params.from.toLowerCase())) {
    // Update sender's account balance
    let accountObject: AaveEarnBalance_t = {
      id: event.params.from.toLowerCase() + pool.id,
      shareBalance:
        senderAccountBalance == undefined
          ? 0n - event.params.value
          : senderAccountBalance.shareBalance - event.params.value,
      userAddress: event.params.from.toLowerCase(),
      aavePool_id: pool.id,
      userIndex: senderAccountBalance ? senderAccountBalance.userIndex : 0n,
    };

    context.AaveEarnBalance.set(accountObject);
    context.HistoricalAaveEarnBalance.set({
      ...accountObject,
      id: accountObject.id + roundTimestamp(event.block.timestamp, 3600),
      timestamp: BigInt(roundTimestamp(event.block.timestamp, 3600)),
    });
  }

  if (claveAddresses.has(event.params.to.toLowerCase())) {
    // Update receiver's account balance
    let accountObject: AaveEarnBalance_t = {
      id: event.params.to.toLowerCase() + pool.id,
      shareBalance:
        receiverAccountBalance == undefined
          ? event.params.value
          : event.params.value + receiverAccountBalance.shareBalance,
      userAddress: event.params.to.toLowerCase(),
      aavePool_id: pool.id,
      userIndex: receiverAccountBalance ? receiverAccountBalance.userIndex : 0n,
    };

    context.AaveEarnBalance.set(accountObject);
    context.HistoricalAaveEarnBalance.set({
      ...accountObject,
      id: accountObject.id + roundTimestamp(event.block.timestamp, 3600),
      timestamp: BigInt(roundTimestamp(event.block.timestamp, 3600)),
    });
  }
};

const AAVE_ABI = [
  {
    inputs: [],
    name: "UNDERLYING_ASSET_ADDRESS",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

async function getOrCreateAavePool(poolAddress: Address, context: handlerContext) {
  const pool = await context.AavePool.get(poolAddress.toLowerCase());

  if (pool != undefined) {
    return pool;
  } else {
    const contract = getContract({
      address: poolAddress.toLowerCase() as Address,
      abi: AAVE_ABI,
      client,
    });

    const [name, symbol, underlyingToken] = await client.multicall({
      contracts: [
        { ...contract, functionName: "name" },
        { ...contract, functionName: "symbol" },
        { ...contract, functionName: "UNDERLYING_ASSET_ADDRESS" },
      ],
    });

    const newAavePool: AavePool_t = {
      id: poolAddress.toLowerCase(),
      address: poolAddress.toLowerCase(),
      underlyingToken: underlyingToken.result as Address,
      name: name.result as string,
      symbol: symbol.result as string,
      lastIndex: 0n,
    };

    context.PoolRegistry.set({
      id: poolAddress.toLowerCase(),
      protocol: "Aave",
      pool: poolAddress.toLowerCase(),
    });
    context.AavePool.set(newAavePool);

    return newAavePool;
  }
}
