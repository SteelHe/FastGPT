import { OwnerRoleVal, PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import type { CollaboratorItemType } from '@fastgpt/global/support/permission/collaborator';
import { mergeCollaboratorList } from '@fastgpt/global/support/permission/utils';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import type { ParentIdType } from '@fastgpt/global/common/parentFolder/type';
import type { ClientSession } from '../../../common/mongo';
import { getDatasetEffectiveClbs, getResourceOwnedClbs } from '../controller';
import { markDatasetCollectionPermissionsSet } from './datasetFlag';
import type { SyncChildrenPermissionResourceType } from '../inheritPermission';
import { MongoResourcePermission } from '../schema';
import { pickCollaboratorIdFields } from '../utils';

/**
 * 创建 Collection 时需要的资源最小字段。
 * - 继承 `SyncChildrenPermissionResourceType`（`_id / type / teamId / parentId`）；
 * - 追加 `datasetId`（所属 Dataset）；
 * - 追加 `tmbId`（创建者/owner，用于生成 owner 权限记录）。
 */
export type CollectionCreateResourceType = SyncChildrenPermissionResourceType & {
  datasetId: string;
  tmbId: string;
};

/**
 * 读取创建 Collection 时父级（Dataset 或父 Collection Folder）的**实际 clbs**：
 * - 有 parentId：读取父 Collection Folder 已同步的权限快照（folder 快照即完整有效权限）；
 * - 无 parentId（Dataset 根目录）：读取所属 Dataset 的**实际（有效）clbs**——自身 + 祖先
 *   Dataset Folder 链合并（`getDatasetEffectiveClbs`），而非仅 Dataset 自身的 `getResourceOwnedClbs`，
 *   否则会丢失从祖先 folder 继承的权限。
 */
export const getCollectionCreateParentClbs = async ({
  teamId,
  datasetId,
  parentId,
  session
}: {
  teamId: string;
  datasetId: string;
  parentId: ParentIdType;
  session: ClientSession;
}): Promise<CollaboratorItemType[]> => {
  if (parentId) {
    return getResourceOwnedClbs({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: parentId,
      session
    });
  }
  return getDatasetEffectiveClbs({ teamId, datasetId, session });
};

/**
 * 创建 Collection 时初始化权限记录：
 * - `inheritPermission=false`（独立态）：仅写入自身 owner 记录，不拷贝父级 clbs；
 * - 非 folder collection：仅写入自身 owner 记录（继承态权限在鉴权时动态合并父级）；
 * - folder collection 且 `inheritPermission=true`（默认）：全量拷贝父级 real clbs，
 *   父级 owner 降级为 manage，追加自身 owner 记录 → 快照落库（resourceType=collection）。
 *
 * 调用方需在 `mongoSessionRun` 事务中调用，保证与 Collection 文档创建原子。
 */
export async function createCollectionPermission({
  resource,
  parentClbs,
  inheritPermission,
  session
}: {
  resource: CollectionCreateResourceType;
  /** 父级（Dataset 或父 Collection Folder）有效 clbs。 */
  parentClbs: CollaboratorItemType[];
  inheritPermission: boolean;
  session: ClientSession;
}): Promise<void> {
  const teamId = resource.teamId;
  const resourceId = String(resource._id);
  const tmbId = resource.tmbId;
  const isFolder = resource.type === DatasetCollectionTypeEnum.folder;

  const ownerRecord: CollaboratorItemType = { tmbId, permission: OwnerRoleVal };

  // 独立态（inheritPermission=false）或非 folder collection：仅自身 owner 记录
  const writeOwnerOnly = async () => {
    // 独立态 → 所属 Dataset 标记已配置 Collection 权限（短路前提）
    if (!inheritPermission) {
      await markDatasetCollectionPermissionsSet({ datasetId: resource.datasetId, session });
    }
    await MongoResourcePermission.updateOne(
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId,
        tmbId
      },
      { $set: { permission: OwnerRoleVal } },
      { upsert: true, session }
    );
  };

  if (!inheritPermission || !isFolder) {
    return writeOwnerOnly();
  }

  // folder collection 且继承：快照 = 父级 real clbs（owner→manage 由 mergeCollaboratorList 完成）+ 自身 owner，
  // 直接落库。新 collection 的 resourceId 在该事务内刚生成，绝无既有权限记录，无需差异替换。
  const snapshot = mergeCollaboratorList({
    parentClbs,
    childClbs: [ownerRecord]
  });

  await MongoResourcePermission.insertMany(
    snapshot.map((clb) => ({
      permission: clb.permission,
      ...pickCollaboratorIdFields(clb),
      resourceId,
      teamId,
      resourceType: PerResourceTypeEnum.collection
    })),
    { session }
  );
}
