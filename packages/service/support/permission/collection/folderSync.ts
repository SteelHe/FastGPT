import { PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import type { ResourcePermissionType } from '@fastgpt/global/support/permission/type';
import type { CollaboratorItemType } from '@fastgpt/global/support/permission/collaborator';
import { mergeCollaboratorList } from '@fastgpt/global/support/permission/utils';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import type { ClientSession } from '../../../common/mongo';
import { MongoDatasetCollection } from '../../../core/dataset/collection/schema';
import { MongoDataset } from '../../../core/dataset/schema';
import { MongoResourcePermission } from '../schema';
import { syncChildrenPermission, syncCollaborators } from '../inheritPermission';

type DatasetFolderNode = {
  _id: string;
  parentId?: string | null;
  inheritPermission?: boolean;
};

/**
 * 将 Dataset 的协作者变更传播到其下（含所有后代 Dataset）Collection Folder 快照。
 *
 * 对每个 Dataset，取其 **parentId 为空且继承态** 的根 Collection Folder，复用通用原语：
 * - `syncCollaborators`：将 Dataset 有效 clbs（owner→manage）并入根 folder 自身快照（sumPer）；
 * - `syncChildrenPermission`：以根 folder 为资源向继承态子 folder 传播（sumPer）。
 * 非继承态 folder 不加载、不被覆盖（与 dataset folder 行为一致）。
 *
 * 每个后代 Dataset 的有效 clbs 自顶向下推导：
 * - `inheritPermission !== false` -> `merge(parentEffectiveClbs, ownClbs)`;
 * - `inheritPermission === false` -> `ownClbs`（独立配置，不覆盖）。
 *
 * 普通（非 folder）Collection 从不在此写入——鉴权时动态合并。
 * 幂等（差分写入 + resource_permissions 唯一键）。需在事务中与 dataset 权限变更一同调用。
 */
export async function syncDatasetCollectionFolders({
  teamId,
  datasetId,
  rootClbs,
  session
}: {
  teamId: string;
  datasetId: string;
  /** Dataset 有效协作者（父级+自身合并后，owner→manage 处理），作为根 Collection Folder 的父级来源。 */
  rootClbs: CollaboratorItemType[];
  session: ClientSession;
}): Promise<void> {
  // Collect the root dataset + all descendant datasets (folder / ordinary) so we can
  // derive each one's effective clbs and sync its Collection Folder tree.
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

  // Load current clbs of all descendant datasets in one batch (no N+1).
  const descendantIds = Array.from(datasetMap.keys());
  const allClbs = await MongoResourcePermission.find({
    resourceType: PerResourceTypeEnum.dataset,
    teamId,
    resourceId: { $in: descendantIds }
  })
    .lean()
    .session(session);

  const ownClbsMap = new Map<string, ResourcePermissionType[]>();
  for (const clb of allClbs) {
    const id = String(clb.resourceId);
    const arr = ownClbsMap.get(id) ?? [];
    arr.push(clb);
    ownClbsMap.set(id, arr);
  }

  // parentId -> children map for O(N) top-down traversal.
  const parentChildrenMap = new Map<string, string[]>();
  for (const childId of descendantIds) {
    const child = datasetMap.get(childId)!;
    const pid = child.parentId ?? 'null';
    const arr = parentChildrenMap.get(pid) ?? [];
    arr.push(childId);
    parentChildrenMap.set(pid, arr);
  }

  // BFS top-down: seed the root from rootClbs, derive descendants from parentEffective + own.
  const syncQueue: Array<{ currentId: string; effectiveClbs: CollaboratorItemType[] }> = [
    { currentId: datasetId, effectiveClbs: rootClbs }
  ];
  const visited = new Set<string>();

  while (syncQueue.length) {
    const { currentId, effectiveClbs } = syncQueue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    // Sync this dataset's inherited root Collection Folders through the generic primitives.
    await syncRootCollectionFolders({
      teamId,
      datasetId: currentId,
      rootClbs: effectiveClbs,
      session
    });

    for (const childId of parentChildrenMap.get(currentId) ?? []) {
      const child = datasetMap.get(childId)!;
      const ownClbs = ownClbsMap.get(childId) ?? [];
      const childEffective =
        child.inheritPermission === false
          ? ownClbs
          : mergeCollaboratorList({ parentClbs: effectiveClbs, childClbs: ownClbs });
      syncQueue.push({ currentId: childId, effectiveClbs: childEffective });
    }
  }
}

/**
 * 同步单个 Dataset 下的根 Collection Folder（parentId 为空且继承态）：
 * - `syncCollaborators`：并入 Dataset 有效 clbs（owner→manage，sumPer，不删除既有协作者）；
 * - `syncChildrenPermission`：向继承态子 folder 传播。传给子 folder 的 rootClbs 需先做
 *   owner→manage 映射——子 folder 继承的是根 folder 的实际快照（父级 owner 封顶为 manage），
 *   否则子 folder 会缺失父级 owner 的 manage 记录，与 `syncCollaborators` 写入根 folder
 *   的快照不一致（folder 鉴权只读自身快照，不能缺）。
 */
export const syncRootCollectionFolders = async ({
  teamId,
  datasetId,
  rootClbs,
  session
}: {
  teamId: string;
  datasetId: string;
  rootClbs: CollaboratorItemType[];
  session: ClientSession;
}): Promise<void> => {
  const rootFolders = await MongoDatasetCollection.find(
    {
      teamId,
      datasetId,
      type: DatasetCollectionTypeEnum.folder,
      parentId: null,
      inheritPermission: { $ne: false }
    },
    '_id'
  )
    .lean()
    .session(session);

  for (const rootFolder of rootFolders) {
    const rootId = String(rootFolder._id);
    // syncCollaborators 会原地把入参 owner 改为 manage，传副本避免污染 rootClbs
    await syncCollaborators({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: rootId,
      collaborators: rootClbs.map((clb) => ({ ...clb })),
      session
    });
    await syncChildrenPermission({
      resource: {
        _id: rootId,
        type: DatasetCollectionTypeEnum.folder,
        teamId,
        parentId: null
      },
      folderTypeList: [DatasetCollectionTypeEnum.folder],
      resourceType: PerResourceTypeEnum.collection,
      resourceModel: MongoDatasetCollection,
      session,
      collaborators: mergeCollaboratorList({ parentClbs: rootClbs, childClbs: [] })
    });
  }
};
