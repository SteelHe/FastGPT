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
import {
  deriveOwnClbs,
  syncCollectionChildrenPermission,
  syncCollectionCollaborators,
  syncRootCollections
} from '../../../support/permission/collection/folderSync';

const logger = getLogger(LogCategories.MODULE.DATASET.COLLECTION);

/**
 * Current collection-permission migration version.
 * A Collection is considered migrated when its `permissionMigrationVersion`
 * equals this value; re-runs only process Collections that are missing or
 * behind this version.
 *
 * v2 = 全快照模型：所有继承态 Collection（Folder + 非 Folder）写入完整有效快照
 * `merge(父级有效 clbs, 自身 clbs)`；运行时直接读快照。
 */
export const COLLECTION_PERMISSION_MIGRATION_VERSION = 2;

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
 * Compute the `resource_permissions` snapshot of an inherited Collection (全快照模型)：
 * `merge(parentEffectiveClbs, [own owner])`，父级 owner 由 `mergeCollaboratorList` 映射为 manage。
 * 纯函数，供单测与迁移校验复用。
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
 * 2. build the Collection tree to detect cycles / orphans;
 * 3. create a creator (owner) permission record for every Collection (idempotent upsert);
 * 4. `syncRootCollections`: 根级继承态 Collection 以 Dataset 有效 clbs 为父级来源重建完整快照
 *    （Folder 与非 Folder 均写入），Folder 子 Collection 经递归以父 Folder 快照为父级来源
 *    重建 —— 嵌套全快照模型；
 * 5. orphan Collections（父级缺失/非 Folder）按根级处理：以 Dataset 有效 clbs 为父级来源
 *    重建快照，Folder 继续递归子节点；
 * 6. cyclic Folders 同步期间临时退出继承（防止递归死循环），同步后恢复；其快照保持 owner 记录，
 *    不标记迁移版本（修复环后重跑会重新处理）；
 * 7. 清理重复/错误授予的 owner 记录并校验不变式；
 * 8. 标记 `permissionMigrationVersion`（跳过 cyclic folders）。
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

    // 2. dataset effective clbs (root / orphan Collection parent source)
    const dataset = await MongoDataset.findOne({ _id: datasetId, teamId })
      .lean<DatasetForMigration>()
      .session(session);
    if (!dataset) {
      throw new Error(`Dataset ${datasetId} not found in team ${teamId}`);
    }
    const datasetEffectiveClbs = await getDatasetEffectiveClbs({ dataset, session });

    // 3. build the Collection tree and detect cycles / orphans
    const { cycles, orphans } = buildCollectionTree(collections);
    for (const orphanId of orphans) issues.push(`orphan parentId: ${orphanId}`);
    for (const cycleId of cycles) issues.push(`cycle: ${cycleId}`);

    // 4. create a creator (owner) permission record for every Collection
    const ownerUpsertOps: AnyBulkWriteOperation<ResourcePermissionType>[] = collections.map(
      (collection) => ({
        updateOne: {
          filter: {
            resourceType: PerResourceTypeEnum.collection,
            teamId,
            resourceId: String(collection._id),
            tmbId: String(collection.tmbId)
          },
          update: { $set: { permission: OwnerRoleVal } },
          upsert: true
        }
      })
    );
    await chunkedBulkWrite(ownerUpsertOps, session);

    // 5. cyclic folders temporarily opt out of inheritance so the recursive sync
    //    cannot traverse the cycle forever (restored after the sync).
    if (cycles.length > 0) {
      await MongoDatasetCollection.updateMany(
        { datasetId, teamId, _id: { $in: cycles.map((cid) => new Types.ObjectId(cid)) } },
        { $set: { inheritPermission: false } },
        { session }
      );
    }

    // 6. rebuild every inherited Collection snapshot via the shared full-snapshot primitives:
    //    old/new parent clbs 都用 Dataset 有效 clbs —— 从现有快照中拆出自身 clbs 后再合并，
    //    对 Folder 递归时以「父 Folder 旧快照 → 新快照」逐层重建（嵌套全快照）。
    await syncRootCollections({
      teamId,
      datasetId,
      oldRootClbs: datasetEffectiveClbs,
      rootClbs: datasetEffectiveClbs,
      session
    });

    // 7. orphan Collections are not reachable from any root -> treat as roots
    //    (parent source = Dataset effective clbs); Folder orphans recurse their children.
    for (const orphanId of orphans) {
      const orphan = collections.find((c) => String(c._id) === orphanId);
      if (!orphan) continue;
      await syncOrphanCollection({
        teamId,
        datasetId,
        collection: orphan,
        datasetEffectiveClbs,
        session
      });
    }

    // 8. restore cyclic folders back to inheritance (all collections inherited invariant)
    if (cycles.length > 0) {
      await MongoDatasetCollection.updateMany(
        { datasetId, teamId, _id: { $in: cycles.map((cid) => new Types.ObjectId(cid)) } },
        { $set: { inheritPermission: true } },
        { session }
      );
    }

    // 9. cleanup duplicate / wrongly-granted owner records
    await cleanupOwnerRecords({ teamId, collections, session });

    // 10. verify invariants: owner unique, all inherited, every inherited Collection
    //     snapshot is consistent with the nested model (merge(parent source, own clbs)).
    const nonInherited = collections.filter((c) => c.inheritPermission !== true);
    for (const c of nonInherited) issues.push(`inheritPermission != true: ${String(c._id)}`);

    const ownerValidation = await validateOwners({ teamId, collections, session });
    const snapshotValidation = await validateCollectionSnapshots({
      teamId,
      collections,
      cycles,
      datasetEffectiveClbs,
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

    // 11. mark migration version (skip cyclic folders -> re-run after fix re-processes them)
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

    const migratedCollections = collections.filter((c) => !cycles.includes(String(c._id))).length;

    return { migratedCollections, issues };
  });
};

/** 同步单个 orphan Collection：以 Dataset 有效 clbs 为父级来源重建快照；Folder 递归子节点。 */
const syncOrphanCollection = async ({
  teamId,
  datasetId,
  collection,
  datasetEffectiveClbs,
  session
}: {
  teamId: string;
  datasetId: string;
  collection: CollectionForMigration;
  datasetEffectiveClbs: CollaboratorItemType[];
  session: ClientSession;
}) => {
  const resourceId = String(collection._id);
  const currentSnapshot = (await getResourceOwnedClbs({
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId,
    session
  })) as CollaboratorItemType[];

  const ownClbs = deriveOwnClbs(currentSnapshot, datasetEffectiveClbs, String(collection.tmbId));
  const newSnapshot = mergeCollaboratorList({
    parentClbs: datasetEffectiveClbs,
    childClbs: ownClbs
  });

  await syncCollectionCollaborators({
    teamId,
    resourceId,
    parentClbs: datasetEffectiveClbs,
    ownClbs,
    session
  });

  if (collection.type === DatasetCollectionTypeEnum.folder) {
    await syncCollectionChildrenPermission({
      teamId,
      datasetId,
      parentId: resourceId,
      oldParentClbs: currentSnapshot,
      newParentClbs: newSnapshot,
      session
    });
  }
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

/**
 * 校验所有继承态 Collection 的快照符合嵌套全快照模型：
 * `快照 = merge(父级有效 clbs, 自身 clbs)`，其中
 * - 根级 / orphan：父级有效 clbs = Dataset 有效 clbs；
 * - 嵌套：父级有效 clbs = 父 Folder 的**实际快照**（迁移刚写入，从 clbsByResource 读取）。
 * 自身 clbs 由 `deriveOwnClbs(实际快照, 父级有效 clbs)` 反推，验证实际快照是否为该模型的不动点。
 */
const validateCollectionSnapshots = async ({
  teamId,
  collections,
  cycles,
  datasetEffectiveClbs,
  session
}: {
  teamId: string;
  collections: CollectionForMigration[];
  cycles: string[];
  datasetEffectiveClbs: CollaboratorItemType[];
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

  const idToCollection = new Map(collections.map((c) => [String(c._id), c]));
  const isFolder = (c: CollectionForMigration) => c.type === DatasetCollectionTypeEnum.folder;

  for (const collection of collections) {
    const id = String(collection._id);
    if (collection.inheritPermission !== true || cycles.includes(id)) continue;

    // 父级有效 clbs：根级 / orphan → Dataset 有效；嵌套 → 父 Folder 的实际快照
    let parentSource: CollaboratorItemType[];
    if (!collection.parentId) {
      parentSource = datasetEffectiveClbs;
    } else {
      const parent = idToCollection.get(String(collection.parentId));
      if (parent && isFolder(parent)) {
        parentSource = normalizeClbs(clbsByResource.get(String(parent._id)) ?? []);
      } else {
        // orphan：父级缺失/非 Folder，按根级处理
        parentSource = datasetEffectiveClbs;
      }
    }

    const actual = normalizeClbs(clbsByResource.get(id) ?? []);
    const ownClbs = deriveOwnClbs(actual, parentSource, String(collection.tmbId));
    const expected = mergeCollaboratorList({ parentClbs: parentSource, childClbs: ownClbs });
    if (!sameClbs(expected, actual)) {
      issues.push(
        `collection snapshot mismatch for ${id}: expected ${expected.length} clbs, got ${actual.length}`
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
 *   Dataset is recorded and does not block the others (MG-005);
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

    const { cycles } = buildCollectionTree(collections);
    const idToCollection = new Map(collections.map((c) => [String(c._id), c]));
    const isFolder = (c: CollectionForMigration) => c.type === DatasetCollectionTypeEnum.folder;

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

      if (collection.inheritPermission !== true) {
        issues.push({ datasetId, collectionId: id, type: 'non_inherited' });
      }
      if (cycles.includes(id)) {
        // cyclic folder：未迁移版本，只校验 owner
        const owners = actual.filter((c) => c.permission === OwnerRoleVal);
        if (owners.length !== 1 || owners[0]?.tmbId !== String(collection.tmbId)) {
          issues.push({ datasetId, collectionId: id, type: 'owner_duplicate' });
        }
        continue;
      }

      // 嵌套模型：父级有效 clbs = 根级/orphan 用 Dataset 有效，嵌套用父 Folder 实际快照
      let parentSource: CollaboratorItemType[];
      if (!collection.parentId) {
        parentSource = datasetEffectiveClbs;
      } else {
        const parent = idToCollection.get(String(collection.parentId));
        if (parent && isFolder(parent)) {
          parentSource = normalizeClbs(clbsByResource.get(String(parent._id)) ?? []);
        } else {
          parentSource = datasetEffectiveClbs;
        }
      }
      const ownClbs = deriveOwnClbs(actual, parentSource, String(collection.tmbId));
      const expected = mergeCollaboratorList({ parentClbs: parentSource, childClbs: ownClbs });
      if (!sameClbs(expected, actual)) {
        issues.push({
          datasetId,
          collectionId: id,
          type: 'snapshot_mismatch',
          detail: `expected ${expected.length} clbs, got ${actual.length}`
        });
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

  return { checkedDatasets: groups.length, checkedCollections, issues };
};
