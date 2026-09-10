/**
 * Zod schemas for the subset of catapult-rest responses this server consumes.
 * Responses are validated before use; a mismatch becomes a RestError('invalid_response')
 * instead of an undefined-property crash deep inside a tool.
 */
import * as z from 'zod/v4';

export const Uint64String = z.string().regex(/^\d+$/, 'expected a decimal uint64 string');
export const HexString = z.string().regex(/^[0-9A-Fa-f]*$/, 'expected hex');
export const Hex16 = z.string().regex(/^[0-9A-Fa-f]{16}$/);
export const Hex48 = z.string().regex(/^[0-9A-Fa-f]{48}$/);
export const Hex64 = z.string().regex(/^[0-9A-Fa-f]{64}$/);

export const NodeInfoSchema = z.object({
  version: z.number().int().nonnegative(),
  publicKey: Hex64,
  networkGenerationHashSeed: Hex64,
  roles: z.number().int().nonnegative(),
  port: z.number().int().optional(),
  networkIdentifier: z.number().int(),
  host: z.string().optional(),
  friendlyName: z.string().optional(),
  nodePublicKey: Hex64.optional(),
});
export type NodeInfo = z.infer<typeof NodeInfoSchema>;

export const ChainInfoSchema = z.object({
  height: Uint64String,
  scoreHigh: Uint64String.optional(),
  scoreLow: Uint64String.optional(),
  latestFinalizedBlock: z.object({
    finalizationEpoch: z.number().int().nonnegative(),
    finalizationPoint: z.number().int().nonnegative(),
    height: Uint64String,
    hash: Hex64,
  }),
});
export type ChainInfo = z.infer<typeof ChainInfoSchema>;

export const NodeHealthSchema = z.object({
  status: z.object({
    apiNode: z.string(),
    db: z.string(),
  }),
});
export type NodeHealth = z.infer<typeof NodeHealthSchema>;

export const TransactionFeesSchema = z.object({
  averageFeeMultiplier: z.number().int().nonnegative(),
  medianFeeMultiplier: z.number().int().nonnegative(),
  highestFeeMultiplier: z.number().int().nonnegative(),
  lowestFeeMultiplier: z.number().int().nonnegative(),
  minFeeMultiplier: z.number().int().nonnegative(),
});
export type TransactionFees = z.infer<typeof TransactionFeesSchema>;

export const BlockInfoSchema = z.object({
  meta: z.object({ hash: Hex64.optional() }).loose(),
  block: z
    .object({
      height: Uint64String,
      timestamp: Uint64String,
      type: z.number().int().optional(),
      feeMultiplier: z.number().int().optional(),
    })
    .loose(),
});
export type BlockInfo = z.infer<typeof BlockInfoSchema>;

/** `/node/peers` is an array of node-info-like objects; we only count them. */
export const NodePeersSchema = z.array(z.object({}).loose());

const LinkedKeySchema = z.object({ publicKey: Hex64 });

export const VotingKeySchema = z.object({
  publicKey: HexString,
  startEpoch: z.number().int().nonnegative(),
  endEpoch: z.number().int().nonnegative(),
});

export const AccountInfoSchema = z.object({
  id: z.string().optional(),
  account: z.object({
    version: z.number().int().optional(),
    address: Hex48,
    addressHeight: Uint64String,
    publicKey: Hex64,
    publicKeyHeight: Uint64String,
    accountType: z.number().int(),
    supplementalPublicKeys: z.object({
      linked: LinkedKeySchema.optional(),
      node: LinkedKeySchema.optional(),
      vrf: LinkedKeySchema.optional(),
      voting: z.object({ publicKeys: z.array(VotingKeySchema) }).optional(),
    }),
    activityBuckets: z.array(z.object({}).loose()).optional(),
    mosaics: z.array(z.object({ id: Hex16, amount: Uint64String })),
    importance: Uint64String,
    importanceHeight: Uint64String,
  }),
});
export type AccountInfo = z.infer<typeof AccountInfoSchema>;

export const MosaicInfoSchema = z.object({
  id: z.string().optional(),
  mosaic: z
    .object({
      id: Hex16,
      supply: Uint64String,
      startHeight: Uint64String,
      ownerAddress: Hex48,
      revision: z.number().int().optional(),
      flags: z.number().int(),
      divisibility: z.number().int().min(0).max(18),
      duration: Uint64String,
    })
    .loose(),
});
export type MosaicInfo = z.infer<typeof MosaicInfoSchema>;

/**
 * `POST /mosaics` ({ mosaicIds }) answers only the mosaics that exist, in server-defined order
 * (symbol-openapi spec/plugins/mosaic/routes/getMosaics.yml).
 */
export const MosaicInfoListSchema = z.array(MosaicInfoSchema);

export const MosaicNamesSchema = z.object({
  mosaicNames: z.array(
    z.object({
      mosaicId: Hex16,
      names: z.array(z.string()),
    }),
  ),
});
export type MosaicNames = z.infer<typeof MosaicNamesSchema>;

export const MultisigInfoSchema = z.object({
  multisig: z
    .object({
      version: z.number().int().optional(),
      accountAddress: Hex48,
      minApproval: z.number().int().nonnegative(),
      minRemoval: z.number().int().nonnegative(),
      cosignatoryAddresses: z.array(Hex48),
      multisigAddresses: z.array(Hex48),
    })
    .loose(),
});
export type MultisigInfo = z.infer<typeof MultisigInfoSchema>;

export const NetworkPropertiesRawSchema = z.object({
  network: z.record(z.string(), z.unknown()),
  chain: z.record(z.string(), z.unknown()),
  plugins: z.unknown().optional(),
  forkHeights: z.unknown().optional(),
});
export type NetworkPropertiesRaw = z.infer<typeof NetworkPropertiesRawSchema>;

/**
 * Transactions. Shapes confirmed against captured mainnet fixtures (test/fixtures/mainnet/
 * transaction-*.json): confirmed meta carries `timestamp` and `feeMultiplier`; embedded meta
 * carries `aggregateHash` instead of `hash`; unconfirmed/partial meta has no height/timestamp;
 * `message` is absent when empty; type-specific fields vary, so the transaction object is loose.
 */
export const TransactionMetaSchema = z
  .object({
    height: Uint64String.optional(),
    hash: Hex64.optional(),
    merkleComponentHash: Hex64.optional(),
    aggregateHash: Hex64.optional(),
    index: z.number().int().optional(),
    timestamp: Uint64String.optional(),
    feeMultiplier: z.number().int().optional(),
  })
  .loose();

export const UnresolvedMosaicSchema = z.object({ id: Hex16, amount: Uint64String });

export const TransactionBodySchema = z
  .object({
    type: z.number().int().nonnegative(),
    signerPublicKey: Hex64,
    version: z.number().int().optional(),
    network: z.number().int().optional(),
    size: z.number().int().optional(),
    maxFee: Uint64String.optional(),
    deadline: Uint64String.optional(),
    recipientAddress: Hex48.optional(),
    mosaics: z.array(UnresolvedMosaicSchema).optional(),
    message: HexString.optional(),
    cosignatures: z.array(z.object({}).loose()).optional(),
    transactionsHash: Hex64.optional(),
  })
  .loose();

export const EmbeddedTransactionInfoSchema = z.object({
  id: z.string().optional(),
  meta: TransactionMetaSchema,
  transaction: TransactionBodySchema,
});

export const TransactionInfoSchema = z.object({
  id: z.string().optional(),
  meta: TransactionMetaSchema,
  transaction: TransactionBodySchema.extend({
    transactions: z.array(EmbeddedTransactionInfoSchema).optional(),
  }),
});
export type TransactionInfo = z.infer<typeof TransactionInfoSchema>;
export type EmbeddedTransactionInfo = z.infer<typeof EmbeddedTransactionInfoSchema>;

export const TransactionPageSchema = z.object({
  data: z.array(TransactionInfoSchema),
  pagination: z.object({ pageNumber: z.number().int(), pageSize: z.number().int() }),
});
export type TransactionPage = z.infer<typeof TransactionPageSchema>;

/** `POST /namespaces/names` answers an array (duplicates possible, see the fixture). */
export const NamespaceNamesSchema = z.array(
  z.object({ id: Hex16, name: z.string(), parentId: Hex16.optional() }),
);
export type NamespaceNames = z.infer<typeof NamespaceNamesSchema>;

/** `GET /namespaces/{id}`; shape from test/fixtures/mainnet/namespace-*.json. */
export const NamespaceInfoSchema = z.object({
  id: z.string().optional(),
  meta: z.object({ index: z.number().int().optional(), active: z.boolean().optional() }).loose(),
  namespace: z
    .object({
      version: z.number().int().optional(),
      registrationType: z.number().int(),
      depth: z.number().int(),
      level0: Hex16,
      level1: Hex16.optional(),
      level2: Hex16.optional(),
      alias: z
        .object({ type: z.number().int(), mosaicId: Hex16.optional(), address: Hex48.optional() })
        .loose(),
      parentId: Hex16.optional(),
      ownerAddress: Hex48,
      startHeight: Uint64String,
      endHeight: Uint64String,
    })
    .loose(),
});
export type NamespaceInfo = z.infer<typeof NamespaceInfoSchema>;

/** `GET /node/unlockedaccount`: key is singular (test/fixtures/mainnet/unlockedaccount.json). */
export const UnlockedAccountSchema = z.object({ unlockedAccount: z.array(Hex64) });
export type UnlockedAccount = z.infer<typeof UnlockedAccountSchema>;
