import { MongoDatasetCollection } from '../../collection/schema';
import { getTmbInfoByTmbId } from '@fastgpt/service/support/user/team/controller';
import { getGroupsByTmbId } from '@fastgpt/service/support/permission/memberGroup/controllers';
import { getOrgIdSetWithParentByTmbId } from '@fastgpt/service/support/permission/org/controllers';
import {
  canShortCircuitCollectionPermission,
  getReadableCollectionIds
} from '@fastgpt/service/support/permission/collection/auth';
import type { CollectionPermissionItemType } from '@fastgpt/service/support/permission/collection/auth';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { ReadRoleVal } from '@fastgpt/global/support/permission/constant';

/**
 * 授权集合与元数据/forbid 条件的合并决策（-5）。
 *
 * 纯函数、无外部依赖，便于单测；multiQueryRecall 负责 DB 侧的总数查询后调用。
 *
 * 语义：
 * - effective = (allowed ∩ filterCollectionIdList) - forbidCollectionIdList
 * - 交集为空 → isEmpty=true，直接返回空召回，不执行向量/全文检索（RF-003）。
 * - allowed === undefined → 无需 collectionId 过滤（未启用权限过滤，或授权集合已覆盖全部文件
 *   Collection），按 Dataset 级别召回（性能路径，RF-002）；仅真子集时设置
 *   collectionId IN effective（RF-004）。
 */

/**
 * 计算实际生效的 collectionId 过滤集合：
 * 授权集合 ∩ 元数据过滤集合 - forbid 集合。
 * `filterCollectionIdList` 未提供时表示无元数据 Collection 条件，有效集合 = allowed - forbid。
 */
export const computeEffectiveCollectionIdList = ({
  allowedCollectionIdList,
  filterCollectionIdList,
  forbidCollectionIdList
}: {
  allowedCollectionIdList: string[];
  filterCollectionIdList?: string[];
  forbidCollectionIdList: string[];
}): string[] => {
  if (allowedCollectionIdList.length === 0) return [];

  const base = filterCollectionIdList
    ? allowedCollectionIdList.filter((id) => filterCollectionIdList.includes(id))
    : allowedCollectionIdList.slice();

  if (forbidCollectionIdList.length === 0) return base;

  const forbidSet = new Set(forbidCollectionIdList);
  return base.filter((id) => !forbidSet.has(id));
};

/**
 * 决定下发到召回引擎的 collectionId 过滤条件。
 *
 * @param allowedCollectionIdList 授权文件 Collection ID（undefined 表示未启用权限过滤，
 *   或授权集合已覆盖当前 datasetIds 下全部文件 Collection → 沿用旧行为/性能路径）
 * @param filterCollectionIdList  元数据（标签/时间/指定 collection）过滤集合，undefined 表示无元数据条件
 * @param forbidCollectionIdList  forbid 集合（额外防线，不替代授权集合）
 *
 * @returns
 * - `isEmpty=true`：交集为空，上层应直接返回空召回。
 * - `collectionFilter=undefined`：不设置 collectionId 过滤（全量覆盖且无元数据，或未启用权限过滤）。
 * - `collectionFilter=[...]`：将该集合作为 collectionId IN 过滤下发。
 */
export const decideCollectionFilter = ({
  allowedCollectionIdList,
  filterCollectionIdList,
  forbidCollectionIdList
}: {
  allowedCollectionIdList?: string[];
  filterCollectionIdList?: string[];
  forbidCollectionIdList: string[];
}): { isEmpty: boolean; collectionFilter?: string[] } => {
  if (allowedCollectionIdList === undefined) {
    // 未启用权限过滤 / 授权覆盖全部文件 Collection：保持原有行为，沿用元数据 filter
    // （forbid 由召回引擎额外处理）
    return { isEmpty: false, collectionFilter: filterCollectionIdList };
  }

  if (allowedCollectionIdList.length === 0) {
    // 授权集合为空：用户无可读 collection（含 Dataset 被全部排除），必须返回空召回（RF-003/RF-005）
    return { isEmpty: true };
  }

  const effective = computeEffectiveCollectionIdList({
    allowedCollectionIdList,
    filterCollectionIdList,
    forbidCollectionIdList
  });

  if (effective.length === 0) {
    // 授权集合与元数据/forbid 求交集为空 → 直接返回空召回
    return { isEmpty: true };
  }

  return {
    isEmpty: false,
    // 真子集：设置 collectionId IN effective
    collectionFilter: effective
  };
};

/**
 * 批量解析可读（有效权限 ≥ read）的实际文件 Collection ID（设计 §7.3.2 step 2）。
 *
 * RAG 检索入口在 Dataset read 鉴权通过后调用，输入 teamId + datasetIds + tmbId。返回：
 * - `undefined`：**无需 Collection 级过滤**——团队 owner/admin、所有目标 Dataset 均为纯继承
 *   （`hasSetCollectionPermissions=false`，见 `canShortCircuitCollectionPermission`），或授权集合
 *   已覆盖全部文件 Collection（`readableIds.size === collections.length`）。此时检索层不设置
 *   `collectionId IN` 过滤，按 Dataset 级别召回（性能短路，设计 §7.3.2 step 4）。
 * - `string[]`：实际文件 Collection ID（**仅文件**，folder 不返回、无需展开），
 *   为真子集（用户仅可读部分文件 Collection）。
 *
 * 前置条件：调用方必须已按 Dataset read 过滤 `datasetIds`（RF-005 由调用方强制——仅 collection
 * 权限不能绕过 dataset 门槛）。本函数不再重复 Dataset read 鉴权，未过门槛的 Dataset 由调用方
 * （`authDataset` / `filterDatasetsByTmbId`）在传入前排除。
 *
 * 与 `getReadableCollectionIds` 复用同一语义；普通成员按 datasetId 分组、并行调用，group/org 权限生效。
 * 返回值 `allowedCollectionIdList` 交由 `computeEffectiveCollectionIdList` / `decideCollectionFilter`
 * 与元数据/forbid 条件合并，决定最终下发的 collectionId 过滤。
 */
export async function resolveReadableCollectionIds({
  teamId,
  datasetIds,
  tmbId
}: {
  teamId: string;
  datasetIds: string[];
  tmbId: string;
}): Promise<string[] | undefined> {
  if (datasetIds.length === 0) return [];

  const tmbInfo = await getTmbInfoByTmbId({ tmbId });
  if (String(tmbInfo.teamId) !== String(teamId)) return [];

  // 团队 owner/admin 或全部纯继承 → 无需 collection 级过滤（性能短路）
  if (await canShortCircuitCollectionPermission({ teamId, datasetIds, tmbId, tmbInfo })) {
    return undefined;
  }

  // 仅加载文件类型 Collection（全快照下 folder 自身快照即可判定可读性，结果只需文件 ID）
  const collections = await MongoDatasetCollection.find(
    {
      teamId,
      datasetId: { $in: datasetIds },
      type: { $ne: DatasetCollectionTypeEnum.folder }
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

  // 按 datasetId 并行解析可读 ID（各 Dataset 独立，互不依赖）
  const perDatasetReadableLists = await Promise.all(
    Array.from(collectionsByDataset.entries()).map(async ([, perDatasetCollections]) =>
      getReadableCollectionIds({
        collections: perDatasetCollections,
        tmbId,
        teamId,
        groupIds,
        orgIds,
        // 调用方已过 Dataset read 门槛 → 有效角色至少为 read
        datasetPermission: ReadRoleVal
      })
    )
  );

  const readableIds = new Set<string>();
  perDatasetReadableLists.forEach((list) => list.forEach((id) => readableIds.add(id)));

  // 授权集合覆盖全部文件 Collection → 无需 collection 级过滤（性能路径，RF-002）
  if (readableIds.size === collections.length) {
    return undefined;
  }

  return Array.from(readableIds);
}
