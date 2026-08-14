import { describe, expect, it } from 'vitest';
import { Types, connectionMongo } from '@fastgpt/service/common/mongo';
import { mongoSessionRun } from '@fastgpt/service/common/mongo/sessionRun';
import { DatasetCollectionTypeEnum, DatasetTypeEnum } from '@fastgpt/global/core/dataset/constants';
import {
  ManageRoleVal,
  NullRoleVal,
  OwnerRoleVal,
  PerResourceTypeEnum,
  ReadRoleVal,
  WriteRoleVal
} from '@fastgpt/global/support/permission/constant';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { getResourceOwnedClbs } from '@fastgpt/service/support/permission/controller';
import { syncDatasetCollectionFolders } from '@fastgpt/service/support/permission/collection/folderSync';
import { deleteCollectionPermissions } from '@fastgpt/service/support/permission/collection/cleanup';
import { resolveCollectionPermission } from '@fastgpt/service/support/permission/collection/resolvePermission';
import {
  resumeInheritPermission,
  syncChildrenPermission,
  syncCollaborators
} from '@fastgpt/service/support/permission/inheritPermission';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { getFakeUsers } from '@test/datas/users';

const oid = () => new Types.ObjectId().toString();

const createDataset = async ({
  teamId,
  tmbId,
  name,
  type = DatasetTypeEnum.dataset,
  parentId,
  inheritPermission = true
}: {
  teamId: string;
  tmbId: string;
  name: string;
  type?: DatasetTypeEnum;
  parentId?: string;
  inheritPermission?: boolean;
}) =>
  MongoDataset.create({
    teamId,
    tmbId,
    name,
    type,
    ...(parentId ? { parentId } : {}),
    inheritPermission
  });

const createCollectionFolder = async ({
  teamId,
  tmbId,
  datasetId,
  parentId,
  inheritPermission = true
}: {
  teamId: string;
  tmbId: string;
  datasetId: string;
  parentId?: string;
  inheritPermission?: boolean;
}) =>
  MongoDatasetCollection.create({
    teamId,
    tmbId,
    datasetId,
    parentId: parentId ?? null,
    type: DatasetCollectionTypeEnum.folder,
    name: `folder-${Date.now()}-${Math.random()}`,
    inheritPermission
  });

const createCollection = async ({
  teamId,
  tmbId,
  datasetId,
  parentId
}: {
  teamId: string;
  tmbId: string;
  datasetId: string;
  parentId?: string;
}) =>
  MongoDatasetCollection.create({
    teamId,
    tmbId,
    datasetId,
    parentId: parentId ?? null,
    type: DatasetCollectionTypeEnum.file,
    name: `file-${Date.now()}-${Math.random()}`
  });

/** resourceId -> { collaboratorId -> permission } of its resource_permissions snapshot. */
const snapshotMap = async (teamId: string, resourceId: string) => {
  const clbs = await MongoResourcePermission.find({
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId
  }).lean();
  return new Map(
    clbs.map((clb) => [String(clb.tmbId ?? clb.groupId ?? clb.orgId), clb.permission])
  );
};

describe('Dataset permission propagation to Collection Folders ', () => {
  it('DP-001: dataset collaborator change propagates to descendant dataset collection folder snapshots', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const ownerTmb = String(users.owner.tmbId);
    const m1 = String(users.members[0].tmbId);

    // F1 -> F2 -> D1; D1 has a root Collection Folder CF1 with a file C1 inside
    const f1 = await createDataset({
      teamId,
      tmbId: ownerTmb,
      name: 'F1',
      type: DatasetTypeEnum.folder
    });
    const f2 = await createDataset({
      teamId,
      tmbId: ownerTmb,
      name: 'F2',
      type: DatasetTypeEnum.folder,
      parentId: String(f1._id)
    });
    const d1 = await createDataset({
      teamId,
      tmbId: ownerTmb,
      name: 'D1',
      parentId: String(f2._id)
    });
    const cf1 = await createCollectionFolder({
      teamId,
      tmbId: ownerTmb,
      datasetId: String(d1._id)
    });
    const c1 = await createCollection({
      teamId,
      tmbId: ownerTmb,
      datasetId: String(d1._id),
      parentId: String(cf1._id)
    });

    await mongoSessionRun(async (session) => {
      await MongoResourcePermission.insertMany(
        [
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(f1._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          },
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(f2._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          },
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(d1._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          },
          {
            // CF1 自身 owner 记录（生产由 createCollectionPermission 写入；syncCollaborators 需以此保留 owner）
            resourceType: PerResourceTypeEnum.collection,
            teamId,
            resourceId: String(cf1._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          }
        ],
        { session }
      );

      // change F1 collaborators: add M1 read. For a folder, updateResourceCollaborators runs
      // syncChildrenPermission(F1, newClbs) first; then Collection Folder propagation seeds
      // from F1's effective clbs (F1 is root-level, so effective = its own clbs).
      const newF1Clbs = [
        { tmbId: ownerTmb, permission: OwnerRoleVal },
        { tmbId: m1, permission: ReadRoleVal }
      ];
      await syncChildrenPermission({
        resource: f1,
        resourceModel: MongoDataset,
        folderTypeList: [DatasetTypeEnum.folder],
        resourceType: PerResourceTypeEnum.dataset,
        session,
        collaborators: newF1Clbs
      });
      await syncDatasetCollectionFolders({
        teamId,
        datasetId: String(f1._id),
        rootClbs: newF1Clbs,
        session
      });
    });

    // D1's root Collection Folder snapshot must include M1 read
    const cf1Map = await snapshotMap(teamId, String(cf1._id));
    expect(cf1Map.get(m1)).toBe(ReadRoleVal);
    expect(cf1Map.get(ownerTmb)).toBe(OwnerRoleVal);

    // C1 (ordinary inherited collection) resolves read for M1 via CF1 snapshot, with no own record written
    const c1Per = await resolveCollectionPermission({
      collection: {
        _id: String(c1._id),
        tmbId: ownerTmb,
        parentId: String(cf1._id),
        inheritPermission: true,
        type: DatasetCollectionTypeEnum.file
      },
      tmbId: m1,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: NullRoleVal
    });
    expect(c1Per).toBe(ReadRoleVal);
    expect(
      await MongoResourcePermission.countDocuments({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(c1._id)
      })
    ).toBe(0);
  });

  it('DP-002: dataset move with inheritPermission=true re-seeds collection folder snapshots from the new parent clbs', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const ownerTmb = String(users.owner.tmbId);
    const m2 = String(users.members[1].tmbId);

    const oldParent = await createDataset({
      teamId,
      tmbId: ownerTmb,
      name: 'A',
      type: DatasetTypeEnum.folder
    });
    const newParent = await createDataset({
      teamId,
      tmbId: ownerTmb,
      name: 'B',
      type: DatasetTypeEnum.folder
    });
    const d1 = await createDataset({
      teamId,
      tmbId: ownerTmb,
      name: 'D1',
      parentId: String(oldParent._id)
    });
    const cf1 = await createCollectionFolder({
      teamId,
      tmbId: ownerTmb,
      datasetId: String(d1._id)
    });

    await mongoSessionRun(async (session) => {
      await MongoResourcePermission.insertMany(
        [
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(oldParent._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          },
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(newParent._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          },
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(newParent._id),
            tmbId: m2,
            permission: ReadRoleVal
          },
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(d1._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          },
          {
            // CF1 自身 owner 记录（生产由 createCollectionPermission 写入）
            resourceType: PerResourceTypeEnum.collection,
            teamId,
            resourceId: String(cf1._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          }
        ],
        { session }
      );

      // simulate move (inherit=true): syncCollaborators merges target parent clbs into D1,
      // then Collection Folder sync seeds from D1's effective clbs (read back after merge)
      const parentClbs = await getResourceOwnedClbs({
        teamId,
        resourceId: String(newParent._id),
        resourceType: PerResourceTypeEnum.dataset,
        session
      });
      await syncCollaborators({
        teamId,
        resourceId: String(d1._id),
        resourceType: PerResourceTypeEnum.dataset,
        collaborators: parentClbs,
        session
      });
      const rootClbs = await getResourceOwnedClbs({
        teamId,
        resourceId: String(d1._id),
        resourceType: PerResourceTypeEnum.dataset,
        session
      });
      await syncDatasetCollectionFolders({ teamId, datasetId: String(d1._id), rootClbs, session });
    });

    const cf1Map = await snapshotMap(teamId, String(cf1._id));
    expect(cf1Map.get(m2)).toBe(ReadRoleVal);
    expect(cf1Map.get(ownerTmb)).toBe(OwnerRoleVal);
  });

  it('DP-003: non-inherited collection folder keeps its independent config during propagation', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const ownerTmb = String(users.owner.tmbId);
    const m1 = String(users.members[0].tmbId);
    const m2 = String(users.members[1].tmbId);

    const d1 = await createDataset({ teamId, tmbId: ownerTmb, name: 'D1' });
    const privateF = await createCollectionFolder({
      teamId,
      tmbId: ownerTmb,
      datasetId: String(d1._id),
      inheritPermission: false
    });

    await mongoSessionRun(async (session) => {
      await MongoResourcePermission.insertMany(
        [
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(d1._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          },
          // independent grant on the non-inherited folder
          {
            resourceType: PerResourceTypeEnum.collection,
            teamId,
            resourceId: String(privateF._id),
            tmbId: m1,
            permission: WriteRoleVal
          }
        ],
        { session }
      );

      const rootClbs = [
        { tmbId: ownerTmb, permission: OwnerRoleVal },
        { tmbId: m2, permission: ReadRoleVal }
      ];
      await syncDatasetCollectionFolders({ teamId, datasetId: String(d1._id), rootClbs, session });
    });

    const privateMap = await snapshotMap(teamId, String(privateF._id));
    expect(privateMap.get(m1)).toBe(WriteRoleVal);
    expect(privateMap.get(m2)).toBeUndefined();
  });

  it('DP-004: move with inheritPermission=false does not sync target parent clbs into collection folder snapshots', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const ownerTmb = String(users.owner.tmbId);
    const m1 = String(users.members[0].tmbId);
    const m2 = String(users.members[1].tmbId);

    const newParent = await createDataset({
      teamId,
      tmbId: ownerTmb,
      name: 'B',
      type: DatasetTypeEnum.folder
    });
    const d1 = await createDataset({
      teamId,
      tmbId: ownerTmb,
      name: 'D1',
      inheritPermission: false
    });
    const cf1 = await createCollectionFolder({
      teamId,
      tmbId: ownerTmb,
      datasetId: String(d1._id)
    });

    await mongoSessionRun(async (session) => {
      await MongoResourcePermission.insertMany(
        [
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(newParent._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          },
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(newParent._id),
            tmbId: m2,
            permission: ReadRoleVal
          },
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(d1._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          },
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(d1._id),
            tmbId: m1,
            permission: WriteRoleVal
          }
        ],
        { session }
      );
      // initial snapshot of CF1 based on D1's own independent clbs
      await syncDatasetCollectionFolders({
        teamId,
        datasetId: String(d1._id),
        rootClbs: [
          { tmbId: ownerTmb, permission: OwnerRoleVal },
          { tmbId: m1, permission: WriteRoleVal }
        ],
        session
      });
      // move (inherit=false): only parentId updated, inheritPermission stays false, NO permission sync
      await MongoDataset.updateOne(
        { _id: d1._id },
        { parentId: String(newParent._id), inheritPermission: false },
        { session }
      );
    });

    const cf1Map = await snapshotMap(teamId, String(cf1._id));
    expect(cf1Map.get(m1)).toBe(WriteRoleVal);
    expect(cf1Map.get(m2)).toBeUndefined();
  });

  it('DP-005: collection permission records are cleaned in the same transaction and roll back on failure', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const ownerTmb = String(users.owner.tmbId);

    const d1 = await createDataset({ teamId, tmbId: ownerTmb, name: 'D1' });
    const cf1 = await createCollectionFolder({
      teamId,
      tmbId: ownerTmb,
      datasetId: String(d1._id)
    });
    const c1 = await createCollection({ teamId, tmbId: ownerTmb, datasetId: String(d1._id) });

    const collectionIds = [String(cf1._id), String(c1._id)];

    await mongoSessionRun(async (session) => {
      await MongoResourcePermission.insertMany(
        [
          {
            resourceType: PerResourceTypeEnum.collection,
            teamId,
            resourceId: String(cf1._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          },
          {
            resourceType: PerResourceTypeEnum.collection,
            teamId,
            resourceId: String(c1._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          },
          {
            resourceType: PerResourceTypeEnum.collection,
            teamId,
            resourceId: String(c1._id),
            tmbId: users.members[0].tmbId,
            permission: ReadRoleVal
          }
        ],
        { session }
      );
    });

    // committed cleanup removes all collection permission records
    await mongoSessionRun(async (session) => {
      await deleteCollectionPermissions({ teamId, collectionIds, session });
    });
    expect(
      await MongoResourcePermission.countDocuments({
        resourceType: PerResourceTypeEnum.collection,
        teamId
      })
    ).toBe(0);

    // re-insert a record and verify a real transaction aborts the cleanup (no orphan half-state).
    // NOTE: the test env mocks mongoSessionRun to run fn(null) without a real session, so we
    // manually start a real transaction to assert rollback (production delDatasetRelevantData
    // runs the same deleteMany inside a real mongoSessionRun transaction).
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: String(c1._id),
      tmbId: ownerTmb,
      permission: OwnerRoleVal
    });
    const session = await connectionMongo.startSession();
    session.startTransaction();
    await deleteCollectionPermissions({ teamId, collectionIds, session });
    await session.abortTransaction();
    await session.endSession();
    expect(
      await MongoResourcePermission.countDocuments({
        resourceType: PerResourceTypeEnum.collection,
        teamId
      })
    ).toBe(1);
  });

  it('DP-006: repeated sync is idempotent (no duplicate records, identical snapshots)', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const ownerTmb = String(users.owner.tmbId);
    const m1 = String(users.members[0].tmbId);

    const d1 = await createDataset({ teamId, tmbId: ownerTmb, name: 'D1' });
    const cf1 = await createCollectionFolder({
      teamId,
      tmbId: ownerTmb,
      datasetId: String(d1._id)
    });

    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: String(d1._id),
      tmbId: ownerTmb,
      permission: OwnerRoleVal
    });

    const rootClbs = [
      { tmbId: ownerTmb, permission: OwnerRoleVal },
      { tmbId: m1, permission: ReadRoleVal }
    ];

    const run = async () =>
      mongoSessionRun(async (session) => {
        await syncDatasetCollectionFolders({
          teamId,
          datasetId: String(d1._id),
          rootClbs,
          session
        });
      });
    await run();
    const snapshot1 = await MongoResourcePermission.find({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: String(cf1._id)
    }).lean();

    await run();
    const snapshot2 = await MongoResourcePermission.find({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: String(cf1._id)
    }).lean();

    const ids1 = snapshot1.map((c) => String(c.tmbId));
    expect(new Set(ids1).size).toBe(ids1.length);
    expect(snapshot2).toHaveLength(snapshot1.length);
    const per1 = new Map(snapshot1.map((c) => [String(c.tmbId), c.permission]));
    const per2 = new Map(snapshot2.map((c) => [String(c.tmbId), c.permission]));
    expect(per2).toEqual(per1);
  });

  it('resume inherit resumeInheritPermission with syncCollectionFolders rebuilds inherited collection folder snapshots', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const ownerTmb = String(users.owner.tmbId);
    const m1 = String(users.members[0].tmbId);
    const m2 = String(users.members[1].tmbId);

    const parent = await createDataset({
      teamId,
      tmbId: ownerTmb,
      name: 'Parent',
      type: DatasetTypeEnum.folder
    });
    const d1 = await createDataset({
      teamId,
      tmbId: ownerTmb,
      name: 'D1',
      parentId: String(parent._id)
    });
    const cf1 = await createCollectionFolder({
      teamId,
      tmbId: ownerTmb,
      datasetId: String(d1._id)
    });

    await mongoSessionRun(async (session) => {
      await MongoResourcePermission.insertMany(
        [
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(parent._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          },
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(parent._id),
            tmbId: m1,
            permission: ReadRoleVal
          },
          // d1 has its own independent collaborator
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(d1._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          },
          {
            resourceType: PerResourceTypeEnum.dataset,
            teamId,
            resourceId: String(d1._id),
            tmbId: m2,
            permission: WriteRoleVal
          },
          {
            // CF1 自身 owner 记录（生产由 createCollectionPermission 写入）
            resourceType: PerResourceTypeEnum.collection,
            teamId,
            resourceId: String(cf1._id),
            tmbId: ownerTmb,
            permission: OwnerRoleVal
          }
        ],
        { session }
      );
    });

    await resumeInheritPermission({
      resource: d1,
      folderTypeList: [DatasetTypeEnum.folder],
      resourceType: PerResourceTypeEnum.dataset,
      resourceModel: MongoDataset,
      syncCollectionFolders: true
    });

    // d1 effective = merge(parentClbs, oldMyClbs): inherits parent's M1 read, keeps own M2 write
    const cf1Map = await snapshotMap(teamId, String(cf1._id));
    expect(cf1Map.get(m1)).toBe(ReadRoleVal);
    expect(cf1Map.get(m2)).toBe(WriteRoleVal);
    expect(cf1Map.get(ownerTmb)).toBe(OwnerRoleVal);
  });
});
