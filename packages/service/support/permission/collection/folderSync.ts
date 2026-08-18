import { PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import type { ResourcePermissionType } from '@fastgpt/global/support/permission/type';
import type { CollaboratorItemType } from '@fastgpt/global/support/permission/collaborator';
import { getCollaboratorId, mergeCollaboratorList } from '@fastgpt/global/support/permission/utils';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import type { ClientSession, AnyBulkWriteOperation } from '../../../common/mongo';
import { MongoDatasetCollection } from '../../../core/dataset/collection/schema';
import { MongoDataset } from '../../../core/dataset/schema';
import { MongoResourcePermission } from '../schema';
import { getResourceOwnedClbs } from '../controller';
import { pickCollaboratorIdFields } from '../utils';

type DatasetFolderNode = {
  _id: string;
  parentId?: string | null;
  inheritPermission?: boolean;
};

/**
 * 从资源当前存储的快照中拆出「自身 clbs」：与父级（同 id）权限不一致、或父级不存在的协作者
 * 视为自身贡献。**owner 始终保留**（即使父级恰好是同一 tmbId 的 owner，子资源的 owner 也是
 * 自身记录，不能被当作继承剔除）。父级完全变化（移动、恢复继承、独立态切换、权限变更传播）时，
 * 用它恢复该资源的独立配置。
 */
export const deriveOwnClbs = (
  currentClbs: CollaboratorItemType[],
  parentClbs: CollaboratorItemType[],
  ownerTmbId?: string
): CollaboratorItemType[] => {
  const parentMap = new Map(parentClbs.map((clb) => [getCollaboratorId(clb), clb]));
  return currentClbs.filter((clb) => {
    // owner 永远是资源自身的记录
    if (ownerTmbId && clb.tmbId && String(clb.tmbId) === String(ownerTmbId)) return true;
    const parentClb = parentMap.get(getCollaboratorId(clb));
    return !parentClb || parentClb.permission !== clb.permission;
  });
};

/**
 * 计算资源快照 = `merge(parentClbs, ownClbs)`，并以 **diff 方式** 替换该资源当前存储的快照
 * （只写有变化的记录，幂等）。继承态 Collection 的完整有效协作者快照由此生成。
 */
export async function syncCollectionCollaborators({
  teamId,
  resourceId,
  parentClbs,
  ownClbs,
  session
}: {
  teamId: string;
  resourceId: string;
  /** 父级有效 clbs（根级 Collection 传 Dataset 有效 clbs；独立态传空数组）。 */
  parentClbs: CollaboratorItemType[];
  /** 资源自身 clbs（owner + 独立配置的协作者）。 */
  ownClbs: CollaboratorItemType[];
  session: ClientSession;
}): Promise<void> {
  const targetClbs = mergeCollaboratorList({ parentClbs, childClbs: ownClbs });
  const currentClbs = (await getResourceOwnedClbs({
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId,
    session
  })) as CollaboratorItemType[];

  const ops = buildSnapshotDiffOps({ teamId, resourceId, currentClbs, targetClbs });
  if (ops.length > 0) {
    await MongoResourcePermission.bulkWrite(ops, { session });
  }
}

/** 构造 `currentClbs` → `targetClbs` 的 bulkWrite 操作（insert / update $set / delete）。 */
const buildSnapshotDiffOps = ({
  teamId,
  resourceId,
  currentClbs,
  targetClbs
}: {
  teamId: string;
  resourceId: string;
  currentClbs: CollaboratorItemType[];
  targetClbs: CollaboratorItemType[];
}): AnyBulkWriteOperation<ResourcePermissionType>[] => {
  const ops: AnyBulkWriteOperation<ResourcePermissionType>[] = [];
  const currentMap = new Map(currentClbs.map((clb) => [getCollaboratorId(clb), clb]));
  const targetMap = new Map(targetClbs.map((clb) => [getCollaboratorId(clb), clb]));

  for (const target of targetClbs) {
    const id = getCollaboratorId(target);
    const current = currentMap.get(id);
    if (!current) {
      ops.push({
        insertOne: {
          document: {
            resourceId,
            teamId,
            resourceType: PerResourceTypeEnum.collection,
            permission: target.permission,
            ...pickCollaboratorIdFields(target)
          } as ResourcePermissionType
        }
      });
    } else if (current.permission !== target.permission) {
      ops.push({
        updateOne: {
          filter: {
            resourceId,
            teamId,
            resourceType: PerResourceTypeEnum.collection,
            ...pickCollaboratorIdFields(target)
          },
          update: { $set: { permission: target.permission } }
        }
      });
    }
  }

  for (const current of currentClbs) {
    if (!targetMap.has(getCollaboratorId(current))) {
      ops.push({
        deleteOne: {
          filter: {
            resourceId,
            teamId,
            resourceType: PerResourceTypeEnum.collection,
            ...pickCollaboratorIdFields(current)
          }
        }
      });
    }
  }

  return ops;
};

/**
 * 把父级（Dataset 或父 Collection Folder）的有效 clbs 变更同步到其下所有继承态 Collection
 * （Folder 与非 Folder）的快照。对每个子 Collection：
 * 1. 用 `deriveOwnClbs(当前快照, 旧父级)` 恢复自身 clbs；
 * 2. 目标快照 = `merge(新父级, 自身 clbs)`；
 * 3. 以 diff 方式写入（支持权限降级：从高到低精确覆盖，而非仅 sumPer 升级）。
 * 若子节点是 Folder，更新完自身快照后，用「子节点旧快照 → 子节点新快照」递归同步其子节点。
 *
 * 非继承态子节点（`inheritPermission === false`）不加载、不覆盖，其子树也随之跳过。
 */
export async function syncCollectionChildrenPermission({
  teamId,
  datasetId,
  parentId,
  oldParentClbs,
  newParentClbs,
  session
}: {
  teamId: string;
  datasetId: string;
  /** 父级 resourceId；null 表示 Dataset 根目录。 */
  parentId: string | null;
  /** 父级旧有效 clbs（用于拆出子节点自身 clbs）。 */
  oldParentClbs: CollaboratorItemType[];
  /** 父级新有效 clbs（子节点快照的父级来源）。 */
  newParentClbs: CollaboratorItemType[];
  session: ClientSession;
}): Promise<void> {
  const children = await MongoDatasetCollection.find(
    {
      teamId,
      datasetId,
      parentId,
      inheritPermission: { $ne: false }
    },
    '_id type tmbId'
  )
    .lean()
    .session(session);

  if (children.length === 0) return;

  // 批量加载所有子节点当前快照（无 N+1）
  const childIds = children.map((c) => c._id);
  const allClbs = await MongoResourcePermission.find({
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId: { $in: childIds }
  })
    .lean()
    .session(session);

  const snapshotMap = new Map<string, CollaboratorItemType[]>();
  for (const clb of allClbs) {
    const rid = String(clb.resourceId);
    const arr = snapshotMap.get(rid) ?? [];
    arr.push(clb);
    snapshotMap.set(rid, arr);
  }

  // 收集所有子节点的替换操作，一次性 bulkWrite
  const ops: AnyBulkWriteOperation<ResourcePermissionType>[] = [];
  const folderChildren: Array<{
    childId: string;
    oldSnapshot: CollaboratorItemType[];
    newSnapshot: CollaboratorItemType[];
  }> = [];

  for (const child of children) {
    const childId = String(child._id);
    const oldSnapshot = snapshotMap.get(childId) ?? [];
    const ownClbs = deriveOwnClbs(
      oldSnapshot,
      oldParentClbs,
      child.tmbId ? String(child.tmbId) : undefined
    );
    const newSnapshot = mergeCollaboratorList({ parentClbs: newParentClbs, childClbs: ownClbs });

    ops.push(
      ...buildSnapshotDiffOps({
        teamId,
        resourceId: childId,
        currentClbs: oldSnapshot,
        targetClbs: newSnapshot
      })
    );

    if (child.type === DatasetCollectionTypeEnum.folder) {
      folderChildren.push({ childId, oldSnapshot, newSnapshot });
    }
  }

  if (ops.length > 0) {
    await MongoResourcePermission.bulkWrite(ops, { session });
  }

  // 递归同步 Folder 子节点的子节点
  for (const { childId, oldSnapshot, newSnapshot } of folderChildren) {
    await syncCollectionChildrenPermission({
      teamId,
      datasetId,
      parentId: childId,
      oldParentClbs: oldSnapshot,
      newParentClbs: newSnapshot,
      session
    });
  }
}

/**
 * 同步单个 Dataset 下所有根级继承态 Collection（Folder 与非 Folder）的快照：
 * 父级来源 = Dataset 有效 clbs。旧有效 clbs 用于从现有快照中拆出各 Collection 自身 clbs。
 */
export async function syncRootCollections({
  teamId,
  datasetId,
  oldRootClbs,
  rootClbs,
  session
}: {
  teamId: string;
  datasetId: string;
  /** Dataset 旧有效 clbs（变更前）。 */
  oldRootClbs: CollaboratorItemType[];
  /** Dataset 新有效 clbs（变更后，作为根级 Collection 的父级来源）。 */
  rootClbs: CollaboratorItemType[];
  session: ClientSession;
}): Promise<void> {
  return syncCollectionChildrenPermission({
    teamId,
    datasetId,
    parentId: null,
    oldParentClbs: oldRootClbs,
    newParentClbs: rootClbs,
    session
  });
}

/**
 * 将 Dataset（及其继承态后代 Dataset）的协作者变更传播到其下所有继承态 Collection 快照。
 *
 * 对每个 Dataset，取其根级继承态 Collection（`parentId: null`），用 `syncRootCollections`
 * 以「旧/新有效 clbs」diff 更新快照。每个后代 Dataset 的有效 clbs 自顶向下推导：
 * - `inheritPermission !== false` -> `merge(父级有效 clbs, 自身 clbs)`；
 * - `inheritPermission === false` -> 独立配置，不传播、不同步。
 *
 * 幂等（diff 写入 + resource_permissions 唯一键）。需在事务中与 dataset 权限变更一同调用。
 */
export async function syncDatasetCollectionFolders({
  teamId,
  datasetId,
  oldRootClbs,
  rootClbs,
  session
}: {
  teamId: string;
  datasetId: string;
  /** Dataset 旧有效 clbs（变更前）。 */
  oldRootClbs: CollaboratorItemType[];
  /** Dataset 新有效 clbs（变更后）。 */
  rootClbs: CollaboratorItemType[];
  session: ClientSession;
}): Promise<void> {
  // 收集 root dataset + 所有继承态后代 dataset，自顶向下推导各自的有效 clbs
  const datasetMap = new Map<string, DatasetFolderNode>();
  const collectQueue = [datasetId];
  while (collectQueue.length) {
    const currentId = collectQueue.shift()!;
    const children = await MongoDataset.find(
      { teamId, parentId: currentId },
      '_id parentId inheritPermission'
    )
      .lean()
      .session(session);
    for (const child of children) {
      const childId = String(child._id);
      datasetMap.set(childId, {
        _id: childId,
        parentId: child.parentId ? String(child.parentId) : null,
        inheritPermission: child.inheritPermission
      });
      collectQueue.push(childId);
    }
  }

  // 加载所有后代 dataset 自身 clbs（无 N+1）
  const descendantIds = Array.from(datasetMap.keys());
  const allClbs = await MongoResourcePermission.find({
    resourceType: PerResourceTypeEnum.dataset,
    teamId,
    resourceId: { $in: descendantIds }
  })
    .lean()
    .session(session);

  const ownClbsMap = new Map<string, CollaboratorItemType[]>();
  for (const clb of allClbs) {
    const id = String(clb.resourceId);
    const arr = ownClbsMap.get(id) ?? [];
    arr.push(clb);
    ownClbsMap.set(id, arr);
  }

  // parentId -> children map
  const parentChildrenMap = new Map<string, string[]>();
  for (const childId of descendantIds) {
    const child = datasetMap.get(childId)!;
    const pid = child.parentId ?? 'null';
    const arr = parentChildrenMap.get(pid) ?? [];
    arr.push(childId);
    parentChildrenMap.set(pid, arr);
  }

  // BFS top-down：seed 用 root dataset 的旧/新有效 clbs
  const syncQueue: Array<{
    currentId: string;
    oldEffectiveClbs: CollaboratorItemType[];
    newEffectiveClbs: CollaboratorItemType[];
  }> = [{ currentId: datasetId, oldEffectiveClbs: oldRootClbs, newEffectiveClbs: rootClbs }];
  const visited = new Set<string>();

  while (syncQueue.length) {
    const { currentId, oldEffectiveClbs, newEffectiveClbs } = syncQueue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    await syncRootCollections({
      teamId,
      datasetId: currentId,
      oldRootClbs: oldEffectiveClbs,
      rootClbs: newEffectiveClbs,
      session
    });

    for (const childId of parentChildrenMap.get(currentId) ?? []) {
      const child = datasetMap.get(childId)!;
      if (child.inheritPermission === false) continue;
      const ownClbs = ownClbsMap.get(childId) ?? [];
      syncQueue.push({
        currentId: childId,
        oldEffectiveClbs: mergeCollaboratorList({
          parentClbs: oldEffectiveClbs,
          childClbs: ownClbs
        }),
        newEffectiveClbs: mergeCollaboratorList({
          parentClbs: newEffectiveClbs,
          childClbs: ownClbs
        })
      });
    }
  }
}
