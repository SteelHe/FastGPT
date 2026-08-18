import { OwnerRoleVal, PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import type { CollaboratorItemType } from '@fastgpt/global/support/permission/collaborator';
import {
  checkRoleUpdateConflict,
  mergeCollaboratorList
} from '@fastgpt/global/support/permission/utils';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import type { ParentIdType } from '@fastgpt/global/common/parentFolder/type';
import type { ClientSession } from '../../../common/mongo';
import { mongoSessionRun } from '../../../common/mongo/sessionRun';
import { MongoDatasetCollection } from '../../../core/dataset/collection/schema';
import { getDatasetEffectiveClbs, getResourceOwnedClbs } from '../controller';
import { markDatasetCollectionPermissionsSet } from './datasetFlag';
import { MongoResourcePermission } from '../schema';
import { pickCollaboratorIdFields } from '../utils';
import {
  deriveOwnClbs,
  syncCollectionChildrenPermission,
  syncCollectionCollaborators
} from './folderSync';
import type { DatasetCollectionSchemaType } from '@fastgpt/global/core/dataset/type';
import type { SyncChildrenPermissionResourceType } from '../inheritPermission';

/**
 * Batch-delete the Collection permission records (`resourceType=collection`) of a
 * set of Collection ids inside the given transaction.
 *
 * Used by Dataset/Collection deletion to clean up Collection permission records in the
 * same session that deletes the Collections themselves; a failure anywhere in the
 * surrounding transaction rolls the cleanup back, so no orphan `resource_permissions`
 * records are left behind. Idempotent: running twice deletes nothing the second time.
 */
export async function deleteCollectionPermissions({
  teamId,
  collectionIds,
  session
}: {
  teamId: string;
  collectionIds: string[];
  session: ClientSession;
}): Promise<void> {
  if (collectionIds.length === 0) return;

  await MongoResourcePermission.deleteMany({
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId: { $in: collectionIds }
  }).session(session);
}

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
 *   Dataset Folder 链合并（`getDatasetEffectiveClbs`）。
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
 * 创建 Collection 时初始化权限记录（全快照模型）：
 * - `inheritPermission=false`（独立态）：仅写入自身 owner 记录，不拷贝父级 clbs；
 * - `inheritPermission=true`（默认）：对 **Folder 与非 Folder** 都写入
 *   `merge(parentClbs, [owner])` 完整有效快照（父级 owner 由 `mergeCollaboratorList` 降级为 manage）。
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

  // 独立态 → 标记所属 Dataset 已配置 Collection 权限（纯继承短路失效）
  if (!inheritPermission) {
    await markDatasetCollectionPermissionsSet({ datasetId: resource.datasetId, session });
  }

  if (!inheritPermission) {
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
    return;
  }

  // 继承态：完整快照 = 父级有效 clbs（owner→manage）+ 自身 owner。新 resourceId 在该事务内
  // 刚生成，绝无既有权限记录，直接 insertMany。
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

/** 移动 Collection 所需的最小字段。 */
export type CollectionMoveResourceType = Pick<
  DatasetCollectionSchemaType,
  '_id' | 'type' | 'teamId' | 'parentId' | 'datasetId' | 'tmbId' | 'inheritPermission'
>;

/**
 * 移动 Collection 时的权限处理（全快照模型）：
 * - `inheritPermission=false`：仅更新 parentId，保留自身当前快照（视为独立配置）；
 * - `inheritPermission=true`（默认）：
 *   - 目标父级有效 clbs = 目标父 Collection Folder 快照；`targetParentId` 为空（根目录）时，
 *     父级为所属 Dataset，取 Dataset 有效 clbs；
 *   - 源父级有效 clbs = 移动前父 Collection Folder 快照 / Dataset 有效 clbs；被移动 Collection
 *     若此前独立，则源父级视为空（其快照全是自身 clbs）；
 *   - 用 `deriveOwnClbs(当前快照, 源父级)` 恢复自身 clbs，写新快照 `merge(目标父级, 自身 clbs)`；
 *   - 若被移动的是 Folder，递归同步其子 Collection（旧快照 → 新快照）；
 *   - 最后更新 parentId 并置 `inheritPermission=true`。
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

  // 保持独立配置：仅更新 parentId，保留当前快照
  if (inheritPermission === false) {
    await markDatasetCollectionPermissionsSet({ datasetId: collection.datasetId, session });
    await MongoDatasetCollection.updateOne(
      { _id: collection._id },
      { $set: { parentId: targetParentId || null, inheritPermission: false } },
      { session }
    );
    return;
  }

  // 目标父级有效 clbs——null 表示根目录，父级为所属 Dataset
  const targetParentClbs: CollaboratorItemType[] = targetParentId
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

  // 源父级有效 clbs——此前独立态视为无父级贡献（当前快照全是自身 clbs）
  const sourceParentClbs: CollaboratorItemType[] =
    collection.inheritPermission === false
      ? []
      : collection.parentId
        ? await getResourceOwnedClbs({
            resourceType: PerResourceTypeEnum.collection,
            teamId,
            resourceId: String(collection.parentId),
            session
          })
        : await getDatasetEffectiveClbs({
            teamId,
            datasetId: collection.datasetId,
            session
          });

  const currentSnapshot = (await getResourceOwnedClbs({
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId,
    session
  })) as CollaboratorItemType[];

  const ownClbs = deriveOwnClbs(currentSnapshot, sourceParentClbs, String(collection.tmbId));
  const newSnapshot = mergeCollaboratorList({
    parentClbs: targetParentClbs,
    childClbs: ownClbs
  });

  await syncCollectionCollaborators({
    teamId,
    resourceId,
    parentClbs: targetParentClbs,
    ownClbs,
    session
  });

  const isFolder = collection.type === DatasetCollectionTypeEnum.folder;
  if (isFolder) {
    // 递归同步子 Collection：旧父级 = 被移动 Folder 的旧快照，新父级 = 新快照
    await syncCollectionChildrenPermission({
      teamId,
      datasetId: collection.datasetId,
      parentId: resourceId,
      oldParentClbs: currentSnapshot,
      newParentClbs: newSnapshot,
      session
    });
  }

  await MongoDatasetCollection.updateOne(
    { _id: collection._id },
    { $set: { parentId: targetParentId || null, inheritPermission: true } },
    { session }
  );
}

/**
 * 更新 Collection 协作者（全量替换语义，与 App/Dataset 一致）。
 *
 * `collaborators` 为**目标完整有效 clbs**（继承态下需包含父级贡献 + 自身配置）：
 * - 继承态且无冲突：自身 clbs = `deriveOwnClbs(collaborators, parentClbs)`，
 *   快照 = `merge(parentClbs, 自身 clbs)`（等价于 collaborators）；
 * - 继承态且有冲突（试图修改/删除父级协作者）：翻转为独立态，快照 = collaborators；
 * - 独立态：快照 = collaborators（仅自身 clbs）。
 * - 若目标是 Folder，更新完自身快照后递归同步其子 Collection。
 *
 * @returns 最终 `inheritPermission`（冲突时翻转为 false，否则保持原值）。
 */
export async function updateCollectionCollaborators({
  collection,
  collaborators,
  session
}: {
  collection: CollectionMoveResourceType;
  /** 目标完整有效协作者列表（全量替换）。 */
  collaborators: CollaboratorItemType[];
  session?: ClientSession;
}): Promise<{ inheritPermission: boolean }> {
  const fn = async (session: ClientSession) => {
    const teamId = collection.teamId;
    const resourceId = String(collection._id);
    const isFolder = collection.type === DatasetCollectionTypeEnum.folder;

    const parentClbs: CollaboratorItemType[] = collection.parentId
      ? await getResourceOwnedClbs({
          resourceType: PerResourceTypeEnum.collection,
          teamId,
          resourceId: String(collection.parentId),
          session
        })
      : await getDatasetEffectiveClbs({
          teamId,
          datasetId: collection.datasetId,
          session
        });

    const isConflict = checkRoleUpdateConflict({ parentClbs, newChildClbs: collaborators });
    // inheritPermission 未传/undefined 时视为继承态（与 Collection 默认一致）
    let inheritPermission: boolean = collection.inheritPermission ?? true;

    if (isConflict && collection.inheritPermission && collection.parentId) {
      // 继承态 → 独立态（不能覆盖父级协作者）
      inheritPermission = false;
    }

    const isInherit = inheritPermission !== false;
    const ownClbs = isInherit
      ? deriveOwnClbs(collaborators, parentClbs, String(collection.tmbId))
      : collaborators;
    const newSnapshot = isInherit
      ? mergeCollaboratorList({ parentClbs, childClbs: ownClbs })
      : collaborators;

    await syncCollectionCollaborators({
      teamId,
      resourceId,
      parentClbs: isInherit ? parentClbs : [],
      ownClbs,
      session
    });

    // 配置了 collection 级协作者 → 标记所属 dataset 已设置 collection 权限（纯继承短路失效）
    await markDatasetCollectionPermissionsSet({ datasetId: collection.datasetId, session });

    if (inheritPermission !== collection.inheritPermission) {
      await MongoDatasetCollection.updateOne(
        { _id: collection._id },
        { $set: { inheritPermission } },
        { session }
      );
    }

    if (isFolder) {
      const oldSnapshot = (await getResourceOwnedClbs({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId,
        session
      })) as CollaboratorItemType[];

      await syncCollectionChildrenPermission({
        teamId,
        datasetId: collection.datasetId,
        parentId: resourceId,
        oldParentClbs: oldSnapshot,
        newParentClbs: newSnapshot,
        session
      });
    }

    return { inheritPermission };
  };

  if (session) {
    return fn(session);
  }
  return mongoSessionRun(fn);
}

/**
 * 直接切换 Collection 的继承态（不带新的协作者列表，用于 collection/update 中
 * `inheritPermission` 字段被显式修改的场景）。
 *
 * - 切为继承态：新快照 = `merge(父级有效 clbs, 当前快照)`（当前快照视为自身 clbs）；
 * - 切为独立态：新快照 = 当前快照（保留当前有效权限为独立配置）。
 * 若目标是 Folder，用「旧快照 → 新快照」递归同步其子 Collection。
 */
export async function setCollectionInheritPermission({
  collection,
  inheritPermission,
  session
}: {
  collection: CollectionMoveResourceType;
  /** 目标继承态。 */
  inheritPermission: boolean;
  session?: ClientSession;
}): Promise<void> {
  const fn = async (session: ClientSession) => {
    const teamId = collection.teamId;
    const resourceId = String(collection._id);
    const isFolder = collection.type === DatasetCollectionTypeEnum.folder;
    const isInherit = inheritPermission !== false;

    const parentClbs: CollaboratorItemType[] = collection.parentId
      ? await getResourceOwnedClbs({
          resourceType: PerResourceTypeEnum.collection,
          teamId,
          resourceId: String(collection.parentId),
          session
        })
      : await getDatasetEffectiveClbs({
          teamId,
          datasetId: collection.datasetId,
          session
        });

    const currentSnapshot = (await getResourceOwnedClbs({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId,
      session
    })) as CollaboratorItemType[];

    const newSnapshot = isInherit
      ? mergeCollaboratorList({ parentClbs, childClbs: currentSnapshot })
      : currentSnapshot;

    await syncCollectionCollaborators({
      teamId,
      resourceId,
      parentClbs: isInherit ? parentClbs : [],
      ownClbs: currentSnapshot,
      session
    });

    // 独立态 → 标记所属 dataset 已配置 collection 权限（纯继承短路失效）
    if (!isInherit) {
      await markDatasetCollectionPermissionsSet({ datasetId: collection.datasetId, session });
    }

    await MongoDatasetCollection.updateOne(
      { _id: collection._id },
      { $set: { inheritPermission } },
      { session }
    );

    if (isFolder) {
      await syncCollectionChildrenPermission({
        teamId,
        datasetId: collection.datasetId,
        parentId: resourceId,
        oldParentClbs: currentSnapshot,
        newParentClbs: newSnapshot,
        session
      });
    }
  };

  if (session) {
    return fn(session);
  }
  return mongoSessionRun(fn);
}
