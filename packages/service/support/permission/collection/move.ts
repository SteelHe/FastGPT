import { OwnerRoleVal, PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import type { CollaboratorItemType } from '@fastgpt/global/support/permission/collaborator';
import { mergeCollaboratorList } from '@fastgpt/global/support/permission/utils';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import type { DatasetCollectionSchemaType } from '@fastgpt/global/core/dataset/type';
import type { ParentIdType } from '@fastgpt/global/common/parentFolder/type';
import type { ClientSession } from '../../../common/mongo';
import { MongoDatasetCollection } from '../../../core/dataset/collection/schema';
import { getDatasetEffectiveClbs, getResourceOwnedClbs } from '../controller';
import { syncChildrenPermission, syncCollaborators } from '../inheritPermission';
import { markDatasetCollectionPermissionsSet } from './datasetFlag';

/** 移动 Collection 所需的最小字段。 */
export type CollectionMoveResourceType = Pick<
  DatasetCollectionSchemaType,
  '_id' | 'type' | 'teamId' | 'parentId' | 'datasetId' | 'tmbId' | 'inheritPermission'
>;

/**
 * 移动 Collection 时的权限处理（与 Dataset move 语义一致）：
 * - `inheritPermission=false`：仅更新 parentId，保留自身独立 clbs，不继承目标父级 clbs；
 * - `inheritPermission=true`（默认）：
 *   - 目标父级 clbs = 目标父 Collection Folder 快照；`targetParentId` 为空（根目录）时，
 *     父级为所属 Dataset，取 Dataset 有效 clbs；
 *   - folder：`syncCollaborators` 将目标父级 clbs 并入自身（owner→manage，sumPer 保留自身
 *     独立 clbs 与 owner），再经 `syncChildrenPermission` 向继承态子 Collection Folder 传播；
 *   - 非 folder：`syncCollaborators` 将目标父级 clbs 合并到自身，保留自身独立 clbs。
 * - 最后更新 parentId 并置 `inheritPermission=true`。
 *
 * 调用方需在 `mongoSessionRun` 事务中调用，并先执行 `checkMoveFolderDepth` 校验。
 */
export async function moveCollectionPermission({
  collection,
  targetParentId,
  inheritPermission,
  session
}: {
  collection: CollectionMoveResourceType;
  /** 目标位置（null 表示根目录）。 */
  targetParentId: ParentIdType;
  inheritPermission: boolean;
  session: ClientSession;
}): Promise<void> {
  const teamId = collection.teamId;
  const resourceId = String(collection._id);

  // CM-005: 保持独立配置，仅更新 parentId
  if (inheritPermission === false) {
    // 独立态 move → 所属 Dataset 标记已配置 Collection 权限（短路前提）
    await markDatasetCollectionPermissionsSet({ datasetId: collection.datasetId, session });
    await MongoDatasetCollection.updateOne(
      { _id: collection._id },
      { $set: { parentId: targetParentId || null, inheritPermission: false } },
      { session }
    );
    return;
  }

  // CM-004: 目标父级 clbs——null 表示根目录，父级为所属 Dataset，取 Dataset 有效 clbs
  const parentClbs: CollaboratorItemType[] = targetParentId
    ? await getResourceOwnedClbs({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: targetParentId,
        session
      })
    : await getDatasetEffectiveClbs({
        teamId,
        datasetId: collection.datasetId,
        session
      });

  const isFolder = collection.type === DatasetCollectionTypeEnum.folder;

  if (isFolder) {
    // 被移动 folder：将目标父级 clbs 并入自身快照（owner→manage，sumPer 保留自身独立 clbs 与 owner），
    // 再经 syncChildrenPermission 向继承态子 Collection Folder 传播（与 Dataset move 语义一致）。
    await syncCollaborators({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId,
      // syncCollaborators 会原地把入参 owner 改为 manage，传副本避免污染 parentClbs
      collaborators: parentClbs.map((clb) => ({ ...clb })),
      session
    });
    await syncChildrenPermission({
      resource: {
        _id: resourceId,
        type: DatasetCollectionTypeEnum.folder,
        teamId,
        parentId: collection.parentId ? String(collection.parentId) : null
      },
      folderTypeList: [DatasetCollectionTypeEnum.folder],
      resourceType: PerResourceTypeEnum.collection,
      resourceModel: MongoDatasetCollection,
      session,
      // 子 folder 继承的目标快照 = merge(目标父级 clbs, [自身 owner])
      collaborators: mergeCollaboratorList({
        parentClbs,
        childClbs: [{ tmbId: String(collection.tmbId), permission: OwnerRoleVal }]
      })
    });
  } else {
    // 非 folder：合并目标父级 clbs 到自身，保留自身独立 clbs
    await syncCollaborators({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId,
      collaborators: parentClbs,
      session
    });
  }

  await MongoDatasetCollection.updateOne(
    { _id: collection._id },
    { $set: { parentId: targetParentId || null, inheritPermission: true } },
    { session }
  );
}
