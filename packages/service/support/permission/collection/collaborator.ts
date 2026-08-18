import { MongoDatasetCollection } from '../../../core/dataset/collection/schema';
import { getDatasetEffectiveClbs, getResourceOwnedClbs } from '../controller';
import { syncChildrenPermission, syncCollaborators } from '../inheritPermission';
import { mongoSessionRun } from '../../../common/mongo/sessionRun';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { OwnerRoleVal, PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import { mergeCollaboratorList } from '@fastgpt/global/support/permission/utils';
import type { DatasetCollectionSchemaType } from '@fastgpt/global/core/dataset/type';

/**
 * Resume a Collection's inherited permission
 * - non-folder: only set `inheritPermission=true`; its effective permission is
 *   dynamically merged at auth time, no snapshot is written;
 * - folder: merge the parent clbs into its own snapshot via `syncCollaborators`
 *   (owner->manage, sumPer keeps the own owner and any independent clbs), set
 *   `inheritPermission=true`, and re-sync inherited descendant Folders through
 *   `syncChildrenPermission` (sumPer). Non-inherited descendants are never overwritten.
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

  if (collection.type !== DatasetCollectionTypeEnum.folder) {
    await MongoDatasetCollection.updateOne({ _id: collection._id }, { inheritPermission: true });
    return;
  }

  await mongoSessionRun(async (session) => {
    // 1. parent effective clbs: parent Collection Folder snapshot, or the root
    //    Dataset effective collaborators (walk up the dataset folder chain)
    const parentClbs = collection.parentId
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

    // 2. 将父级 clbs 并入自身快照（owner→manage，sumPer 保留自身独立 clbs 与 owner）
    await syncCollaborators({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: collectionId,
      // syncCollaborators 会原地把入参 owner 改为 manage，传副本避免污染 parentClbs
      collaborators: parentClbs.map((clb) => ({ ...clb })),
      session
    });

    // 3. resume inheritance
    await MongoDatasetCollection.updateOne(
      { _id: collection._id },
      { inheritPermission: true },
      { session }
    );

    // 4. re-sync inherited descendant folders via the generic syncChildrenPermission
    await syncChildrenPermission({
      resource: {
        _id: collectionId,
        type: DatasetCollectionTypeEnum.folder,
        teamId,
        parentId: collection.parentId ? String(collection.parentId) : null
      },
      folderTypeList: [DatasetCollectionTypeEnum.folder],
      resourceType: PerResourceTypeEnum.collection,
      resourceModel: MongoDatasetCollection,
      session,
      collaborators: mergeCollaboratorList({
        parentClbs,
        childClbs: [{ tmbId: String(collection.tmbId), permission: OwnerRoleVal }]
      })
    });
  });
}
