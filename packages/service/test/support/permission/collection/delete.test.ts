import { describe, expect, it } from 'vitest';
import { Types } from '@fastgpt/service/common/mongo';
import { connectionMongo } from '@fastgpt/service/common/mongo';
import { mongoSessionRun } from '@fastgpt/service/common/mongo/sessionRun';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import {
  OwnerRoleVal,
  PerResourceTypeEnum,
  ReadRoleVal
} from '@fastgpt/global/support/permission/constant';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { delCollection } from '@fastgpt/service/core/dataset/collection/controller';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { getFakeUsers } from '@test/datas/users';

const oid = () => new Types.ObjectId().toString();

describe('delCollection permission cleanup ', { timeout: 120000 }, () => {
  it('CM-006: deletes the whole subtree and its resource_permissions in the same transaction', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const owner = String(users.owner.tmbId);
    const m1 = String(users.members[0].tmbId);
    const dataset = await MongoDataset.create({
      teamId,
      tmbId: owner,
      name: 'test-dataset'
    });
    const datasetId = String(dataset._id);

    const folder = await MongoDatasetCollection.create({
      teamId,
      tmbId: owner,
      datasetId,
      parentId: null,
      type: DatasetCollectionTypeEnum.folder,
      name: 'folder'
    });
    const child = await MongoDatasetCollection.create({
      teamId,
      tmbId: owner,
      datasetId,
      parentId: String(folder._id),
      type: DatasetCollectionTypeEnum.folder,
      name: 'child'
    });
    const file = await MongoDatasetCollection.create({
      teamId,
      tmbId: owner,
      datasetId,
      parentId: String(child._id),
      type: DatasetCollectionTypeEnum.file,
      name: 'file'
    });

    const ids = [String(folder._id), String(child._id), String(file._id)];
    // permission records for every collection in the subtree
    for (const id of ids) {
      await MongoResourcePermission.insertMany([
        {
          resourceType: PerResourceTypeEnum.collection,
          teamId,
          resourceId: id,
          tmbId: owner,
          permission: OwnerRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.collection,
          teamId,
          resourceId: id,
          tmbId: m1,
          permission: ReadRoleVal
        }
      ]);
    }

    await mongoSessionRun(async (session) => {
      await delCollection({
        collections: [folder, child, file] as any,
        delImg: false,
        delFile: false,
        session
      });
    });

    // all collection docs gone
    expect(await MongoDatasetCollection.countDocuments({ teamId, _id: { $in: ids } })).toBe(0);
    // no orphan resource_permissions for the subtree
    expect(
      await MongoResourcePermission.countDocuments({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: { $in: ids }
      })
    ).toBe(0);
  }, 60000);

  it('CM-006 rollback: aborting the surrounding transaction restores collection deletion AND permission cleanup (no orphans)', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const owner = String(users.owner.tmbId);
    const dataset = await MongoDataset.create({
      teamId,
      tmbId: owner,
      name: 'test-dataset'
    });
    const datasetId = String(dataset._id);

    const folder = await MongoDatasetCollection.create({
      teamId,
      tmbId: owner,
      datasetId,
      parentId: null,
      type: DatasetCollectionTypeEnum.folder,
      name: 'folder'
    });
    const child = await MongoDatasetCollection.create({
      teamId,
      tmbId: owner,
      datasetId,
      parentId: String(folder._id),
      type: DatasetCollectionTypeEnum.file,
      name: 'child'
    });
    const ids = [String(folder._id), String(child._id)];

    for (const id of ids) {
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: id,
        tmbId: owner,
        permission: OwnerRoleVal
      });
    }

    // Use a REAL transaction session (the mongoSessionRun test mock bypasses
    // transactions, so start one directly to prove session-scoped atomicity).
    const session = await connectionMongo.startSession();
    try {
      session.startTransaction();
      await delCollection({
        collections: [folder, child] as any,
        delImg: false,
        delFile: false,
        session
      });
      throw new Error('boom: simulate mid-transaction failure');
    } catch (error) {
      await session.abortTransaction();
      expect((error as Error).message).toContain('boom');
    } finally {
      await session.endSession();
    }

    // transaction aborted: collections still exist, permission records still exist
    expect(await MongoDatasetCollection.countDocuments({ teamId, _id: { $in: ids } })).toBe(2);
    expect(
      await MongoResourcePermission.countDocuments({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: { $in: ids }
      })
    ).toBe(2);
  }, 60000);
});
