import { MongoDatasetCollection } from '../../../core/dataset/collection/schema';
import { MongoResourcePermission } from '../schema';
import { getDatasetEffectiveClbs, getResourceOwnedClbs } from '../controller';
import { syncChildrenPermission } from '../inheritPermission';
import { mongoSessionRun } from '../../../common/mongo/sessionRun';
import { pickCollaboratorIdFields } from '../utils';
import type { ClientSession } from '../../../common/mongo';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { OwnerRoleVal, PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import type { CollaboratorItemType } from '@fastgpt/global/support/permission/collaborator';
import { mergeCollaboratorList } from '@fastgpt/global/support/permission/utils';
import type { DatasetCollectionSchemaType } from '@fastgpt/global/core/dataset/type';

/**
 * Resume a Collection's inherited permission
 * - non-folder: only set `inheritPermission=true`; its effective permission is
 *   dynamically merged at auth time, no snapshot is written;
 * - folder: rebuild the snapshot as `parent(owner->manage) + own owner`, replace
 *   own clbs, set `inheritPermission=true`, and re-sync inherited descendant
 *   Folders through `syncChildrenPermission` (sumPer). Non-inherited descendants
 *   are never overwritten.
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

    // 2. rebuild snapshot: parent(owner->manage) + own owner
    const snapshot = mergeCollaboratorList({
      parentClbs,
      childClbs: [{ tmbId: String(collection.tmbId), permission: OwnerRoleVal }]
    });

    // 3. full replace own clbs
    await replaceOwnClbs({ sanitized: snapshot, collectionId, teamId, session });

    // 4. resume inheritance
    await MongoDatasetCollection.updateOne(
      { _id: collection._id },
      { inheritPermission: true },
      { session }
    );

    // 5. re-sync inherited descendant folders via the generic syncChildrenPermission
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
      collaborators: snapshot
    });
  });
}

/* ============ internal helpers ============ */

/** Full replace of a resource's own clbs inside a transaction. */
const replaceOwnClbs = async ({
  sanitized,
  collectionId,
  teamId,
  session
}: {
  sanitized: CollaboratorItemType[];
  collectionId: string;
  teamId: string;
  session: ClientSession;
}) => {
  // Both deleteMany and insertMany must run inside the same transaction session
  // (Warning-2): if the surrounding mongoSessionRun transaction rolls back,
  // the delete must roll back together with the insert, otherwise the resource's
  // collaborators would be lost while the new config is not persisted.
  await MongoResourcePermission.deleteMany(
    {
      resourceId: collectionId,
      resourceType: PerResourceTypeEnum.collection,
      teamId
    },
    { session }
  );
  await MongoResourcePermission.insertMany(
    sanitized.map((clb) => ({
      permission: clb.permission,
      ...pickCollaboratorIdFields(clb),
      resourceId: collectionId,
      teamId,
      resourceType: PerResourceTypeEnum.collection
    })),
    { session }
  );
};
