import { OwnerRoleVal, PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import type { CollaboratorItemType } from '@fastgpt/global/support/permission/collaborator';
import { getCollaboratorId, mergeCollaboratorList } from '@fastgpt/global/support/permission/utils';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import type { ParentIdType } from '@fastgpt/global/common/parentFolder/type';
import type { AnyBulkWriteOperation, ClientSession } from '../../../common/mongo';
import { Types } from '../../../common/mongo';
import { mongoSessionRun } from '../../../common/mongo/sessionRun';
import { getLogger, LogCategories } from '../../../common/logger';
import { MongoDatasetCollection } from './schema';
import { MongoDataset } from '../schema';
import { MongoResourcePermission } from '../../../support/permission/schema';
import type { ResourcePermissionType } from '@fastgpt/global/support/permission/type';
import { getResourceOwnedClbs } from '../../../support/permission/controller';
import { pickCollaboratorIdFields } from '../../../support/permission/utils';

const logger = getLogger(LogCategories.MODULE.DATASET.COLLECTION);

/**
 * Current collection-permission migration version.
 * A Collection is considered migrated when its `permissionMigrationVersion`
 * equals this value; re-runs only process Collections that are missing or
 * behind this version.
 */
export const COLLECTION_PERMISSION_MIGRATION_VERSION = 1;

/** Number of bulkWrite operations executed in one chunk (batch large writes). */
const BULK_WRITE_CHUNK_SIZE = 1000;

/** Minimal fields of a `dataset_collections` document needed by the migration. */
export type CollectionForMigration = {
  _id: string;
  tmbId: string;
  parentId?: ParentIdType;
  inheritPermission?: boolean;
  type: string;
};

/** Minimal fields of a `datasets` document needed to resolve the effective clbs. */
export type DatasetForMigration = {
  _id: string;
  teamId: string;
  parentId?: ParentIdType;
  inheritPermission?: boolean;
};

/**
 * Normalize raw collaborator records (ObjectId or string ids) to string ids so
 * that `getCollaboratorId`-based merging/compare never mixes ObjectId with string
 * for the same principal (avoids duplicate records / missed matches).
 */
export const normalizeClbs = <
  T extends { tmbId?: unknown; groupId?: unknown; orgId?: unknown; permission: number }
>(
  clbs: T[]
): CollaboratorItemType[] =>
  clbs.map((clb) => {
    const item = {
      ...(clb.tmbId ? { tmbId: String(clb.tmbId) } : {}),
      ...(clb.groupId ? { groupId: String(clb.groupId) } : {}),
      ...(clb.orgId ? { orgId: String(clb.orgId) } : {}),
      permission: clb.permission
    };
    return item as CollaboratorItemType;
  });

/** The single owner collaborator derived from a Collection's `tmbId`. */
export const computeOwnerRecord = (collection: CollectionForMigration): CollaboratorItemType => ({
  tmbId: String(collection.tmbId),
  permission: OwnerRoleVal
});

/**
 * Compute the `resource_permissions` snapshot of an inherited Collection Folder:
 * `merge(parentEffectiveClbs, [own owner])`, where the parent's owner is mapped to
 * `manage` by `mergeCollaboratorList` (owner is not passed through).
 */
export const computeFolderSnapshot = ({
  collection,
  parentClbs
}: {
  collection: CollectionForMigration;
  parentClbs: CollaboratorItemType[];
}): CollaboratorItemType[] =>
  mergeCollaboratorList({
    parentClbs: normalizeClbs(parentClbs),
    childClbs: [computeOwnerRecord(collection)]
  });

export type CollectionNode = {
  collection: CollectionForMigration;
  children: CollectionNode[];
};

export type CollectionTreeBuildResult = {
  /** Topological order of Collection Folders (parents before children); roots first. */
  order: CollectionNode[];
  /** Collection ids participating in a `parentId` cycle (cannot get a valid snapshot). */
  cycles: string[];
  /** Collection ids whose `parentId` is invalid (missing / not a folder of this dataset). */
  orphans: string[];
  /** collectionId -> node */
  nodeMap: Map<string, CollectionNode>;
  /** folderId -> parent source: 'dataset' for roots (incl. orphans), else parent folder id. */
  parentSourceMap: Map<string, 'dataset' | string>;
};

/**
 * Build the Collection tree of a Dataset and detect invalid links.
 * - A parent link is valid only when the parent exists in the same Dataset and is a folder;
 * - orphans are treated as roots (parent source = Dataset effective clbs);
 * - cycle detection uses Kahn's topological sort over the folder graph; folders that
 *   remain unprocessed are in cycles and are reported (no snapshot is computed for them).
 */
export const buildCollectionTree = (
  collections: CollectionForMigration[]
): CollectionTreeBuildResult => {
  const isFolder = (c: CollectionForMigration) => c.type === DatasetCollectionTypeEnum.folder;

  const nodeMap = new Map<string, CollectionNode>();
  const idToCollection = new Map<string, CollectionForMigration>();
  for (const c of collections) {
    const id = String(c._id);
    idToCollection.set(id, c);
    nodeMap.set(id, { collection: c, children: [] });
  }

  /** parentId -> child ids (valid folder parents only) */
  const childrenMap = new Map<string, string[]>();
  const orphans: string[] = [];
  const parentSourceMap = new Map<string, 'dataset' | string>();

  for (const c of collections) {
    const id = String(c._id);
    const pid = c.parentId ? String(c.parentId) : null;
    if (!pid) {
      parentSourceMap.set(id, 'dataset');
      continue;
    }
    const parent = idToCollection.get(pid);
    if (!parent || !isFolder(parent)) {
      orphans.push(id);
      parentSourceMap.set(id, 'dataset'); // orphan fallback -> root
      continue;
    }
    parentSourceMap.set(id, pid);
    const arr = childrenMap.get(pid) ?? [];
    arr.push(id);
    childrenMap.set(pid, arr);
  }

  for (const [pid, childIds] of childrenMap) {
    const parentNode = nodeMap.get(pid);
    if (!parentNode) continue;
    parentNode.children = childIds.map((cid) => nodeMap.get(cid)!);
  }

  // Kahn's topological sort over the folder graph (only folders have folder children).
  const folderIds: string[] = [];
  const inDegree = new Map<string, number>();
  for (const c of collections) {
    if (!isFolder(c)) continue;
    const id = String(c._id);
    folderIds.push(id);
    inDegree.set(id, 0);
  }
  for (const [pid, childIds] of childrenMap) {
    if (!inDegree.has(pid)) continue;
    for (const cid of childIds) {
      if (!inDegree.has(cid)) continue; // non-folder children are not part of the folder graph
      inDegree.set(cid, (inDegree.get(cid) ?? 0) + 1);
    }
  }

  const queue = folderIds.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const order: CollectionNode[] = [];
  const processed = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (processed.has(id)) continue;
    processed.add(id);
    order.push(nodeMap.get(id)!);
    for (const cid of childrenMap.get(id) ?? []) {
      if (!inDegree.has(cid)) continue;
      const deg = (inDegree.get(cid) ?? 0) - 1;
      inDegree.set(cid, deg);
      if (deg === 0) queue.push(cid);
    }
  }

  const cycles = folderIds.filter((id) => !processed.has(id));

  return { order, cycles, orphans, nodeMap, parentSourceMap };
};

export type ClbDiff = {
  insert: CollaboratorItemType[];
  update: CollaboratorItemType[];
  remove: CollaboratorItemType[];
};

/**
 * Compute the target-set diff between current and target collaborators
 * ("先计算目标集合，再按资源批量替换"). The ids are normalized to
 * strings before comparison so ObjectId/string mismatches cannot occur.
 */
export const diffClbs = ({
  currentClbs,
  targetClbs
}: {
  currentClbs: CollaboratorItemType[];
  targetClbs: CollaboratorItemType[];
}): ClbDiff => {
  const current = normalizeClbs(currentClbs);
  const target = normalizeClbs(targetClbs);
  const currentMap = new Map(current.map((c) => [getCollaboratorId(c), c]));
  const targetMap = new Map(target.map((c) => [getCollaboratorId(c), c]));

  const insert: CollaboratorItemType[] = [];
  const update: CollaboratorItemType[] = [];
  const remove: CollaboratorItemType[] = [];

  for (const clb of target) {
    const id = getCollaboratorId(clb);
    const existing = currentMap.get(id);
    if (!existing) {
      insert.push(clb);
    } else if (existing.permission !== clb.permission) {
      update.push(clb);
    }
  }
  for (const clb of current) {
    if (!targetMap.has(getCollaboratorId(clb))) {
      remove.push(clb);
    }
  }

  return { insert, update, remove };
};

/** Two collaborator lists are equal when they have the same ids with the same permissions. */
export const sameClbs = (a: CollaboratorItemType[], b: CollaboratorItemType[]): boolean => {
  const aNorm = normalizeClbs(a);
  const bNorm = normalizeClbs(b);
  if (aNorm.length !== bNorm.length) return false;
  const bMap = new Map(bNorm.map((c) => [getCollaboratorId(c), c.permission]));
  for (const clb of aNorm) {
    const id = getCollaboratorId(clb);
    if (!bMap.has(id) || bMap.get(id) !== clb.permission) return false;
  }
  return true;
};

const appendClbOps = ({
  ops,
  teamId,
  resourceId,
  diff
}: {
  ops: AnyBulkWriteOperation<ResourcePermissionType>[];
  teamId: string;
  resourceId: string;
  diff: ClbDiff;
}) => {
  for (const clb of diff.insert) {
    ops.push({
      insertOne: {
        document: {
          teamId,
          resourceId,
          resourceType: PerResourceTypeEnum.collection,
          ...pickCollaboratorIdFields(clb),
          permission: clb.permission
        } as ResourcePermissionType
      }
    });
  }
  for (const clb of diff.update) {
    ops.push({
      updateOne: {
        filter: {
          teamId,
          resourceId,
          resourceType: PerResourceTypeEnum.collection,
          ...pickCollaboratorIdFields(clb)
        },
        update: { $set: { permission: clb.permission } }
      }
    });
  }
  for (const clb of diff.remove) {
    ops.push({
      deleteOne: {
        filter: {
          teamId,
          resourceId,
          resourceType: PerResourceTypeEnum.collection,
          ...pickCollaboratorIdFields(clb)
        }
      }
    });
  }
};

/** Execute bulkWrite in bounded chunks. */
const chunkedBulkWrite = async (
  ops: AnyBulkWriteOperation<ResourcePermissionType>[],
  session: ClientSession
) => {
  for (let i = 0; i < ops.length; i += BULK_WRITE_CHUNK_SIZE) {
    const chunk = ops.slice(i, i + BULK_WRITE_CHUNK_SIZE);
    if (chunk.length > 0) {
      await MongoResourcePermission.bulkWrite(chunk, { session });
    }
  }
};

/**
 * Resolve the effective collaborator list of a Dataset
 * walk up the `datasets.parentId` chain while `inheritPermission !== false`,
 * merging each level with `mergeCollaboratorList` (ancestor owner mapped to
 * manage); the Dataset's own owner keeps `OwnerRoleVal`.
 */
export const getDatasetEffectiveClbs = async ({
  dataset,
  session
}: {
  dataset: DatasetForMigration;
  session?: ClientSession;
}): Promise<CollaboratorItemType[]> => {
  const teamId = String(dataset.teamId);

  const chain: DatasetForMigration[] = [];
  const seen = new Set<string>();
  let current: DatasetForMigration | null = dataset;
  while (current) {
    const id = String(current._id);
    if (seen.has(id)) break; // cycle guard
    seen.add(id);
    chain.push(current);
    if (current.inheritPermission === false || !current.parentId) break;
    const parentId: string = String(current.parentId);
    if (seen.has(parentId)) break;
    const parent = (await MongoDataset.findById(parentId)
      .lean()
      .session(session ?? null)) as DatasetForMigration | null;
    if (!parent) break;
    current = parent;
  }

  // Merge from the top-most ancestor down to the Dataset itself.
  let effective: CollaboratorItemType[] = [];
  for (let i = chain.length - 1; i >= 0; i--) {
    const ownClbs = normalizeClbs(
      (await getResourceOwnedClbs({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: chain[i]._id,
        session
      })) as CollaboratorItemType[]
    );
    effective = mergeCollaboratorList({ parentClbs: effective, childClbs: ownClbs });
  }

  return effective;
};

export type MigrateDatasetResult = {
  migratedCollections: number;
  issues: string[];
};

/**
 * Migrate the collection permissions of a single Dataset inside one transaction
 *
 * 1. all Collections -> `inheritPermission=true`;
 * 2. build the Collection tree and detect cycles / orphans;
 * 3. rebuild inherited Collection Folder snapshots in topological order
 *    (root folders seeded from the Dataset effective clbs, children from the
 *    already-updated parent snapshot);
 * 4. non-folder Collections only get their owner record (no full parent snapshot);
 * 5. delete duplicate owner records and verify invariants;
 * 6. mark `permissionMigrationVersion` (skipping cyclic folders so a re-run after
 *    the cycle is fixed re-processes them).
 */
export const migrateDatasetCollections = async ({
  teamId,
  datasetId
}: {
  teamId: string;
  datasetId: string;
}): Promise<MigrateDatasetResult> => {
  return mongoSessionRun(async (session) => {
    // 1. init inheritPermission (idempotent)
    await MongoDatasetCollection.updateMany(
      { datasetId, teamId },
      { $set: { inheritPermission: true } },
      { session }
    );

    const collections = await MongoDatasetCollection.find(
      { datasetId, teamId },
      '_id tmbId parentId inheritPermission type'
    )
      .lean<CollectionForMigration[]>()
      .session(session);

    if (collections.length === 0) {
      return { migratedCollections: 0, issues: [] };
    }

    const issues: string[] = [];

    // 2. dataset effective clbs (root Collection Folder parent source)
    const dataset = await MongoDataset.findOne({ _id: datasetId, teamId })
      .lean<DatasetForMigration>()
      .session(session);
    if (!dataset) {
      throw new Error(`Dataset ${datasetId} not found in team ${teamId}`);
    }
    const datasetEffectiveClbs = await getDatasetEffectiveClbs({ dataset, session });

    // 3. build the Collection tree
    const { order, cycles, orphans, parentSourceMap } = buildCollectionTree(collections);
    for (const orphanId of orphans) issues.push(`orphan parentId: ${orphanId}`);
    for (const cycleId of cycles) issues.push(`cycle: ${cycleId}`);

    // batch-load current permission records of all collections (no N+1)
    const currentClbs = await MongoResourcePermission.find({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: { $in: collections.map((c) => String(c._id)) }
    })
      .lean()
      .session(session);
    const currentClbsByResource = new Map<string, ResourcePermissionType[]>();
    for (const clb of currentClbs) {
      const rid = String(clb.resourceId);
      const arr = currentClbsByResource.get(rid) ?? [];
      arr.push(clb);
      currentClbsByResource.set(rid, arr);
    }

    const ops: AnyBulkWriteOperation<ResourcePermissionType>[] = [];
    const folderSnapshots = new Map<string, CollaboratorItemType[]>();
    const migratedCollectionIds = new Set<string>();

    // 4. Collection Folders in topological order (parent snapshot ready before child)
    for (const node of order) {
      const folderId = String(node.collection._id);
      const source = parentSourceMap.get(folderId) ?? 'dataset';
      const parentClbs =
        source === 'dataset' ? datasetEffectiveClbs : (folderSnapshots.get(source) ?? []);
      const snapshot = computeFolderSnapshot({ collection: node.collection, parentClbs });
      folderSnapshots.set(folderId, snapshot);
      appendClbOps({
        ops,
        teamId,
        resourceId: folderId,
        diff: diffClbs({
          currentClbs: normalizeClbs(currentClbsByResource.get(folderId) ?? []),
          targetClbs: snapshot
        })
      });
      migratedCollectionIds.add(folderId);
    }

    // 5. non-folder Collections (and cyclic folders) -> owner record only
    for (const collection of collections) {
      const id = String(collection._id);
      const isFolder = collection.type === DatasetCollectionTypeEnum.folder;
      if (isFolder && !cycles.includes(id)) continue; // already rebuilt via snapshot

      // Upsert the unique owner record; do NOT replace other clbs (no full parent snapshot).
      // Non-inherited resources must not be replaced.
      ops.push({
        updateOne: {
          filter: {
            teamId,
            resourceId: id,
            resourceType: PerResourceTypeEnum.collection,
            tmbId: String(collection.tmbId)
          },
          update: { $set: { permission: OwnerRoleVal } },
          upsert: true
        }
      });
      if (!isFolder) migratedCollectionIds.add(id);
    }

    await chunkedBulkWrite(ops, session);

    // 6. cleanup duplicate / wrongly-granted owner records
    await cleanupOwnerRecords({ teamId, collections, session });

    // 7. verify invariants all inherited, owner unique, folder snapshot matches parent.
    //    Real inconsistencies abort the batch (recorded in `failed`, re-processed on re-run);
    //    orphans/cycles are expected edge cases already recorded above and are non-fatal.
    const nonInherited = collections.filter((c) => c.inheritPermission !== true);
    for (const c of nonInherited) issues.push(`inheritPermission != true: ${String(c._id)}`);

    const ownerValidation = await validateOwners({ teamId, collections, session });
    const snapshotValidation = await validateFolderSnapshots({
      teamId,
      collections,
      cycles,
      folderSnapshots,
      session
    });
    if (ownerValidation.length > 0 || snapshotValidation.length > 0 || nonInherited.length > 0) {
      throw new Error(
        `Collection permission validation failed for dataset ${datasetId}: ${[
          ...ownerValidation,
          ...snapshotValidation,
          ...issues.filter((i) => i.startsWith('inheritPermission'))
        ].join('; ')}`
      );
    }

    // 8. mark migration version (skip cyclic folders -> re-run after fix re-processes them)
    if (cycles.length > 0) {
      await MongoDatasetCollection.updateMany(
        { datasetId, teamId, _id: { $nin: cycles.map((cid) => new Types.ObjectId(cid)) } },
        { $set: { permissionMigrationVersion: COLLECTION_PERMISSION_MIGRATION_VERSION } },
        { session }
      );
    } else {
      await MongoDatasetCollection.updateMany(
        { datasetId, teamId },
        { $set: { permissionMigrationVersion: COLLECTION_PERMISSION_MIGRATION_VERSION } },
        { session }
      );
    }

    return { migratedCollections: migratedCollectionIds.size, issues };
  });
};

/** Delete owner records that are duplicated or granted to someone other than the Collection owner. */
const cleanupOwnerRecords = async ({
  teamId,
  collections,
  session
}: {
  teamId: string;
  collections: CollectionForMigration[];
  session: ClientSession;
}) => {
  const collectionIds = collections.map((c) => String(c._id));
  const ownerRecords = await MongoResourcePermission.find({
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId: { $in: collectionIds },
    permission: OwnerRoleVal
  })
    .lean()
    .session(session);

  const expectedOwnerByResource = new Map(collections.map((c) => [String(c._id), String(c.tmbId)]));
  const ops: AnyBulkWriteOperation<ResourcePermissionType>[] = [];
  const seen = new Set<string>();

  for (const rec of ownerRecords) {
    const resourceId = String(rec.resourceId);
    const expectedTmbId = expectedOwnerByResource.get(resourceId);
    if (!expectedTmbId || !rec.tmbId || String(rec.tmbId) !== expectedTmbId) {
      // resource no longer exists, or a non-owner was granted OwnerRoleVal -> remove
      ops.push({ deleteOne: { filter: { _id: rec._id } } });
      continue;
    }
    const key = `${resourceId}:${String(rec.tmbId)}`;
    if (seen.has(key)) {
      ops.push({ deleteOne: { filter: { _id: rec._id } } });
    } else {
      seen.add(key);
    }
  }

  if (ops.length > 0) {
    await MongoResourcePermission.bulkWrite(ops, { session });
  }
};

/** Verify each Collection has exactly one owner record (its `tmbId` with OwnerRoleVal). */
const validateOwners = async ({
  teamId,
  collections,
  session
}: {
  teamId: string;
  collections: CollectionForMigration[];
  session: ClientSession;
}): Promise<string[]> => {
  const issues: string[] = [];
  const collectionIds = collections.map((c) => String(c._id));
  const ownerRecords = await MongoResourcePermission.find({
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId: { $in: collectionIds },
    permission: OwnerRoleVal
  })
    .lean()
    .session(session);

  const recordsByResource = new Map<string, ResourcePermissionType[]>();
  for (const rec of ownerRecords) {
    const rid = String(rec.resourceId);
    const arr = recordsByResource.get(rid) ?? [];
    arr.push(rec);
    recordsByResource.set(rid, arr);
  }

  for (const collection of collections) {
    const id = String(collection._id);
    const ownerTmbId = String(collection.tmbId);
    const records = recordsByResource.get(id) ?? [];
    const correctOwner = records.filter((rec) => rec.tmbId && String(rec.tmbId) === ownerTmbId);
    if (correctOwner.length !== 1) {
      issues.push(`owner records != 1 for collection ${id} (found ${correctOwner.length})`);
    }
    if (records.some((rec) => !rec.tmbId || String(rec.tmbId) !== ownerTmbId)) {
      issues.push(`wrong owner granted on collection ${id}`);
    }
  }

  return issues;
};

/** Verify inherited Folder snapshots match the recomputed target snapshot (parent clbs + owner). */
const validateFolderSnapshots = async ({
  teamId,
  collections,
  cycles,
  folderSnapshots,
  session
}: {
  teamId: string;
  collections: CollectionForMigration[];
  cycles: string[];
  folderSnapshots: Map<string, CollaboratorItemType[]>;
  session: ClientSession;
}): Promise<string[]> => {
  const issues: string[] = [];
  const collectionIds = collections.map((c) => String(c._id));
  const allClbs = await MongoResourcePermission.find({
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId: { $in: collectionIds }
  })
    .lean()
    .session(session);

  const clbsByResource = new Map<string, ResourcePermissionType[]>();
  for (const clb of allClbs) {
    const rid = String(clb.resourceId);
    const arr = clbsByResource.get(rid) ?? [];
    arr.push(clb);
    clbsByResource.set(rid, arr);
  }

  for (const collection of collections) {
    const id = String(collection._id);
    if (collection.type !== DatasetCollectionTypeEnum.folder || cycles.includes(id)) continue;
    const expected = folderSnapshots.get(id);
    if (!expected) {
      issues.push(`missing folder snapshot for ${id}`);
      continue;
    }
    const actual = normalizeClbs(clbsByResource.get(id) ?? []);
    if (!sameClbs(expected, actual)) {
      issues.push(
        `folder snapshot mismatch for ${id}: expected ${expected.length} clbs, got ${actual.length}`
      );
    }
  }

  return issues;
};

/**
 * One-time migration of all existing (legacy) Collection permissions.
 *
 * - Scans Datasets by `teamId + datasetId`, only those whose Collections are
 *   missing / behind `COLLECTION_PERMISSION_MIGRATION_VERSION` (idempotent, resume-safe);
 * - each Dataset is committed in its own `mongoSessionRun` transaction; a failing
 * Dataset is recorded and does not block the others (MG-005);
 * - re-running after a failure re-processes only the un-migrated Datasets.
 */
export const migrateCollectionPermissions = async (opts?: {
  batchSize?: number;
  datasetIds?: string[];
}): Promise<{ migratedDatasets: number; failed: { datasetId: string; error: string }[] }> => {
  const batchSize = Math.max(1, opts?.batchSize ?? 10);

  const match: Record<string, unknown> = {
    permissionMigrationVersion: { $ne: COLLECTION_PERMISSION_MIGRATION_VERSION }
  };
  if (opts?.datasetIds?.length) {
    // aggregate $match does not cast query values -> convert to ObjectId explicitly
    match.datasetId = { $in: opts.datasetIds.map((id) => new Types.ObjectId(String(id))) };
  }

  const groups = await MongoDatasetCollection.aggregate<{
    _id: { teamId: string; datasetId: string };
  }>([{ $match: match }, { $group: { _id: { teamId: '$teamId', datasetId: '$datasetId' } } }]);

  const datasets = groups.map((g) => ({
    teamId: String(g._id.teamId),
    datasetId: String(g._id.datasetId)
  }));

  let migratedDatasets = 0;
  const failed: { datasetId: string; error: string }[] = [];
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= datasets.length) break;
      const { teamId, datasetId } = datasets[idx];
      try {
        await migrateDatasetCollections({ teamId, datasetId });
        migratedDatasets++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ datasetId, error: message });
        logger.error('Collection permission migration failed for dataset', {
          teamId,
          datasetId,
          error
        });
      }
    }
  };

  const workerCount = Math.min(batchSize, Math.max(datasets.length, 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { migratedDatasets, failed };
};

export type CollectionPermissionValidationIssue = {
  datasetId: string;
  collectionId: string;
  type:
    | 'owner_missing'
    | 'owner_duplicate'
    | 'wrong_owner_granted'
    | 'snapshot_mismatch'
    | 'non_inherited';
  detail?: string;
};

/**
 * Post-migration validation task randomly sample Collections of the
 * target Datasets and compare the stored state against the expected state computed by
 * the same pure functions used during migration.
 */
export const validateCollectionPermissionMigration = async (opts?: {
  datasetIds?: string[];
  sampleSize?: number;
}): Promise<{
  checkedDatasets: number;
  checkedCollections: number;
  issues: CollectionPermissionValidationIssue[];
}> => {
  const sampleSize = Math.max(1, opts?.sampleSize ?? 20);
  const issues: CollectionPermissionValidationIssue[] = [];
  let checkedCollections = 0;

  const match: Record<string, unknown> = {};
  if (opts?.datasetIds?.length) {
    // aggregate $match does not cast query values -> convert to ObjectId explicitly
    match.datasetId = { $in: opts.datasetIds.map((id) => new Types.ObjectId(String(id))) };
  }

  const groups = await MongoDatasetCollection.aggregate<{
    _id: { teamId: string; datasetId: string };
  }>([{ $match: match }, { $group: { _id: { teamId: '$teamId', datasetId: '$datasetId' } } }]);

  for (const g of groups) {
    const teamId = String(g._id.teamId);
    const datasetId = String(g._id.datasetId);

    const collections = await MongoDatasetCollection.find(
      { datasetId, teamId },
      '_id tmbId parentId inheritPermission type'
    ).lean<CollectionForMigration[]>();
    if (collections.length === 0) continue;

    const dataset = await MongoDataset.findOne({ _id: datasetId, teamId }).lean();
    const datasetEffectiveClbs = dataset
      ? await getDatasetEffectiveClbs({ dataset: dataset as DatasetForMigration })
      : [];

    const { order, cycles, parentSourceMap } = buildCollectionTree(collections);
    const folderSnapshots = new Map<string, CollaboratorItemType[]>();
    for (const node of order) {
      const folderId = String(node.collection._id);
      const source = parentSourceMap.get(folderId) ?? 'dataset';
      const parentClbs =
        source === 'dataset' ? datasetEffectiveClbs : (folderSnapshots.get(source) ?? []);
      folderSnapshots.set(
        folderId,
        computeFolderSnapshot({ collection: node.collection, parentClbs })
      );
    }

    const allClbs = await MongoResourcePermission.find({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: { $in: collections.map((c) => String(c._id)) }
    }).lean();
    const clbsByResource = new Map<string, ResourcePermissionType[]>();
    for (const clb of allClbs) {
      const rid = String(clb.resourceId);
      const arr = clbsByResource.get(rid) ?? [];
      arr.push(clb);
      clbsByResource.set(rid, arr);
    }

    const sample = collections
      .slice()
      .sort(() => Math.random() - 0.5)
      .slice(0, sampleSize);
    for (const collection of sample) {
      checkedCollections++;
      const id = String(collection._id);
      const actual = normalizeClbs(clbsByResource.get(id) ?? []);

      if (collection.type === DatasetCollectionTypeEnum.folder && !cycles.includes(id)) {
        const expected = folderSnapshots.get(id);
        if (!expected || !sameClbs(expected, actual)) {
          issues.push({
            datasetId,
            collectionId: id,
            type: 'snapshot_mismatch',
            detail: `expected ${expected?.length ?? 0} clbs, got ${actual.length}`
          });
        }
      } else {
        if (collection.inheritPermission !== true) {
          issues.push({ datasetId, collectionId: id, type: 'non_inherited' });
        }
        const owners = actual.filter((c) => c.permission === OwnerRoleVal);
        if (owners.length === 0) {
          issues.push({ datasetId, collectionId: id, type: 'owner_missing' });
        }
        if (owners.length > 1 || owners.some((c) => c.tmbId !== String(collection.tmbId))) {
          issues.push({ datasetId, collectionId: id, type: 'owner_duplicate' });
        }
        if (owners.some((c) => c.tmbId !== String(collection.tmbId))) {
          issues.push({ datasetId, collectionId: id, type: 'wrong_owner_granted' });
        }
      }
    }
  }

  return { checkedDatasets: groups.length, checkedCollections, issues };
};
