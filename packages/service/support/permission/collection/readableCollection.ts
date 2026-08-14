import {
  NullRoleVal,
  PerResourceTypeEnum,
  ReadPermissionVal,
  ReadRoleVal
} from '@fastgpt/global/support/permission/constant';
import { Permission } from '@fastgpt/global/support/permission/controller';
import type { PermissionValueType } from '@fastgpt/global/support/permission/type';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { getTmbInfoByTmbId } from '../../user/team/controller';
import { authDatasetByTmbId } from '../dataset/auth';
import { getGroupsByTmbId } from '../memberGroup/controllers';
import { getOrgIdSetWithParentByTmbId } from '../org/controllers';
import { MongoDatasetCollection } from '../../../core/dataset/collection/schema';
import { MongoDataset } from '../../../core/dataset/schema';
import { MongoResourcePermission } from '../schema';
import type { CollectionPermissionItemType } from './type';

/**
 * Construct the MongoResourcePermission query that matches the current member's
 * records for a batch of collection resourceIds.
 *
 * It filters by `resourceId: { $in }` + `$or` (tmbId / groupId / orgId), and uses
 * `permission: { $bitsAnySet: 0b111 }` on the query side so only records that hit
 * a standard role (read=0b100 / write=0b010 / manage=0b001) are kept; the owner's
 * full-bit value (4294967295) naturally matches. `permission = 0` deny-records and
 * high-bit-only custom roles are excluded here, avoiding a "record exists => readable"
 * bypass.
 *
 * NOTE (`$bitsAnySet` / owner double): the owner permission is
 * `~0 >>> 0` = 4294967295, which exceeds int32. Verified against a real MongoDB
 * (mongodb-memory-server): it is stored as a numeric value and `$bitsAnySet: 0b111`
 * matches owner records without error. If the Mongo driver ever starts storing it as
 * a BSON double and `$bitsAnySet` rejects it, store the owner permission as an Int32
 * (or switch to an in-memory role filter) — see `.cospowers/tasks/collection-permission-foundation/results.md`.
 */
export function buildPermissionQuery({
  teamId,
  resourceIds,
  tmbId,
  groupIds,
  orgIds
}: {
  teamId: string;
  resourceIds: string[];
  tmbId: string;
  groupIds: string[];
  orgIds: string[];
}): Record<string, unknown> {
  return {
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId: { $in: resourceIds },
    permission: { $bitsAnySet: 0b111 },
    $or: [
      { tmbId },
      ...(groupIds.length ? [{ groupId: { $in: groupIds } }] : []),
      ...(orgIds.length ? [{ orgId: { $in: orgIds } }] : [])
    ]
  };
}

/**
 * Batch-compute the readable (effective permission >= read) Collection IDs, shared
 * by list, detail and RAG recall. Keeps the same semantics as `resolveCollectionPermission`
 * but only does Collection-level filtering:
 * - readability is pushed down to the query side (`buildPermissionQuery`'s `$bitsAnySet`),
 *   so this is a single `distinct` query returning deduped IDs (no N+1);
 * - folder: reads its synced permission snapshot (own records are the full effective
 *   permission, no upward recursion);
 * - non-folder inherited: readable if self is readable, or its parent (Collection Folder
 *   snapshot, or root Dataset) is readable;
 * - non-inherited: only self readability.
 *
 * Precondition: the caller has already passed the Dataset `read` gate; a root-level
 * inherited Collection's readability depends on `datasetPermission` (the Dataset's
 * effective role), so an empty `parentId` alone never grants access.
 * Returns folder IDs too; RAG callers must recursively expand folders into their file
 * Collection IDs, and multi-Dataset recall must group by datasetId.
 */
export async function getReadableCollectionIds({
  collections,
  tmbId,
  teamId,
  groupIds,
  orgIds,
  datasetPermission,
  hasSetCollectionPermissions
}: {
  collections: CollectionPermissionItemType[];
  tmbId: string;
  teamId: string;
  groupIds: string[];
  orgIds: string[];
  /** 调用方已解析的 Dataset 有效角色（role 位掩码），用于根级继承态 Collection。 */
  datasetPermission: PermissionValueType;
  /** 所属 Dataset 是否配置过 Collection 级权限：`false` 时短路为 Dataset 级鉴权。 */
  hasSetCollectionPermissions?: boolean;
}): Promise<string[]> {
  if (collections.length === 0) return [];

  // 根级继承态 Collection 是否可读：依赖 Dataset 有效角色是否含 read（write/manage 隐式含 read）
  const datasetHasRead =
    datasetPermission != null &&
    new Permission({ role: datasetPermission, isOwner: false }).checkPer(ReadRoleVal);

  // 短路：Dataset 下无任何 Collection 自定义权限（纯继承）→
  // 每个 Collection 的有效权限 = Dataset 有效权限（folder 快照与 Dataset 链镜像一致）。
  // 调用方已通过 Dataset read 门槛，因此全部 Collection 可读，无需批量权限查询。
  if (hasSetCollectionPermissions === false) {
    return datasetHasRead ? collections.map((item) => String(item._id)) : [];
  }

  // 需要读取权限的资源：Collection 自身 + 其父 Collection Folder（继承判定用）
  const resourceIdSet = new Set<string>();
  for (const item of collections) {
    resourceIdSet.add(String(item._id));
    if (item.parentId) resourceIdSet.add(String(item.parentId));
  }

  // 一次查询、去重、只回 ID：可读判定已在查询端通过 $bitsAnySet 过滤
  const readableResourceIds = new Set(
    (
      await MongoResourcePermission.distinct(
        'resourceId',
        buildPermissionQuery({
          teamId,
          resourceIds: Array.from(resourceIdSet),
          tmbId,
          groupIds,
          orgIds
        })
      )
    ).map(String)
  );

  const readableIds: string[] = [];
  for (const item of collections) {
    const itemId = String(item._id);
    const parentId = item.parentId ? String(item.parentId) : null;
    const isFolder = item.type === DatasetCollectionTypeEnum.folder;

    const selfReadable = readableResourceIds.has(itemId);
    // 仅非 folder 继承态才继承父级；父级 = 父 Collection Folder（快照）或根级 Dataset
    const inheritedReadable =
      item.inheritPermission !== false &&
      !isFolder &&
      !!parentId &&
      readableResourceIds.has(parentId);
    // 根级继承态：父级为所属 Dataset，可读性依赖 datasetPermission
    const rootInheritedReadable =
      item.inheritPermission !== false && !isFolder && !parentId && datasetHasRead;

    if (selfReadable || inheritedReadable || rootInheritedReadable) {
      readableIds.push(itemId);
    }
  }

  return readableIds;
}

/**
 * 批量解析可读（有效权限 ≥ read）的实际文件 Collection ID。
 *
 * RAG 检索入口在 Dataset read 鉴权通过后调用，输入 teamId + datasetIds + tmbId，返回
 * 允许召回的**实际文件 Collection ID**（Folder 已递归展开为其下实际文件 ID，folder 本身
 * 不参与召回）。与 `getReadableCollectionIds` 复用同一语义：
 * - Dataset read 前置门槛：逐个 Dataset 调用 `authDatasetByTmbId(per: read)`，无 read 的
 *   Dataset 整体排除（RF-005，仅 collection 权限不能绕过 dataset 门槛）。
 * - 团队 owner/admin：在 Dataset read 门槛通过后直接返回该 Dataset 下全部文件 Collection ID，
 *   跳过逐 collection 权限解析（性能短路）。
 * - 普通成员：按 datasetId 分组调用 `getReadableCollectionIds`，group/org 权限记录同样生效。
 */
export async function resolveReadableCollectionIds({
  teamId,
  datasetIds,
  tmbId
}: {
  teamId: string;
  datasetIds: string[];
  tmbId: string;
}): Promise<string[]> {
  if (datasetIds.length === 0) return [];

  // 团队上下文校验 + owner/admin 判定（只解析一次 tmb 信息）
  const tmbInfo = await getTmbInfoByTmbId({ tmbId });
  if (String(tmbInfo.teamId) !== String(teamId)) return [];

  const isTeamOwnerOrAdmin = tmbInfo.permission.isOwner || tmbInfo.permission.hasManagePer;

  // 团队 owner/admin：跳过逐 collection 权限解析，但仍需逐 Dataset 通过 read 门槛
  if (isTeamOwnerOrAdmin) {
    return resolveOwnerAdminFileCollectionIds({ teamId, datasetIds, tmbId });
  }

  // 普通成员：批量读取 Dataset 下全部 Collection 最小字段，按 datasetId 分组解析
  const collections = await MongoDatasetCollection.find(
    {
      teamId,
      datasetId: { $in: datasetIds }
    },
    '_id datasetId parentId tmbId inheritPermission type'
  ).lean();

  const collectionsByDataset = new Map<string, CollectionPermissionItemType[]>();
  for (const item of collections) {
    const datasetId = String(item.datasetId);
    const list = collectionsByDataset.get(datasetId) ?? [];
    list.push({
      _id: item._id as never,
      tmbId: item.tmbId as never,
      parentId: item.parentId ? String(item.parentId) : null,
      inheritPermission: item.inheritPermission,
      type: item.type as never
    });
    collectionsByDataset.set(datasetId, list);
  }

  // group/org 权限记录在批量查询端生效（buildPermissionQuery 的 $or 分支）
  const [groupIds, orgIds] = await Promise.all([
    getGroupsByTmbId({ tmbId, teamId }).then((list) => list.map((item) => String(item._id))),
    getOrgIdSetWithParentByTmbId({ tmbId, teamId }).then((set) => Array.from(set).map(String))
  ]);

  // 批量加载各 Dataset 的 hasSetCollectionPermissions：显式 `false`（纯继承）时
  // 直接短路为 Dataset 级鉴权，跳过逐 Collection 批量权限查询（1 次查询替代 N+1 / distinct）。
  // 旧数据字段缺失（undefined）视为未知，不短路，走完整解析（正确性优先，迁移后统一为显式 false）。
  const datasetFlags = new Map<string, boolean | undefined>();
  const datasets = await MongoDataset.find(
    { _id: { $in: datasetIds } },
    'hasSetCollectionPermissions'
  ).lean();
  for (const ds of datasets) {
    datasetFlags.set(String(ds._id), ds.hasSetCollectionPermissions);
  }

  const readableIds = new Set<string>();
  for (const [datasetId, perDatasetCollections] of collectionsByDataset) {
    // Dataset read 前置门槛（RF-005）
    let datasetPermission: PermissionValueType;
    try {
      const { dataset } = await authDatasetByTmbId({
        tmbId,
        datasetId,
        per: ReadPermissionVal
      });
      datasetPermission = dataset.permission.role;
    } catch {
      continue;
    }

    const perDatasetReadable = await getReadableCollectionIds({
      collections: perDatasetCollections,
      tmbId,
      teamId,
      groupIds,
      orgIds,
      datasetPermission,
      hasSetCollectionPermissions: datasetFlags.get(datasetId)
    });
    perDatasetReadable.forEach((id) => readableIds.add(id));
  }

  return expandReadableFoldersToFileIds({
    allCollections: collections,
    readableIds
  });
}

/**
 * 团队 owner/admin 短路：Dataset read 门槛通过后，直接返回该 Dataset 下全部文件 Collection ID。
 * 只查询实际文件（type !== folder），folder 无需展开。
 */
const resolveOwnerAdminFileCollectionIds = async ({
  teamId,
  datasetIds,
  tmbId
}: {
  teamId: string;
  datasetIds: string[];
  tmbId: string;
}): Promise<string[]> => {
  const readableDatasetIds = new Set<string>();
  for (const datasetId of datasetIds) {
    try {
      await authDatasetByTmbId({ tmbId, datasetId, per: ReadPermissionVal });
      readableDatasetIds.add(datasetId);
    } catch {
      // 无 Dataset read → 排除该 Dataset
    }
  }
  if (readableDatasetIds.size === 0) return [];

  const collections = await MongoDatasetCollection.find(
    {
      teamId,
      datasetId: { $in: Array.from(readableDatasetIds) },
      type: { $ne: DatasetCollectionTypeEnum.folder }
    },
    '_id'
  ).lean();

  return collections.map((item) => String(item._id));
};

/**
 * 将可读集合（含 folder ID）展开为实际文件 Collection ID。
 *
 * `getReadableCollectionIds` 已对每个 Collection 单独判定可读性（继承态文件在可读 folder
 * 下即返回），因此这里把可读 folder 递归展开为其下可读文件，folder 本身不参与召回。
 * 非继承态私有文件即使位于可读 folder 下也不会被加入（readableIds 未包含）。
 */
const expandReadableFoldersToFileIds = ({
  allCollections,
  readableIds
}: {
  allCollections: Array<{ _id: unknown; parentId?: unknown; type: string }>;
  readableIds: Set<string>;
}): string[] => {
  const typeMap = new Map<string, string>();
  const childrenMap = new Map<string, string[]>();
  for (const item of allCollections) {
    const id = String(item._id);
    typeMap.set(id, item.type);
    if (item.parentId) {
      const parentId = String(item.parentId);
      const list = childrenMap.get(parentId) ?? [];
      list.push(id);
      childrenMap.set(parentId, list);
    }
  }

  const allowed = new Set<string>();
  for (const id of readableIds) {
    if (typeMap.get(id) !== DatasetCollectionTypeEnum.folder) {
      allowed.add(id);
      continue;
    }

    // 可读 folder → BFS 展开为其下可读文件 Collection ID
    const queue = [id];
    while (queue.length) {
      const current = queue.shift()!;
      for (const child of childrenMap.get(current) ?? []) {
        if (typeMap.get(child) === DatasetCollectionTypeEnum.folder) {
          queue.push(child);
        } else if (readableIds.has(child)) {
          allowed.add(child);
        }
      }
    }
  }

  return Array.from(allowed);
};
