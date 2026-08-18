import { MongoDatasetCollection } from '../../../core/dataset/collection/schema';
import { getDatasetEffectiveClbs, getResourceOwnedClbs } from '../controller';
import { mongoSessionRun } from '../../../common/mongo/sessionRun';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import { mergeCollaboratorList } from '@fastgpt/global/support/permission/utils';
import type { DatasetCollectionSchemaType } from '@fastgpt/global/core/dataset/type';
import type { CollaboratorItemType } from '@fastgpt/global/support/permission/collaborator';
import { syncCollectionChildrenPermission, syncCollectionCollaborators } from './folderSync';

/**
 * Resume a Collection's inherited permission（全快照模型）
 * - 所有类型（Folder / 非 Folder）：加载当前快照（独立态时即自身 clbs），与父级有效 clbs
 *   合并为完整有效快照并写入（`syncCollectionCollaborators`），置 `inheritPermission=true`；
 * - 若目标是 Folder，用「旧快照 → 新快照」递归同步其继承态子 Collection。
 */
export async function resumeCollectionInheritPermission({
  collection,
  teamId
}: {
  collection: Pick<
    DatasetCollectionSchemaType,
    '_id' | 'tmbId' | 'parentId' | 'datasetId' | 'type'
  >;
  teamId: string;
}): Promise<void> {
  const collectionId = String(collection._id);

  await mongoSessionRun(async (session) => {
    // 1. 父级有效 clbs：父 Collection Folder 快照，或根级 Collection 的 Dataset 有效 clbs
    const parentClbs: CollaboratorItemType[] = collection.parentId
      ? await getResourceOwnedClbs({
          resourceType: PerResourceTypeEnum.collection,
          teamId,
          resourceId: String(collection.parentId),
          session
        })
      : await getDatasetEffectiveClbs({
          teamId,
          datasetId: String(collection.datasetId),
          session
        });

    // 2. 当前快照（独立态时即自身 clbs）
    const currentSnapshot = (await getResourceOwnedClbs({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: collectionId,
      session
    })) as CollaboratorItemType[];

    // 3. 完整有效快照 = merge(父级, 当前)
    const newSnapshot = mergeCollaboratorList({
      parentClbs,
      childClbs: currentSnapshot
    });

    await syncCollectionCollaborators({
      teamId,
      resourceId: collectionId,
      parentClbs,
      ownClbs: currentSnapshot,
      session
    });

    // 4. resume inheritance
    await MongoDatasetCollection.updateOne(
      { _id: collection._id },
      { inheritPermission: true },
      { session }
    );

    // 5. 若目标是 Folder，递归同步继承态子 Collection（旧快照 → 新快照）
    if (collection.type === DatasetCollectionTypeEnum.folder) {
      await syncCollectionChildrenPermission({
        teamId,
        datasetId: String(collection.datasetId),
        parentId: collectionId,
        oldParentClbs: currentSnapshot,
        newParentClbs: newSnapshot,
        session
      });
    }
  });
}
