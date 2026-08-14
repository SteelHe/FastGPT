/**
 * 授权集合与元数据/forbid 条件的合并决策（-5）。
 *
 * 纯函数、无外部依赖，便于单测；multiQueryRecall 负责 DB 侧的总数查询后调用。
 *
 * 语义：
 * - effectiveCollectionIdList = (allowed ∩ filterCollectionIdList) - forbidCollectionIdList
 * - 交集为空 → isEmpty=true，直接返回空召回，不执行向量/全文检索（RF-003）。
 * - allowed 覆盖 Dataset 全部文件 Collection（isFullCollection）→ 不设置 collectionId 过滤，
 *   按 Dataset 级别召回（性能路径，RF-002）；仅真子集时设置 collectionId IN effectiveCollectionIdList（RF-004）。
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
 * @param allowedCollectionIdList 授权文件 Collection ID（未传表示未启用权限过滤，沿用旧行为）
 * @param filterCollectionIdList  元数据（标签/时间/指定 collection）过滤集合，undefined 表示无元数据条件
 * @param forbidCollectionIdList  forbid 集合（额外防线，不替代授权集合）
 * @param totalFileCollectionCount 当前 datasetIds 下实际文件 Collection 总数，用于全量判定
 *
 * @returns
 * - `isEmpty=true`：交集为空，上层应直接返回空召回。
 * - `collectionFilter=undefined`：不设置 collectionId 过滤（全量覆盖且无元数据，或未启用权限过滤）。
 * - `collectionFilter=[...]`：将该集合作为 collectionId IN 过滤下发。
 */
export const decideCollectionFilter = ({
  allowedCollectionIdList,
  filterCollectionIdList,
  forbidCollectionIdList,
  totalFileCollectionCount
}: {
  allowedCollectionIdList?: string[];
  filterCollectionIdList?: string[];
  forbidCollectionIdList: string[];
  totalFileCollectionCount?: number;
}): { isEmpty: boolean; collectionFilter?: string[] } => {
  if (allowedCollectionIdList === undefined) {
    // 未启用权限过滤：保持原有行为，沿用元数据 filter（forbid 由召回引擎额外处理）
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

  // 全量判定：allowed 必须与当前 Dataset 下实际文件 Collection 数量一致
  const isFullCollection =
    totalFileCollectionCount !== undefined &&
    allowedCollectionIdList.length === totalFileCollectionCount;

  return {
    isEmpty: false,
    // 全量覆盖：不设置 collectionId IN 过滤（性能路径），仍沿用元数据 filter + forbid；
    // 真子集：设置 collectionId IN effectiveCollectionIdList
    collectionFilter: isFullCollection ? filterCollectionIdList : effective
  };
};
