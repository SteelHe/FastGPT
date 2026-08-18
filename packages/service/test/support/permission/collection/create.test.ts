import { describe, expect, it } from 'vitest';
import { Types } from '@fastgpt/service/common/mongo';
import { mongoSessionRun } from '@fastgpt/service/common/mongo/sessionRun';
import { DatasetCollectionTypeEnum, DatasetTypeEnum } from '@fastgpt/global/core/dataset/constants';
import {
  ManageRoleVal,
  OwnerRoleVal,
  PerResourceTypeEnum,
  ReadRoleVal,
  WriteRoleVal
} from '@fastgpt/global/support/permission/constant';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { createOneCollection } from '@fastgpt/service/core/dataset/collection/controller';
import {
  createCollectionPermission,
  getCollectionCreateParentClbs
} from '@fastgpt/service/support/permission/collection/controller';
import { getDatasetEffectiveClbs } from '@fastgpt/service/support/permission/controller';
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

describe('createCollectionPermission ', { timeout: 120000 }, () => {
  it('CM-001: non-folder with default inheritPermission=true writes full snapshot = parent clbs + own owner', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const datasetId = oid();
    const collectionId = oid();

    const parentClbs = [
      { tmbId: String(users.owner.tmbId), permission: OwnerRoleVal },
      { tmbId: String(users.members[0].tmbId), permission: ReadRoleVal }
    ];

    await mongoSessionRun(async (session) => {
      await createCollectionPermission({
        resource: {
          _id: collectionId,
          teamId,
          type: DatasetCollectionTypeEnum.file,
          parentId: null,
          datasetId,
          tmbId: String(users.owner.tmbId)
        },
        parentClbs,
        inheritPermission: true,
        session
      });
    });

    const clbs = await getCollectionClbs(collectionId, teamId);
    const map = clbMap(clbs);
    // 全快照：parent clbs（owner→manage 由 mergeCollaboratorList 处理）+ 自身 owner
    expect(clbs).toHaveLength(2);
    expect(map.get(String(users.owner.tmbId))?.permission).toBe(OwnerRoleVal);
    expect(map.get(String(users.members[0].tmbId))?.permission).toBe(ReadRoleVal);
  });

  it('CM-002: folder with inheritPermission=true writes snapshot = parent clbs (owner->manage) + own owner', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const datasetId = oid();
    const folderId = oid();

    // parent (dataset) real clbs: owner + member1 read
    const parentClbs = [
      { tmbId: String(users.owner.tmbId), permission: OwnerRoleVal },
      { tmbId: String(users.members[0].tmbId), permission: ReadRoleVal }
    ];

    await mongoSessionRun(async (session) => {
      await createCollectionPermission({
        resource: {
          _id: folderId,
          teamId,
          type: DatasetCollectionTypeEnum.folder,
          parentId: null,
          datasetId,
          tmbId: String(users.owner.tmbId)
        },
        parentClbs,
        inheritPermission: true,
        session
      });
    });

    const clbs = await getCollectionClbs(folderId, teamId);
    const map = clbMap(clbs);
    // snapshot = parent clbs + own owner
    expect(clbs).toHaveLength(2);
    expect(map.get(String(users.owner.tmbId))?.permission).toBe(OwnerRoleVal);
    expect(map.get(String(users.members[0].tmbId))?.permission).toBe(ReadRoleVal);
  });

  it('CM-002 (owner cap): parent owner is downgraded to manage for a different child owner', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const datasetId = oid();
    const folderId = oid();

    // dataset owned by member1; folder owned by owner
    const parentClbs = [
      { tmbId: String(users.members[0].tmbId), permission: OwnerRoleVal },
      { tmbId: String(users.owner.tmbId), permission: ReadRoleVal }
    ];

    await mongoSessionRun(async (session) => {
      await createCollectionPermission({
        resource: {
          _id: folderId,
          teamId,
          type: DatasetCollectionTypeEnum.folder,
          parentId: null,
          datasetId,
          tmbId: String(users.owner.tmbId)
        },
        parentClbs,
        inheritPermission: true,
        session
      });
    });

    const clbs = await getCollectionClbs(folderId, teamId);
    const map = clbMap(clbs);
    expect(map.get(String(users.members[0].tmbId))?.permission).toBe(ManageRoleVal);
    expect(map.get(String(users.owner.tmbId))?.permission).toBe(OwnerRoleVal);
  });

  it('CM-003: explicit inheritPermission=false creates an independent resource (only own owner), no parent clbs', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const datasetId = oid();
    const collectionId = oid();

    const parentClbs = [
      { tmbId: String(users.owner.tmbId), permission: OwnerRoleVal },
      { tmbId: String(users.members[0].tmbId), permission: WriteRoleVal }
    ];

    await mongoSessionRun(async (session) => {
      await createCollectionPermission({
        resource: {
          _id: collectionId,
          teamId,
          type: DatasetCollectionTypeEnum.file,
          parentId: null,
          datasetId,
          tmbId: String(users.owner.tmbId)
        },
        parentClbs,
        inheritPermission: false,
        session
      });
    });

    const clbs = await getCollectionClbs(collectionId, teamId);
    expect(clbs).toHaveLength(1);
    expect(String(clbs[0].tmbId)).toBe(String(users.owner.tmbId));
    expect(clbs[0].permission).toBe(OwnerRoleVal);
  });
});

describe('getDatasetEffectiveClbs / getCollectionCreateParentClbs ', () => {
  it('dataset effective clbs = own clbs + direct parent Dataset Folder snapshot (folder is full config)', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const ownerTmb = String(users.owner.tmbId);
    const m1 = String(users.members[0].tmbId);
    const m2 = String(users.members[1].tmbId);

    // folder F1 (full snapshot: owner + m1 read)  →  dataset D under F1 (own: owner + m2 write)
    const f1 = await MongoDataset.create({
      teamId,
      tmbId: ownerTmb,
      name: 'F1',
      type: DatasetTypeEnum.folder
    });
    const d = await MongoDataset.create({
      teamId,
      tmbId: ownerTmb,
      name: 'D',
      parentId: String(f1._id),
      inheritPermission: true
    });

    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: String(f1._id),
      tmbId: ownerTmb,
      permission: OwnerRoleVal
    });
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: String(f1._id),
      tmbId: m1,
      permission: ReadRoleVal
    });
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: String(d._id),
      tmbId: ownerTmb,
      permission: OwnerRoleVal
    });
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: String(d._id),
      tmbId: m2,
      permission: WriteRoleVal
    });

    const effective = await getDatasetEffectiveClbs({
      teamId,
      datasetId: String(d._id)
    });
    const map = clbMap(effective as any);
    // 祖先 folder F1 的 m1(read) 被并入（修复前仅 D 自身 clbs，缺 m1）
    expect(map.get(m1)?.permission).toBe(ReadRoleVal);
    expect(map.get(m2)?.permission).toBe(WriteRoleVal);
    expect(map.get(ownerTmb)?.permission).toBe(OwnerRoleVal);
  });

  it('root dataset (no parentId) effective clbs = own clbs only', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const ownerTmb = String(users.owner.tmbId);
    const m1 = String(users.members[0].tmbId);

    const d = await MongoDataset.create({ teamId, tmbId: ownerTmb, name: 'D-root' });
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: String(d._id),
      tmbId: ownerTmb,
      permission: OwnerRoleVal
    });
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: String(d._id),
      tmbId: m1,
      permission: ReadRoleVal
    });

    const effective = await getDatasetEffectiveClbs({
      teamId,
      datasetId: String(d._id)
    });
    const map = clbMap(effective as any);
    expect(map.get(ownerTmb)?.permission).toBe(OwnerRoleVal);
    expect(map.get(m1)?.permission).toBe(ReadRoleVal);
    expect(effective).toHaveLength(2);
  });

  it('getCollectionCreateParentClbs uses dataset effective clbs for a root collection', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const ownerTmb = String(users.owner.tmbId);
    const m1 = String(users.members[0].tmbId);

    const f1 = await MongoDataset.create({
      teamId,
      tmbId: ownerTmb,
      name: 'F1',
      type: DatasetTypeEnum.folder
    });
    const d = await MongoDataset.create({
      teamId,
      tmbId: ownerTmb,
      name: 'D',
      parentId: String(f1._id),
      inheritPermission: true
    });
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: String(f1._id),
      tmbId: ownerTmb,
      permission: OwnerRoleVal
    });
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: String(f1._id),
      tmbId: m1,
      permission: ReadRoleVal
    });
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: String(d._id),
      tmbId: ownerTmb,
      permission: OwnerRoleVal
    });

    let parentClbs: Awaited<ReturnType<typeof getCollectionCreateParentClbs>> = [];
    await mongoSessionRun(async (session) => {
      parentClbs = await getCollectionCreateParentClbs({
        teamId,
        datasetId: String(d._id),
        parentId: null,
        session
      });
    });
    const map = clbMap(parentClbs as any);
    // 根 collection 的父级 clbs = dataset 有效 clbs（含祖先 folder F1 的 m1）
    expect(map.get(m1)?.permission).toBe(ReadRoleVal);
    expect(map.get(ownerTmb)?.permission).toBe(OwnerRoleVal);
  });
});

describe('createOneCollection integration ', { timeout: 120000 }, () => {
  const createDataset = async ({ teamId, tmbId }: { teamId: string; tmbId: string }) => {
    const dataset = await MongoDataset.create({ teamId, tmbId, name: 'test-dataset' });
    return dataset;
  };

  it('creates a folder collection with a full snapshot from the dataset clbs', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const dataset = await createDataset({ teamId, tmbId: String(users.owner.tmbId) });
    const datasetId = String(dataset._id);

    // dataset clbs: owner + member1 read
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: datasetId,
      tmbId: users.members[0].tmbId,
      permission: ReadRoleVal
    });

    const collection = await createOneCollection({
      teamId,
      tmbId: String(users.owner.tmbId),
      datasetId,
      type: DatasetCollectionTypeEnum.folder,
      name: 'folder-a'
    });

    const clbs = await getCollectionClbs(String(collection._id), teamId);
    const map = clbMap(clbs);
    expect(map.get(String(users.owner.tmbId))?.permission).toBe(OwnerRoleVal);
    expect(map.get(String(users.members[0].tmbId))?.permission).toBe(ReadRoleVal);
    expect(collection.inheritPermission).toBe(true);
  });

  it('creates a non-folder collection with a full snapshot from the dataset clbs', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const dataset = await createDataset({ teamId, tmbId: String(users.owner.tmbId) });
    const datasetId = String(dataset._id);

    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: datasetId,
      tmbId: users.members[0].tmbId,
      permission: ReadRoleVal
    });

    const collection = await createOneCollection({
      teamId,
      tmbId: String(users.owner.tmbId),
      datasetId,
      type: DatasetCollectionTypeEnum.file,
      name: 'file-a'
    });

    const clbs = await getCollectionClbs(String(collection._id), teamId);
    const map = clbMap(clbs);
    // 全快照：dataset clbs + 自身 owner
    expect(clbs).toHaveLength(2);
    expect(map.get(String(users.owner.tmbId))?.permission).toBe(OwnerRoleVal);
    expect(map.get(String(users.members[0].tmbId))?.permission).toBe(ReadRoleVal);
  });

  it('creates a folder under a parent collection folder, snapshot comes from the parent folder snapshot', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const dataset = await createDataset({ teamId, tmbId: String(users.owner.tmbId) });
    const datasetId = String(dataset._id);

    // parent collection folder with a snapshot
    const parentFolder = await createOneCollection({
      teamId,
      tmbId: String(users.owner.tmbId),
      datasetId,
      type: DatasetCollectionTypeEnum.folder,
      name: 'parent-folder'
    });
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: String(parentFolder._id),
      tmbId: users.members[0].tmbId,
      permission: WriteRoleVal
    });

    // child folder under the parent folder
    const childFolder = await createOneCollection({
      teamId,
      tmbId: String(users.owner.tmbId),
      datasetId,
      parentId: String(parentFolder._id),
      type: DatasetCollectionTypeEnum.folder,
      name: 'child-folder'
    });

    const clbs = await getCollectionClbs(String(childFolder._id), teamId);
    const map = clbMap(clbs);
    // snapshot = parent folder clbs (owner + member1 write) + own owner
    expect(clbs).toHaveLength(2);
    expect(map.get(String(users.owner.tmbId))?.permission).toBe(OwnerRoleVal);
    expect(map.get(String(users.members[0].tmbId))?.permission).toBe(WriteRoleVal);
    expect(String(childFolder.parentId)).toBe(String(parentFolder._id));
  });

  it('non-folder collection under a parent folder gets a full snapshot from the parent folder snapshot', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const dataset = await createDataset({ teamId, tmbId: String(users.owner.tmbId) });
    const datasetId = String(dataset._id);

    const parentFolder = await MongoDatasetCollection.create({
      teamId,
      tmbId: String(users.owner.tmbId),
      datasetId,
      parentId: null,
      type: DatasetCollectionTypeEnum.folder,
      name: 'parent-folder'
    });
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: String(parentFolder._id),
      tmbId: users.members[0].tmbId,
      permission: ReadRoleVal
    });

    const collection = await createOneCollection({
      teamId,
      tmbId: String(users.owner.tmbId),
      datasetId,
      parentId: String(parentFolder._id),
      type: DatasetCollectionTypeEnum.file,
      name: 'file-under-folder'
    });

    const clbs = await getCollectionClbs(String(collection._id), teamId);
    const map = clbMap(clbs);
    // 全快照：父 Folder 快照（owner + member1 read）+ 自身 owner
    expect(clbs).toHaveLength(2);
    expect(map.get(String(users.owner.tmbId))?.permission).toBe(OwnerRoleVal);
    expect(map.get(String(users.members[0].tmbId))?.permission).toBe(ReadRoleVal);
  });
});
