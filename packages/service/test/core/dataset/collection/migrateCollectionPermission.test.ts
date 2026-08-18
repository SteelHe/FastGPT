import { describe, expect, it } from 'vitest';
import { Types } from '@fastgpt/service/common/mongo';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import {
  ManageRoleVal,
  OwnerRoleVal,
  PerResourceTypeEnum,
  ReadRoleVal
} from '@fastgpt/global/support/permission/constant';
import { getFakeUsers } from '@test/datas/users';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import {
  COLLECTION_PERMISSION_MIGRATION_VERSION,
  buildCollectionTree,
  computeFolderSnapshot,
  diffClbs,
  getDatasetEffectiveClbs,
  migrateCollectionPermissions,
  migrateDatasetCollections,
  normalizeClbs,
  validateCollectionPermissionMigration,
  type CollectionForMigration
} from '@fastgpt/service/core/dataset/collection/migrateCollectionPermission';

const oid = () => new Types.ObjectId().toString();

/** Insert a legacy-style collection (raw driver: no schema defaults, no inheritPermission). */
const rawInsertCollection = async (data: {
  teamId: string;
  datasetId: string;
  tmbId: string;
  type: string;
  name: string;
  parentId?: string;
}) => {
  const res = await MongoDatasetCollection.collection.insertOne({
    teamId: new Types.ObjectId(data.teamId),
    datasetId: new Types.ObjectId(data.datasetId),
    tmbId: new Types.ObjectId(data.tmbId),
    type: data.type,
    name: data.name,
    ...(data.parentId ? { parentId: new Types.ObjectId(data.parentId) } : {}),
    createTime: new Date(),
    updateTime: new Date()
  } as any);
  return String(res.insertedId);
};

const createDataset = async (data: {
  teamId: string;
  tmbId: string;
  name: string;
  type?: string;
  parentId?: string;
  inheritPermission?: boolean;
}) => {
  const doc = await MongoDataset.create({
    teamId: new Types.ObjectId(data.teamId),
    tmbId: new Types.ObjectId(data.tmbId),
    name: data.name,
    type: data.type ?? 'dataset',
    ...(data.parentId ? { parentId: new Types.ObjectId(data.parentId) } : {}),
    ...(data.inheritPermission !== undefined ? { inheritPermission: data.inheritPermission } : {})
  } as any);
  return String(doc._id);
};

const addDatasetClb = async (data: {
  teamId: string;
  resourceId: string;
  tmbId: string;
  permission: number;
}) => {
  await MongoResourcePermission.create({
    resourceType: PerResourceTypeEnum.dataset,
    teamId: data.teamId,
    resourceId: data.resourceId,
    tmbId: data.tmbId,
    permission: data.permission
  });
};

const getCollectionClbs = async (teamId: string, resourceId: string) =>
  MongoResourcePermission.find({
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId
  }).lean();

const toClbSet = (clbs: Array<{ tmbId?: any; groupId?: any; orgId?: any; permission: number }>) =>
  new Map(
    clbs.map((c) => {
      const id = String(c.tmbId ?? c.groupId ?? c.orgId);
      return [id, c.permission];
    })
  );

const expectClbsEqual = (
  actual: Array<{ tmbId?: any; groupId?: any; orgId?: any; permission: number }>,
  expected: Array<{ tmbId?: any; groupId?: any; orgId?: any; permission: number }>
) => {
  const actualMap = toClbSet(actual);
  const expectedMap = toClbSet(expected);
  expect(actualMap.size).toBe(expectedMap.size);
  for (const [id, per] of expectedMap) {
    expect(actualMap.get(id)).toBe(per);
  }
};

describe('buildCollectionTree ', () => {
  it('builds a topological folder order with roots first and detects orphans', () => {
    const F1 = oid();
    const F2 = oid();
    const C1 = oid();
    const orphan = oid();
    const collections: CollectionForMigration[] = [
      { _id: F1, tmbId: oid(), type: DatasetCollectionTypeEnum.folder },
      { _id: F2, tmbId: oid(), parentId: F1, type: DatasetCollectionTypeEnum.folder },
      { _id: C1, tmbId: oid(), parentId: F2, type: DatasetCollectionTypeEnum.file },
      { _id: orphan, tmbId: oid(), parentId: oid(), type: DatasetCollectionTypeEnum.folder }
    ];

    const { order, cycles, orphans, parentSourceMap } = buildCollectionTree(collections);

    expect(orphans).toContain(orphan);
    expect(cycles).toHaveLength(0);
    const orderIds = order.map((n) => String(n.collection._id));
    // F1 (root) before F2 (child); orphan is a root fallback
    expect(orderIds.indexOf(F1)).toBeLessThan(orderIds.indexOf(F2));
    expect(parentSourceMap.get(F1)).toBe('dataset');
    expect(parentSourceMap.get(F2)).toBe(F1);
    expect(parentSourceMap.get(orphan)).toBe('dataset');
  });

  it('detects a parentId cycle and excludes it from the processing order', () => {
    const X = oid();
    const Y = oid();
    const collections: CollectionForMigration[] = [
      { _id: X, tmbId: oid(), parentId: Y, type: DatasetCollectionTypeEnum.folder },
      { _id: Y, tmbId: oid(), parentId: X, type: DatasetCollectionTypeEnum.folder }
    ];

    const { order, cycles } = buildCollectionTree(collections);

    expect(cycles).toEqual(expect.arrayContaining([X, Y]));
    expect(order.map((n) => String(n.collection._id))).not.toContain(X);
    expect(order.map((n) => String(n.collection._id))).not.toContain(Y);
  });
});

describe('computeFolderSnapshot / diffClbs (pure snapshot logic)', () => {
  it('maps the parent owner to manage and adds the folder owner', () => {
    const parentOwner = oid();
    const parentMember = oid();
    const folderOwner = oid();
    const snapshot = computeFolderSnapshot({
      collection: { _id: oid(), tmbId: folderOwner, type: DatasetCollectionTypeEnum.folder },
      parentClbs: [
        { tmbId: parentOwner, permission: OwnerRoleVal },
        { tmbId: parentMember, permission: ReadRoleVal }
      ]
    });

    const byId = toClbSet(snapshot);
    expect(byId.get(parentOwner)).toBe(ManageRoleVal); // parent owner capped to manage
    expect(byId.get(parentMember)).toBe(ReadRoleVal);
    expect(byId.get(folderOwner)).toBe(OwnerRoleVal); // own owner stays owner
    expect(snapshot).toHaveLength(3);
  });

  it('computes insert / update / remove diffs with normalized ids', () => {
    const a = oid();
    const b = oid();
    const c = oid();
    const current = [
      { tmbId: a, permission: ReadRoleVal },
      { tmbId: b, permission: ReadRoleVal }
    ];
    const target = [
      { tmbId: a, permission: OwnerRoleVal }, // update
      { tmbId: c, permission: ReadRoleVal } // insert
    ];
    const diff = diffClbs({ currentClbs: current, targetClbs: target });

    expect(diff.insert.map((x) => String(x.tmbId))).toEqual([c]);
    expect(diff.update.map((x) => String(x.tmbId))).toEqual([a]);
    expect(diff.update[0].permission).toBe(OwnerRoleVal);
    expect(diff.remove.map((x) => String(x.tmbId))).toEqual([b]);
  });

  it('normalizes ObjectId vs string ids to the same key', () => {
    const id = new Types.ObjectId().toString();
    const withObjId = normalizeClbs([
      { tmbId: new Types.ObjectId(id) as unknown as string, permission: ReadRoleVal }
    ]);
    const withString = normalizeClbs([{ tmbId: id, permission: ReadRoleVal }]);
    expect(String(withObjId[0].tmbId)).toBe(String(withString[0].tmbId));
    expect(diffClbs({ currentClbs: withObjId, targetClbs: withString })).toEqual({
      insert: [],
      update: [],
      remove: []
    });
  });
});

describe('getDatasetEffectiveClbs ', () => {
  it('walks the dataset folder chain and merges effective collaborators', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const ownerTmbId = users.owner.tmbId;
    const memberTmbId = users.members[0].tmbId;

    const D1 = await createDataset({ teamId, tmbId: ownerTmbId, name: 'D1', type: 'folder' });
    const D2 = await createDataset({
      teamId,
      tmbId: memberTmbId,
      name: 'D2',
      type: 'dataset',
      parentId: D1
    });
    await addDatasetClb({ teamId, resourceId: D1, tmbId: ownerTmbId, permission: OwnerRoleVal });
    await addDatasetClb({ teamId, resourceId: D1, tmbId: memberTmbId, permission: ReadRoleVal });
    await addDatasetClb({ teamId, resourceId: D2, tmbId: memberTmbId, permission: OwnerRoleVal });

    const effective = await getDatasetEffectiveClbs({
      dataset: {
        _id: D2,
        teamId,
        parentId: D1,
        inheritPermission: true
      }
    });

    const byId = toClbSet(effective);
    expect(byId.get(ownerTmbId)).toBe(ManageRoleVal); // D1 owner capped to manage
    expect(byId.get(memberTmbId)).toBe(OwnerRoleVal); // D2 owner stays owner
    expect(effective).toHaveLength(2);
  });
});

describe('migrateDatasetCollections ', () => {
  it('MG-001: root folder, child folder and normal collection get correct state', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const ownerTmbId = users.owner.tmbId;
    const memberTmbId = users.members[0].tmbId;

    const datasetId = await createDataset({ teamId, tmbId: ownerTmbId, name: 'D' });
    await addDatasetClb({
      teamId,
      resourceId: datasetId,
      tmbId: ownerTmbId,
      permission: OwnerRoleVal
    });
    await addDatasetClb({
      teamId,
      resourceId: datasetId,
      tmbId: memberTmbId,
      permission: ReadRoleVal
    });

    const F1 = await rawInsertCollection({
      teamId,
      datasetId,
      tmbId: ownerTmbId,
      type: DatasetCollectionTypeEnum.folder,
      name: 'F1'
    });
    const F2 = await rawInsertCollection({
      teamId,
      datasetId,
      tmbId: memberTmbId,
      type: DatasetCollectionTypeEnum.folder,
      name: 'F2',
      parentId: F1
    });
    const C1 = await rawInsertCollection({
      teamId,
      datasetId,
      tmbId: memberTmbId,
      type: DatasetCollectionTypeEnum.file,
      name: 'C1'
    });

    const result = await migrateDatasetCollections({ teamId, datasetId });

    expect(result.issues).toHaveLength(0);

    // F1: root folder -> Dataset effective clbs + own owner (owner + member read)
    const f1Clbs = await getCollectionClbs(teamId, F1);
    expect(f1Clbs).toHaveLength(2);
    expectClbsEqual(f1Clbs, [
      { tmbId: ownerTmbId, permission: OwnerRoleVal },
      { tmbId: memberTmbId, permission: ReadRoleVal }
    ]);

    // F2: child folder -> F1 snapshot + own owner (parent owner capped to manage)
    const f2Clbs = await getCollectionClbs(teamId, F2);
    expect(f2Clbs).toHaveLength(2);
    expectClbsEqual(f2Clbs, [
      { tmbId: ownerTmbId, permission: ManageRoleVal },
      { tmbId: memberTmbId, permission: OwnerRoleVal }
    ]);

    // C1: normal collection -> full snapshot = merge(Dataset 有效 clbs, 自身 owner)
    // （全快照模型；Dataset 有效 = [owner:Owner, member:Read]，C1 owner = member）
    const c1Clbs = await getCollectionClbs(teamId, C1);
    expect(c1Clbs).toHaveLength(2);
    expectClbsEqual(c1Clbs, [
      { tmbId: ownerTmbId, permission: ManageRoleVal },
      { tmbId: memberTmbId, permission: OwnerRoleVal }
    ]);

    // All migrated collections marked with the version
    const cols = await MongoDatasetCollection.find({ datasetId, teamId }).lean();
    expect(cols).toHaveLength(3);
    for (const c of cols) {
      expect(c.inheritPermission).toBe(true);
      expect(c.permissionMigrationVersion).toBe(COLLECTION_PERMISSION_MIGRATION_VERSION);
    }
  });

  it('MG-002: all legacy collections are initialized to inheritPermission=true', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const datasetId = await createDataset({ teamId, tmbId: users.owner.tmbId, name: 'D' });
    await addDatasetClb({
      teamId,
      resourceId: datasetId,
      tmbId: users.owner.tmbId,
      permission: OwnerRoleVal
    });

    const C1 = await rawInsertCollection({
      teamId,
      datasetId,
      tmbId: users.owner.tmbId,
      type: DatasetCollectionTypeEnum.file,
      name: 'C1'
    });

    // legacy collection was inserted without inheritPermission -> must be true after migration
    const before = await MongoDatasetCollection.findById(C1).lean();
    expect(before?.inheritPermission).toBeUndefined();

    await migrateDatasetCollections({ teamId, datasetId });

    const after = await MongoDatasetCollection.findById(C1).lean();
    expect(after?.inheritPermission).toBe(true);
  });

  it('MG-004: orphan parentId is reported and cyclic folders get no snapshot', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const datasetId = await createDataset({ teamId, tmbId: users.owner.tmbId, name: 'D' });
    await addDatasetClb({
      teamId,
      resourceId: datasetId,
      tmbId: users.owner.tmbId,
      permission: OwnerRoleVal
    });

    const orphan = await rawInsertCollection({
      teamId,
      datasetId,
      tmbId: users.owner.tmbId,
      type: DatasetCollectionTypeEnum.folder,
      name: 'orphanFolder',
      parentId: oid() // non-existent parent
    });

    const X = await rawInsertCollection({
      teamId,
      datasetId,
      tmbId: users.owner.tmbId,
      type: DatasetCollectionTypeEnum.folder,
      name: 'X'
    });
    const Y = await rawInsertCollection({
      teamId,
      datasetId,
      tmbId: users.owner.tmbId,
      type: DatasetCollectionTypeEnum.folder,
      name: 'Y'
    });
    // create a cycle X -> Y -> X
    await MongoDatasetCollection.collection.updateOne(
      { _id: new Types.ObjectId(X) },
      { $set: { parentId: new Types.ObjectId(Y) } }
    );
    await MongoDatasetCollection.collection.updateOne(
      { _id: new Types.ObjectId(Y) },
      { $set: { parentId: new Types.ObjectId(X) } }
    );

    const result = await migrateDatasetCollections({ teamId, datasetId });

    expect(result.issues.some((i) => i.startsWith('orphan parentId'))).toBe(true);
    expect(result.issues.some((i) => i.includes(X) || i.includes(Y))).toBe(true);

    // orphan folder treated as root -> snapshot from dataset clbs
    const orphanClbs = await getCollectionClbs(teamId, orphan);
    expectClbsEqual(orphanClbs, [{ tmbId: users.owner.tmbId, permission: OwnerRoleVal }]);

    // cyclic folders: owner record only, no snapshot, and NOT marked as migrated
    const xClbs = await getCollectionClbs(teamId, X);
    const yClbs = await getCollectionClbs(teamId, Y);
    expectClbsEqual(xClbs, [{ tmbId: users.owner.tmbId, permission: OwnerRoleVal }]);
    expectClbsEqual(yClbs, [{ tmbId: users.owner.tmbId, permission: OwnerRoleVal }]);
    const xDoc = await MongoDatasetCollection.findById(X).lean();
    const yDoc = await MongoDatasetCollection.findById(Y).lean();
    expect(xDoc?.permissionMigrationVersion).not.toBe(COLLECTION_PERMISSION_MIGRATION_VERSION);
    expect(yDoc?.permissionMigrationVersion).not.toBe(COLLECTION_PERMISSION_MIGRATION_VERSION);
  });

  it('cleanup: deletes duplicate / wrongly-granted owner records', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const datasetId = await createDataset({ teamId, tmbId: users.owner.tmbId, name: 'D' });
    await addDatasetClb({
      teamId,
      resourceId: datasetId,
      tmbId: users.owner.tmbId,
      permission: OwnerRoleVal
    });

    const C1 = await rawInsertCollection({
      teamId,
      datasetId,
      tmbId: users.owner.tmbId,
      type: DatasetCollectionTypeEnum.file,
      name: 'C1'
    });

    // pre-existing junk: a wrongly-granted owner (different tmbId) + a duplicate owner
    await MongoResourcePermission.insertMany([
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: C1,
        tmbId: users.members[0].tmbId,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: C1,
        tmbId: users.owner.tmbId,
        permission: OwnerRoleVal
      }
    ]);

    const result = await migrateDatasetCollections({ teamId, datasetId });

    const c1Clbs = await getCollectionClbs(teamId, C1);
    expect(c1Clbs).toHaveLength(1);
    expectClbsEqual(c1Clbs, [{ tmbId: users.owner.tmbId, permission: OwnerRoleVal }]);
    expect(result.issues).toHaveLength(0);
  });
});

describe('migrateCollectionPermissions orchestration ', () => {
  it('MG-003: re-running is idempotent and only processes un-migrated resources', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const datasetId = await createDataset({ teamId, tmbId: users.owner.tmbId, name: 'D' });
    await addDatasetClb({
      teamId,
      resourceId: datasetId,
      tmbId: users.owner.tmbId,
      permission: OwnerRoleVal
    });
    await rawInsertCollection({
      teamId,
      datasetId,
      tmbId: users.owner.tmbId,
      type: DatasetCollectionTypeEnum.file,
      name: 'C1'
    });
    await rawInsertCollection({
      teamId,
      datasetId,
      tmbId: users.owner.tmbId,
      type: DatasetCollectionTypeEnum.folder,
      name: 'F1'
    });

    const first = await migrateCollectionPermissions();
    expect(first.migratedDatasets).toBe(1);
    expect(first.failed).toHaveLength(0);

    const recordCount = await MongoResourcePermission.countDocuments({
      resourceType: PerResourceTypeEnum.collection,
      teamId
    });
    expect(recordCount).toBe(2); // C1 owner + F1 snapshot(owner)

    // second run: everything already at version -> nothing to do
    const second = await migrateCollectionPermissions();
    expect(second.migratedDatasets).toBe(0);
    expect(second.failed).toHaveLength(0);

    const recordCountAfter = await MongoResourcePermission.countDocuments({
      resourceType: PerResourceTypeEnum.collection,
      teamId
    });
    expect(recordCountAfter).toBe(recordCount);
  });

  it('MG-005: a failing dataset is recorded and does not block the others', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;

    // valid dataset A
    const datasetA = await createDataset({ teamId, tmbId: users.owner.tmbId, name: 'A' });
    await addDatasetClb({
      teamId,
      resourceId: datasetA,
      tmbId: users.owner.tmbId,
      permission: OwnerRoleVal
    });
    const cA = await rawInsertCollection({
      teamId,
      datasetId: datasetA,
      tmbId: users.owner.tmbId,
      type: DatasetCollectionTypeEnum.file,
      name: 'C_A'
    });

    // dataset B has collections but no dataset document -> migration must fail
    const datasetB = oid();
    const cB = await rawInsertCollection({
      teamId,
      datasetId: datasetB,
      tmbId: users.owner.tmbId,
      type: DatasetCollectionTypeEnum.file,
      name: 'C_B'
    });

    const result = await migrateCollectionPermissions({ batchSize: 1 });

    expect(result.migratedDatasets).toBe(1);
    expect(result.failed.some((f) => f.datasetId === datasetB)).toBe(true);

    // failed batch is not fully migrated: no collection permission records were written
    // (the owner upsert runs after the throw point) and the version marker is absent,
    // so a re-run would re-process it. The transaction guarantees atomic rollback of the
    // writes that did run (mongoSessionRun) in production; see test-results.md caveat.
    const bClbs = await getCollectionClbs(teamId, cB);
    expect(bClbs).toHaveLength(0);
    const bDoc = await MongoDatasetCollection.findById(cB).lean();
    expect(bDoc?.permissionMigrationVersion).not.toBe(COLLECTION_PERMISSION_MIGRATION_VERSION);

    // dataset A fully migrated (query by the collection id, not the dataset id)
    const aClbs = await getCollectionClbs(teamId, cA);
    expectClbsEqual(aClbs, [{ tmbId: users.owner.tmbId, permission: OwnerRoleVal }]);
  });

  it('MG-006: post-migration validation samples and detects inconsistencies', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const datasetId = await createDataset({ teamId, tmbId: users.owner.tmbId, name: 'D' });
    await addDatasetClb({
      teamId,
      resourceId: datasetId,
      tmbId: users.owner.tmbId,
      permission: OwnerRoleVal
    });
    const C1 = await rawInsertCollection({
      teamId,
      datasetId,
      tmbId: users.owner.tmbId,
      type: DatasetCollectionTypeEnum.file,
      name: 'C1'
    });

    await migrateCollectionPermissions({ datasetIds: [datasetId] });

    // healthy state -> no issues
    const healthy = await validateCollectionPermissionMigration({
      datasetIds: [datasetId],
      sampleSize: 10
    });
    expect(healthy.checkedDatasets).toBe(1);
    expect(healthy.checkedCollections).toBe(1);
    expect(healthy.issues).toHaveLength(0);

    // introduce an inconsistency: delete the owner record -> validation reports it
    await MongoResourcePermission.deleteMany({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: C1,
      tmbId: users.owner.tmbId
    });
    const broken = await validateCollectionPermissionMigration({
      datasetIds: [datasetId],
      sampleSize: 10
    });
    expect(broken.issues.some((i) => i.type === 'owner_missing')).toBe(true);
  });
});
