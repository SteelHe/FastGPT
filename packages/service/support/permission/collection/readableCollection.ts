import { PerResourceTypeEnum, ReadRoleVal } from '@fastgpt/global/support/permission/constant';
import { Permission } from '@fastgpt/global/support/permission/controller';
import type { PermissionValueType } from '@fastgpt/global/support/permission/type';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { getTmbInfoByTmbId } from '../../user/team/controller';
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
 * 判断 Collection 级权限是否可整体短路（无需逐 collection 解析）：
 * - 团队 owner/admin：对该团队全部 dataset 可读；
 * - 普通成员：所有目标 Dataset 均为纯继承（`hasSetCollectionPermissions=false`），
 *   每个 Collection 有效权限 = Dataset 有效权限。
 *
 * 满足时返回 `true`，调用方（RAG 检索 / Collection 列表）可跳过 collection 权限过滤，
 * 按 Dataset / 目录级别处理以节省性能。
 * 前置条件：调用方已按 Dataset read 过滤 `datasetIds`；本函数不做 Dataset read 鉴权。
 */
export async function canShortCircuitCollectionPermission({
  teamId,
  datasetIds,
  tmbId,
  tmbInfo
}: {
  teamId: string;
  datasetIds: string[];
  tmbId: string;
  /** 可选：已解析的 tmb 信息，避免重复查询。 */
  tmbInfo?: Awaited<ReturnType<typeof getTmbInfoByTmbId>>;
}): Promise<boolean> {
  if (datasetIds.length === 0) return true;

  const info = tmbInfo ?? (await getTmbInfoByTmbId({ tmbId }));
  if (String(info.teamId) !== String(teamId)) return false;
  if (info.permission.isOwner || info.permission.hasManagePer) return true;

  // 普通成员：全部 Dataset 显式 false（纯继承）才短路；旧数据 undefined 视为未知，不短路。
  const datasets = await MongoDataset.find(
    { _id: { $in: datasetIds } },
    'hasSetCollectionPermissions'
  ).lean();
  const flags = new Map<string, boolean | undefined>(
    datasets.map((ds) => [String(ds._id), ds.hasSetCollectionPermissions])
  );
  return datasetIds.every((id) => flags.get(id) === false);
}
