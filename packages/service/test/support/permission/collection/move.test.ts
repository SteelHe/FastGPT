import { describe, expect, it } from 'vitest';
import { Types } from '@fastgpt/service/common/mongo';
import { mongoSessionRun } from '@fastgpt/service/common/mongo/sessionRun';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import {
  ManageRoleVal,
  OwnerRoleVal,
  PerResourceTypeEnum,
  ReadRoleVal,
  WriteRoleVal
} from '@fastgpt/global/support/permission/constant';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { moveCollectionPermission } from '@fastgpt/service/support/permission/collection/move';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { getFakeUsers } from '@test/datas/users';

const oid = () => new Types.ObjectId().toString();

const getCollectionClbs = async (resourceId: string, teamId: string) =>
  MongoResourcePermission.find({
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId
  }).lean();

const clbMap = (clbs: Awaited<ReturnType<typeof getCollectionClbs>>) =>
  new Map(
    clbs.map((clb) => [
      String(clb.tmbId || clb.groupId || clb.orgId),
      {
        tmbId: clb.tmbId ? String(clb.tmbId) : undefined,
        permission: clb.permission
      }
    ])
  );

const createCollection = async ({
  teamId,
  tmbId,
  datasetId,
  parentId,
  type,
  name,
  inheritPermission = true
}: {
  teamId: string;
  tmbId: string;
  datasetId: string;
  parentId?: string;
  type: DatasetCollectionTypeEnum;
  name: string;
  inheritPermission?: boolean;
}) => {
  const collection = await MongoDatasetCollection.create({
    teamId,
    tmbId,
    datasetId,
    parentId: parentId ?? null,
    type,
    name,
    inheritPermission
  });
  return collection;
};

const setSnapshot = async ({
  teamId,
  resourceId,
  clbs
}: {
  teamId: string;
  resourceId: string;
  clbs: { tmbId: string; permission: number }[];
}) => {
  await MongoResourcePermission.insertMany(
    clbs.map((clb) => ({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId,
      tmbId: clb.tmbId,
      permission: clb.permission
    }))
  );
};

describe('moveCollectionPermission ', { timeout: 120000 }, () => {
  const setup = async () => {
    const users = await getFakeUsers(3);
    const teamId = users.owner.teamId;
    const dataset = await MongoDataset.create({
      teamId,
      tmbId: String(users.owner.tmbId),
      name: 'test-dataset'
    });
    const datasetId = String(dataset._id);
    return { users, teamId, datasetId };
  };

  it('CM-004: move with inheritPermission=true inherits target parent clbs, deletes source-specific old clbs, re-syncs inherited child folders', async () => {
    const { users, teamId, datasetId } = await setup();
    const owner = String(users.owner.tmbId);
    const m1 = String(users.members[0].tmbId);
    const m2 = String(users.members[1].tmbId);

    // source folder F1 grants read to m1; target folder F2 grants write to m2
    const f1 = await createCollection({
      teamId,
      tmbId: owner,
      datasetId,
      type: DatasetCollectionTypeEnum.folder,
      name: 'f1'
    });
    const f2 = await createCollection({
      teamId,
      tmbId: owner,
      datasetId,
      type: DatasetCollectionTypeEnum.folder,
      name: 'f2'
    });
    const f1Id = String(f1._id);
    const f2Id = String(f2._id);

    await setSnapshot({
      teamId,
      resourceId: f1Id,
      clbs: [
        { tmbId: owner, permission: OwnerRoleVal },
        { tmbId: m1, permission: ReadRoleVal }
      ]
    });
    await setSnapshot({
      teamId,
      resourceId: f2Id,
      clbs: [
        { tmbId: owner, permission: OwnerRoleVal },
        { tmbId: m2, permission: WriteRoleVal }
      ]
    });

    // moved folder C under f1 (source snapshot = f1 clbs), with inherited child folder CC
    const c = await createCollection({
      teamId,
      tmbId: owner,
      datasetId,
      parentId: f1Id,
      type: DatasetCollectionTypeEnum.folder,
      name: 'c'
    });
    const cc = await createCollection({
      teamId,
      tmbId: owner,
      datasetId,
      parentId: String(c._id),
      type: DatasetCollectionTypeEnum.folder,
      name: 'cc'
    });
    const cId = String(c._id);
    const ccId = String(cc._id);

    await setSnapshot({
      teamId,
      resourceId: cId,
      clbs: [
        { tmbId: owner, permission: OwnerRoleVal },
        { tmbId: m1, permission: ReadRoleVal }
      ]
    });
    await setSnapshot({
      teamId,
      resourceId: ccId,
      clbs: [
        { tmbId: owner, permission: OwnerRoleVal },
        { tmbId: m1, permission: ReadRoleVal }
      ]
    });

    // move C to f2 with inheritPermission=true
    await mongoSessionRun(async (session) => {
      await moveCollectionPermission({
        collection: c as any,
        targetParentId: f2Id,
        inheritPermission: true,
        session
      });
    });

    const updatedC = await MongoDatasetCollection.findById(cId).lean();
    expect(String(updatedC!.parentId)).toBe(f2Id);
    expect(updatedC!.inheritPermission).toBe(true);

    // C snapshot = new parent f2 clbs + own owner; old m1 read deleted
    const cClbs = clbMap(await getCollectionClbs(cId, teamId));
    expect(cClbs.get(owner)?.permission).toBe(OwnerRoleVal);
    expect(cClbs.get(m2)?.permission).toBe(WriteRoleVal);
    expect(cClbs.has(m1)).toBe(false);

    // inherited child CC re-synced to the new snapshot via syncChildrenPermission (sumPer)：
    // 新增 m2-write；m1 因父级 C 已无对应记录（保守删除条件不满足）保留原 read
    const ccClbs = clbMap(await getCollectionClbs(ccId, teamId));
    expect(ccClbs.get(owner)?.permission).toBe(OwnerRoleVal);
    expect(ccClbs.get(m2)?.permission).toBe(WriteRoleVal);
    expect(ccClbs.get(m1)?.permission).toBe(ReadRoleVal);
  });

  it('CM-005: move with inheritPermission=false only updates parentId, keeps own independent clbs, does not merge target parent', async () => {
    const { users, teamId, datasetId } = await setup();
    const owner = String(users.owner.tmbId);
    const m1 = String(users.members[0].tmbId);
    const m2 = String(users.members[1].tmbId);

    const f1 = await createCollection({
      teamId,
      tmbId: owner,
      datasetId,
      type: DatasetCollectionTypeEnum.folder,
      name: 'f1'
    });
    const f2 = await createCollection({
      teamId,
      tmbId: owner,
      datasetId,
      type: DatasetCollectionTypeEnum.folder,
      name: 'f2'
    });
    const f1Id = String(f1._id);
    const f2Id = String(f2._id);

    await setSnapshot({
      teamId,
      resourceId: f1Id,
      clbs: [{ tmbId: owner, permission: OwnerRoleVal }]
    });
    // target f2 grants write to m1
    await setSnapshot({
      teamId,
      resourceId: f2Id,
      clbs: [
        { tmbId: owner, permission: OwnerRoleVal },
        { tmbId: m1, permission: WriteRoleVal }
      ]
    });

    // C is a non-folder under f1 with own independent clbs (m2 read)
    const c = await createCollection({
      teamId,
      tmbId: owner,
      datasetId,
      parentId: f1Id,
      type: DatasetCollectionTypeEnum.file,
      name: 'c',
      inheritPermission: false
    });
    const cId = String(c._id);
    await setSnapshot({
      teamId,
      resourceId: cId,
      clbs: [
        { tmbId: owner, permission: OwnerRoleVal },
        { tmbId: m2, permission: ReadRoleVal }
      ]
    });

    await mongoSessionRun(async (session) => {
      await moveCollectionPermission({
        collection: c as any,
        targetParentId: f2Id,
        inheritPermission: false,
        session
      });
    });

    const updatedC = await MongoDatasetCollection.findById(cId).lean();
    expect(String(updatedC!.parentId)).toBe(f2Id);
    expect(updatedC!.inheritPermission).toBe(false);

    // own independent clbs preserved; target parent m1 NOT merged
    const cClbs = clbMap(await getCollectionClbs(cId, teamId));
    expect(cClbs.get(owner)?.permission).toBe(OwnerRoleVal);
    expect(cClbs.get(m2)?.permission).toBe(ReadRoleVal);
    expect(cClbs.has(m1)).toBe(false);
  });

  it('move with inheritPermission=true to root (targetParentId=null) clears all parent-derived clbs and keeps only own owner', async () => {
    const { users, teamId, datasetId } = await setup();
    const owner = String(users.owner.tmbId);
    const m1 = String(users.members[0].tmbId);

    const f1 = await createCollection({
      teamId,
      tmbId: owner,
      datasetId,
      type: DatasetCollectionTypeEnum.folder,
      name: 'f1'
    });
    const f1Id = String(f1._id);

    await setSnapshot({
      teamId,
      resourceId: f1Id,
      clbs: [
        { tmbId: owner, permission: OwnerRoleVal },
        { tmbId: m1, permission: ReadRoleVal }
      ]
    });

    const c = await createCollection({
      teamId,
      tmbId: owner,
      datasetId,
      parentId: f1Id,
      type: DatasetCollectionTypeEnum.folder,
      name: 'c'
    });
    const cId = String(c._id);
    await setSnapshot({
      teamId,
      resourceId: cId,
      clbs: [
        { tmbId: owner, permission: OwnerRoleVal },
        { tmbId: m1, permission: ReadRoleVal }
      ]
    });

    await mongoSessionRun(async (session) => {
      await moveCollectionPermission({
        collection: c as any,
        targetParentId: null,
        inheritPermission: true,
        session
      });
    });

    const updatedC = await MongoDatasetCollection.findById(cId).lean();
    expect(updatedC!.parentId).toBe(null);
    expect(updatedC!.inheritPermission).toBe(true);

    const cClbs = clbMap(await getCollectionClbs(cId, teamId));
    expect(cClbs.get(owner)?.permission).toBe(OwnerRoleVal);
    expect(cClbs.has(m1)).toBe(false);
  });
});
