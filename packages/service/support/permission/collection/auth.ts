import {
  NullRoleVal,
  PerResourceTypeEnum,
  ReadRoleVal
} from '@fastgpt/global/support/permission/constant';
import { Permission } from '@fastgpt/global/support/permission/controller';
import type { PermissionValueType } from '@fastgpt/global/support/permission/type';
import { getTmbInfoByTmbId } from '../../user/team/controller';
import { MongoDataset } from '../../../core/dataset/schema';
import { MongoResourcePermission } from '../schema';
import { getTmbPermission } from '../controller';
import type { DatasetCollectionSchemaType } from '@fastgpt/global/core/dataset/type';

/**
 * The minimal fields of a `dataset_collections` document that are required to
 * resolve collection-level permissions.
 */
export type CollectionPermissionItemType = Pick<
  DatasetCollectionSchemaType,
  '_id' | 'tmbId' | 'parentId' | 'inheritPermission' | 'type'
>;

/**
 * Resolve the effective permission of a single Collection for a team member.
 *
 * 全快照模型下，Collection 的 `resource_permissions` 已存完整有效协作者快照（父级贡献已并入），
 * 因此直接读自身快照即可，无需向上递归合并父级。
 *
 * `groupIds` / `orgIds` / `datasetPermission` 为兼容既有调用方保留的形参，本函数不再使用。
 */
export async function resolveCollectionPermission({
  collection,
  tmbId,
  teamId
}: {
  collection: CollectionPermissionItemType;
  tmbId: string;
  teamId: string;
  groupIds: string[];
  orgIds: string[];
  /** 已弃用：全快照下根级 Collection 的 Dataset 贡献已并入自身快照。 */
  datasetPermission: PermissionValueType;
}): Promise<PermissionValueType> {
  return (
    (await getTmbPermission({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      tmbId,
      resourceId: String(collection._id)
    })) ?? NullRoleVal
  );
}

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
 * matches owner records without error.
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
 * by list, detail and RAG recall.
 *
 * 全快照模型下，每个 Collection 的快照都是完整有效权限，因此可读性判定只需查询目标
 * Collection 自身的 `resource_permissions`（`buildPermissionQuery` 的 `$bitsAnySet`
 * 在查询端完成过滤），无需再加载父 Folder / Dataset 做继承判定。
 *
 * `hasSetCollectionPermissions === false` 时短路为 Dataset 级鉴权（纯继承 → 全部可读）。
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
  /** Dataset 有效角色（role 位掩码），仅用于纯继承短路。 */
  datasetPermission: PermissionValueType;
  /** 所属 Dataset 是否配置过 Collection 级权限：`false` 时短路为 Dataset 级鉴权。 */
  hasSetCollectionPermissions?: boolean;
}): Promise<string[]> {
  if (collections.length === 0) return [];

  const datasetHasRead =
    datasetPermission != null &&
    new Permission({ role: datasetPermission, isOwner: false }).checkPer(ReadRoleVal);

  // 短路：Dataset 下无任何 Collection 自定义权限（纯继承）→ 调用方已通过 Dataset read 门槛，
  // 全部 Collection 可读，无需批量权限查询。
  if (hasSetCollectionPermissions === false) {
    return datasetHasRead ? collections.map((item) => String(item._id)) : [];
  }

  const readableResourceIds = new Set(
    (
      await MongoResourcePermission.distinct(
        'resourceId',
        buildPermissionQuery({
          teamId,
          resourceIds: collections.map((item) => String(item._id)),
          tmbId,
          groupIds,
          orgIds
        })
      )
    ).map(String)
  );

  return collections
    .filter((item) => readableResourceIds.has(String(item._id)))
    .map((item) => String(item._id));
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
