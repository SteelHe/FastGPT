import { OwnerRoleVal, PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import type { CollaboratorItemType } from '@fastgpt/global/support/permission/collaborator';
import type { ResourcePermissionType } from '@fastgpt/global/support/permission/type';
import { mergeCollaboratorList } from '@fastgpt/global/support/permission/utils';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import type { DatasetCollectionSchemaType } from '@fastgpt/global/core/dataset/type';
import type { ParentIdType } from '@fastgpt/global/common/parentFolder/type';
import type { ClientSession, AnyBulkWriteOperation } from '../../../common/mongo';
import { MongoDatasetCollection } from '../../../core/dataset/collection/schema';
import { getResourceOwnedClbs } from '../controller';
import { syncChildrenPermission, syncCollaborators } from '../inheritPermission';
import { MongoResourcePermission } from '../schema';
import { getCollaboratorId } from '@fastgpt/global/support/permission/utils';
import { pickCollaboratorIdFields } from '../utils';
import { markDatasetCollectionPermissionsSet } from './datasetFlag';

/** 移动 Collection 所需的最小字段。 */
export type CollectionMoveResourceType = Pick<
  DatasetCollectionSchemaType,
  '_id' | 'type' | 'teamId' | 'parentId' | 'datasetId' | 'tmbId' | 'inheritPermission'
>;

/** 全量替换一个 Collection 的权限快照（differential，幂等；删除不在目标快照中的旧 clb）。 */
const replaceCollectionSnapshot = async ({
  teamId,
  resourceId,
  snapshot,
  session
}: {
  teamId: string;
  resourceId: string;
  snapshot: CollaboratorItemType[];
  session: ClientSession;
}) => {
  const currentClbs = await MongoResourcePermission.find({
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId
  })
    .lean()
    .session(session);

  const ops: AnyBulkWriteOperation<ResourcePermissionType>[] = [];
  const currentMap = new Map(currentClbs.map((clb) => [getCollaboratorId(clb), clb]));
  const targetMap = new Map(snapshot.map((clb) => [getCollaboratorId(clb), clb]));

  for (const targetClb of snapshot) {
    const id = getCollaboratorId(targetClb);
    const existing = currentMap.get(id);
    if (!existing) {
      ops.push({
        insertOne: {
          document: {
            resourceType: PerResourceTypeEnum.collection,
            teamId,
            resourceId,
            ...pickCollaboratorIdFields(targetClb),
            permission: targetClb.permission
          } as ResourcePermissionType
        }
      });
    } else if (existing.permission !== targetClb.permission) {
      ops.push({
        updateOne: {
          filter: {
            resourceType: PerResourceTypeEnum.collection,
            teamId,
            resourceId,
            ...pickCollaboratorIdFields(targetClb)
          },
          update: {
            permission: targetClb.permission
          }
        }
      });
    }
  }

  for (const currentClb of currentClbs) {
    if (!targetMap.has(getCollaboratorId(currentClb))) {
      ops.push({
        deleteOne: {
          filter: {
            resourceType: PerResourceTypeEnum.collection,
            teamId,
            resourceId,
            ...pickCollaboratorIdFields(currentClb)
          }
        }
      });
    }
  }

  if (ops.length > 0) {
    await MongoResourcePermission.bulkWrite(ops, { session });
  }
};

/**
 * 移动 Collection 时的权限处理：
 * - `inheritPermission=false`：仅更新 parentId，保留自身独立 clbs，不继承目标父级 clbs；
 * - `inheritPermission=true`（默认）：
 *   - folder：全量替换自身快照 = merge(目标父级 clbs, [自身 owner])，删除源目录特有旧 clb；
 *     并按 `rootId` 作用域同步继承态子 Collection Folder 快照；
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

  // CM-004: 读取目标父级 clbs（null 表示根目录，clbs 为空）
  const parentClbs: CollaboratorItemType[] = targetParentId
    ? await getResourceOwnedClbs({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: targetParentId,
        session
      })
    : [];

  const isFolder = collection.type === DatasetCollectionTypeEnum.folder;

  if (isFolder) {
    // 被移动 folder：快照 = 目标父级 clbs（owner→manage）+ 自身 owner，删除源目录特有旧 clb
    const snapshot = mergeCollaboratorList({
      parentClbs,
      childClbs: [{ tmbId: String(collection.tmbId), permission: OwnerRoleVal }]
    });
    await replaceCollectionSnapshot({ teamId, resourceId, snapshot, session });

    // 同步继承态子 Collection Folder 快照（通用 syncChildrenPermission；自身快照已在上面写入）
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
      collaborators: snapshot
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
