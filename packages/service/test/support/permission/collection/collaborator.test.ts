import { describe, expect, it } from 'vitest';
import { Types } from '@fastgpt/service/common/mongo';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { DatasetErrEnum } from '@fastgpt/global/common/error/code/dataset';
import {
  ManageRoleVal,
  NullRoleVal,
  OwnerRoleVal,
  PerResourceTypeEnum,
  ReadRoleVal,
  WriteRoleVal
} from '@fastgpt/global/support/permission/constant';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { getResourceOwnedClbs } from '@fastgpt/service/support/permission/controller';
import { resolveCollectionPermission } from '@fastgpt/service/support/permission/collection/resolvePermission';
import { resumeCollectionInheritPermission } from '@fastgpt/service/support/permission/collection/collaborator';
import { getFakeUsers } from '@test/datas/users';

const oid = () => new Types.ObjectId().toString();

const createDataset = async ({ teamId, tmbId }: { teamId: string; tmbId: string }) => {
  const dataset = await MongoDataset.create({
    teamId,
    tmbId,
    name: `dataset-${Date.now()}-${Math.random()}`
  });
  return dataset;
};

const createCollection = async ({
  teamId,
  tmbId,
  datasetId,
  type,
  parentId,
  inheritPermission = true,
  name
}: {
  teamId: string;
  tmbId: string;
  datasetId: string;
  type: DatasetCollectionTypeEnum;
  parentId?: string;
  inheritPermission?: boolean;
  name?: string;
}) => {
  const collection = await MongoDatasetCollection.create({
    teamId,
    tmbId,
    datasetId,
    parentId: parentId ?? null,
    type,
    name: name ?? `collection-${Date.now()}-${Math.random()}`,
    inheritPermission
  });
  return collection;
};

/** resource_permissions by id -> permission */
const clbMap = (clbs: Array<{ tmbId?: any; groupId?: any; orgId?: any; permission: number }>) =>
  new Map(clbs.map((clb) => [String(clb.tmbId ?? clb.groupId ?? clb.orgId), clb.permission]));

describe('resumeCollectionInheritPermission ', () => {
  it('CC-004: folder resume rebuilds snapshot from parent(owner->manage)+own owner and syncs inherited child folders', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const dataset = await createDataset({ teamId, tmbId: users.owner.tmbId });
    const datasetId = String(dataset._id);

    // dataset grants M1 read
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: datasetId,
      tmbId: users.members[0].tmbId,
      permission: ReadRoleVal
    });

    const folder = await createCollection({
      teamId,
      tmbId: users.owner.tmbId,
      datasetId,
      type: DatasetCollectionTypeEnum.folder,
      inheritPermission: false
    });
    const child = await createCollection({
      teamId,
      tmbId: users.owner.tmbId,
      datasetId,
      type: DatasetCollectionTypeEnum.folder,
      parentId: String(folder._id),
      inheritPermission: true
    });
    const folderId = String(folder._id);
    const childId = String(child._id);

    // F independent config (owner + private write), CF inherited snapshot copied from F
    await MongoResourcePermission.insertMany([
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: folderId,
        tmbId: users.owner.tmbId,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: folderId,
        tmbId: users.members[0].tmbId,
        permission: WriteRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: childId,
        tmbId: users.owner.tmbId,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: childId,
        tmbId: users.members[0].tmbId,
        permission: WriteRoleVal
      }
    ]);

    const collectionDoc = await MongoDatasetCollection.findById(folderId).lean();
    await resumeCollectionInheritPermission({ collection: collectionDoc, teamId });

    // F snapshot rebuilt: dataset(owner->manage) + own owner => only read is inherited from dataset
    const folderClbs = await getResourceOwnedClbs({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: folderId
    });
    const fMap = clbMap(folderClbs);
    expect(fMap.size).toBe(2);
    expect(fMap.get(String(users.owner.tmbId))).toBe(OwnerRoleVal);
    expect(fMap.get(String(users.members[0].tmbId))).toBe(ReadRoleVal);

    // inherited child folder synced to the rebuilt snapshot
    const childClbs = await getResourceOwnedClbs({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: childId
    });
    const cMap = clbMap(childClbs);
    expect(cMap.get(String(users.owner.tmbId))).toBe(OwnerRoleVal);
    // 通用 syncChildrenPermission 为 sumPer 累加：子原有 write(0b010) | 父快照 read(0b100) = 0b110
    expect(cMap.get(String(users.members[0].tmbId))).toBe(WriteRoleVal | ReadRoleVal);

    const folderDoc = await MongoDatasetCollection.findById(folderId).lean();
    expect(folderDoc?.inheritPermission).toBe(true);
  });

  it('CC-006: folder resume with no parent permission keeps only the owner record', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const dataset = await createDataset({ teamId, tmbId: users.owner.tmbId });
    const datasetId = String(dataset._id);

    const folder = await createCollection({
      teamId,
      tmbId: users.owner.tmbId,
      datasetId,
      type: DatasetCollectionTypeEnum.folder,
      inheritPermission: false
    });
    const folderId = String(folder._id);

    // F independent config: owner + private M1 write; dataset has no clbs at all
    await MongoResourcePermission.insertMany([
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: folderId,
        tmbId: users.owner.tmbId,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: folderId,
        tmbId: users.members[0].tmbId,
        permission: WriteRoleVal
      }
    ]);

    const collectionDoc = await MongoDatasetCollection.findById(folderId).lean();
    await resumeCollectionInheritPermission({ collection: collectionDoc, teamId });

    const folderClbs = await getResourceOwnedClbs({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: folderId
    });
    const byId = clbMap(folderClbs);
    expect(byId.size).toBe(1);
    expect(byId.get(String(users.owner.tmbId))).toBe(OwnerRoleVal);

    const folderDoc = await MongoDatasetCollection.findById(folderId).lean();
    expect(folderDoc?.inheritPermission).toBe(true);
  });

  it('resume keeps non-inherited child folders untouched while syncing their inherited children', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const dataset = await createDataset({ teamId, tmbId: users.owner.tmbId });
    const datasetId = String(dataset._id);

    // dataset grants M1 read
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: datasetId,
      tmbId: users.members[0].tmbId,
      permission: ReadRoleVal
    });

    const folder = await createCollection({
      teamId,
      tmbId: users.owner.tmbId,
      datasetId,
      type: DatasetCollectionTypeEnum.folder,
      inheritPermission: false
    });
    // non-inherited child folder G with an independent write grant
    const g = await createCollection({
      teamId,
      tmbId: users.owner.tmbId,
      datasetId,
      type: DatasetCollectionTypeEnum.folder,
      parentId: String(folder._id),
      inheritPermission: false
    });
    // inherited grandchild H under G
    const h = await createCollection({
      teamId,
      tmbId: users.owner.tmbId,
      datasetId,
      type: DatasetCollectionTypeEnum.folder,
      parentId: String(g._id),
      inheritPermission: true
    });
    const folderId = String(folder._id);
    const gId = String(g._id);
    const hId = String(h._id);

    await MongoResourcePermission.insertMany([
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: folderId,
        tmbId: users.owner.tmbId,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: folderId,
        tmbId: users.members[0].tmbId,
        permission: WriteRoleVal
      },
      // G independent: owner + M1 write (private)
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: gId,
        tmbId: users.owner.tmbId,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: gId,
        tmbId: users.members[0].tmbId,
        permission: WriteRoleVal
      },
      // H inherited snapshot copied from G
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: hId,
        tmbId: users.owner.tmbId,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: hId,
        tmbId: users.members[0].tmbId,
        permission: WriteRoleVal
      }
    ]);

    const collectionDoc = await MongoDatasetCollection.findById(folderId).lean();
    await resumeCollectionInheritPermission({ collection: collectionDoc, teamId });

    // F rebuilt from dataset read (owner + M1 read)
    const fClbs = clbMap(
      await getResourceOwnedClbs({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: folderId
      })
    );
    expect(fClbs.get(String(users.members[0].tmbId))).toBe(ReadRoleVal);

    // G (non-inherited) keeps its independent write grant
    const gClbs = clbMap(
      await getResourceOwnedClbs({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: gId
      })
    );
    expect(gClbs.get(String(users.members[0].tmbId))).toBe(WriteRoleVal);

    // H (inherited under non-inherited G) inherits G's snapshot (write)
    const hClbs = clbMap(
      await getResourceOwnedClbs({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: hId
      })
    );
    expect(hClbs.get(String(users.members[0].tmbId))).toBe(WriteRoleVal);
  });
});
