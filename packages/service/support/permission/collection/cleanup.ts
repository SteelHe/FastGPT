import { PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import type { ClientSession } from '../../../common/mongo';
import { MongoResourcePermission } from '../schema';

/**
 * Batch-delete the Collection permission records (`resourceType=collection`) of a
 * set of Collection ids inside the given transaction.
 *
 * Used by Dataset deletion to clean up Collection permission records in the same
 * session that deletes the Collections themselves; a failure anywhere in the
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
