import { describe, expect, it } from 'vitest';
import { mongoSessionRun } from '@fastgpt/service/common/mongo/sessionRun';
import { DatasetCollectionTypeEnum, DatasetTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { DatasetErrEnum } from '@fastgpt/global/common/error/code/dataset';
import {
  ManageRoleVal,
  OwnerRoleVal,
  PerResourceTypeEnum,
  ReadPermissionVal,
  ReadRoleVal,
  WriteRoleVal
} from '@fastgpt/global/support/permission/constant';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import {
  authDatasetByTmbId,
  authDatasetCollection
} from '@fastgpt/service/support/permission/dataset/auth';
import { syncDatasetCollectionFolders } from '@fastgpt/service/support/permission/collection/folderSync';
import {
  resumeInheritPermission,
  syncChildrenPermission
} from '@fastgpt/service/support/permission/inheritPermission';
import { getFakeUsers } from '@test/datas/users';
import { addDatasetClb, createCollection, createDataset, snapshotMap } from './helpers';

/**
 * 集成场景（跨能力链路，真实 MongoDB）：
 * - 场景 1：变更 folder 协作者（F1→F2→D1→C1，F1 加 M1 read）→ F2/D1/C1 对 M1 可读
 * - 场景 2：非继承态子资源不被覆盖
 * - 场景 5：恢复继承（F 关继承加私有协作者后 resume）
 */
const TIMEOUT = 60_000;

describe('scenario 1: changing a folder collaborator propagates to folder / dataset / collection', () => {
  it(
    'F1 -> F2 -> D1 -> C1, adding M1 read on F1 makes F2/D1/C1 readable by M1',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const ownerTmb = String(users.owner.tmbId);
      const m1 = String(users.members[0].tmbId);

      // F1 (dataset folder) -> F2 (dataset folder) -> D1 (dataset) -> C1 (collection)
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
      const c1 = await createCollection({ teamId, tmbId: ownerTmb, datasetId: String(d1._id) });

      await MongoResourcePermission.insertMany([
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
        // C1 owner record (inherited non-folder still carries its owner record)
        {
          resourceType: PerResourceTypeEnum.collection,
          teamId,
          resourceId: String(c1._id),
          tmbId: ownerTmb,
          permission: OwnerRoleVal
        }
      ]);

      // pre-condition: M1 cannot read F2 / D1 / C1
      await expect(
        authDatasetByTmbId({ tmbId: m1, datasetId: String(f2._id), per: ReadPermissionVal })
      ).rejects.toBe(DatasetErrEnum.unAuthDataset);
      await expect(
        authDatasetByTmbId({ tmbId: m1, datasetId: String(d1._id), per: ReadPermissionVal })
      ).rejects.toBe(DatasetErrEnum.unAuthDataset);
      await expect(
        authDatasetCollection({
          req: { auth: users.members[0] } as any,
          authToken: true,
          collectionId: String(c1._id),
          per: ReadPermissionVal
        })
      ).rejects.toBe(DatasetErrEnum.unAuthDataset);

      // change F1 collaborators: add M1 read
      const newF1Clbs = [
        { tmbId: ownerTmb, permission: OwnerRoleVal },
        { tmbId: m1, permission: ReadRoleVal }
      ];
      await mongoSessionRun(async (session) => {
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

      // F2 (dataset folder) got M1 read snapshot via syncChildrenPermission
      await expect(
        authDatasetByTmbId({ tmbId: m1, datasetId: String(f2._id), per: ReadPermissionVal })
      ).resolves.toBeDefined();
      // D1 (dataset) dynamically merges F1->F2 chain
      await expect(
        authDatasetByTmbId({ tmbId: m1, datasetId: String(d1._id), per: ReadPermissionVal })
      ).resolves.toBeDefined();
      // C1 (collection) readable via dataset gate + root-inherited dataset permission
      const c1Auth = await authDatasetCollection({
        req: { auth: users.members[0] } as any,
        authToken: true,
        collectionId: String(c1._id),
        per: ReadPermissionVal
      });
      expect(String(c1Auth.collection._id)).toBe(String(c1._id));
      expect(c1Auth.permission.checkPer(ReadPermissionVal)).toBe(true);
    },
    TIMEOUT
  );
});

describe('scenario 2: a non-inherited child resource is not overwritten by parent collaborator change', () => {
  it(
    'F1(inherited) -> F2(non-inherited) -> F3(inherited): changing F1 does not touch F2, and F3 follows F2 snapshot',
    async () => {
      const users = await getFakeUsers(2);
      const teamId = users.owner.teamId;
      const ownerTmb = String(users.owner.tmbId);
      const m1 = String(users.members[0].tmbId);
      const m2 = String(users.members[1].tmbId);

      const dataset = await createDataset({ teamId, tmbId: ownerTmb, name: 'D1' });
      const datasetId = String(dataset._id);
      await addDatasetClb({
        teamId,
        resourceId: datasetId,
        tmbId: ownerTmb,
        permission: OwnerRoleVal
      });

      const f1 = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId,
        type: DatasetCollectionTypeEnum.folder
      });
      const f2 = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId,
        type: DatasetCollectionTypeEnum.folder,
        parentId: String(f1._id),
        inheritPermission: false
      });
      const f3 = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId,
        type: DatasetCollectionTypeEnum.folder,
        parentId: String(f2._id)
      });

      // seed: F1 grants M1 read; F2 independent config grants M2 write; F3 snapshot = F2 snapshot
      await MongoResourcePermission.insertMany([
        {
          resourceType: PerResourceTypeEnum.collection,
          teamId,
          resourceId: String(f1._id),
          tmbId: ownerTmb,
          permission: OwnerRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.collection,
          teamId,
          resourceId: String(f1._id),
          tmbId: m1,
          permission: ReadRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.collection,
          teamId,
          resourceId: String(f2._id),
          tmbId: ownerTmb,
          permission: OwnerRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.collection,
          teamId,
          resourceId: String(f2._id),
          tmbId: m2,
          permission: WriteRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.collection,
          teamId,
          resourceId: String(f3._id),
          tmbId: ownerTmb,
          permission: OwnerRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.collection,
          teamId,
          resourceId: String(f3._id),
          tmbId: m2,
          permission: WriteRoleVal
        }
      ]);

      // change F1 collaborators: upgrade M1 read -> write.
      // Collection 协作者更新现走通用链路：先写 F1 自身 clbs，再 syncChildrenPermission 同步继承态子 folder。
      await MongoResourcePermission.updateOne(
        {
          resourceType: PerResourceTypeEnum.collection,
          teamId,
          resourceId: String(f1._id),
          tmbId: m1
        },
        { $set: { permission: WriteRoleVal } }
      );
      await mongoSessionRun(async (session) => {
        await syncChildrenPermission({
          resource: {
            _id: String(f1._id),
            type: DatasetCollectionTypeEnum.folder,
            teamId,
            parentId: null
          },
          folderTypeList: [DatasetCollectionTypeEnum.folder],
          resourceType: PerResourceTypeEnum.collection,
          resourceModel: MongoDatasetCollection,
          session,
          collaborators: [
            { tmbId: ownerTmb, permission: OwnerRoleVal },
            { tmbId: m1, permission: WriteRoleVal }
          ]
        });
      });

      // F1 own clbs upgraded to write
      const f1Map = await snapshotMap(teamId, String(f1._id));
      expect(f1Map.get(m1)).toBe(WriteRoleVal);

      // F2 (non-inherited) keeps its independent config: M2 write, no M1
      const f2Map = await snapshotMap(teamId, String(f2._id));
      expect(f2Map.get(m2)).toBe(WriteRoleVal);
      expect(f2Map.has(m1)).toBe(false);
      expect(f2Map.get(ownerTmb)).toBe(OwnerRoleVal);

      // F3 (inherited under the non-inherited F2): 通用同步切断于非继承态 F2，
      // F3 保持原有快照（= F2 snapshot），不受 F1 变更影响
      const f3Map = await snapshotMap(teamId, String(f3._id));
      expect(f3Map.get(m2)).toBe(WriteRoleVal);
      expect(f3Map.has(m1)).toBe(false);
      expect(f3Map.get(ownerTmb)).toBe(OwnerRoleVal);
    },
    TIMEOUT
  );
});

describe('scenario 5: resuming inheritance merges parent + own and syncs collection folders', () => {
  it(
    'F closed inheritance with a private collaborator; resume restores parent+own and syncs the collection folder under D',
    async () => {
      const users = await getFakeUsers(3);
      const teamId = users.owner.teamId;
      const ownerTmb = String(users.owner.tmbId);
      const fOwner = String(users.members[0].tmbId); // F owned by a different member
      const m1 = String(users.members[1].tmbId); // parent grants read to m1
      const m2 = String(users.members[2].tmbId); // F private collaborator (write)

      const parent = await createDataset({
        teamId,
        tmbId: ownerTmb,
        name: 'Parent',
        type: DatasetTypeEnum.folder
      });
      const f = await createDataset({
        teamId,
        tmbId: fOwner,
        name: 'F',
        type: DatasetTypeEnum.folder,
        parentId: String(parent._id),
        inheritPermission: false
      });
      const d1 = await createDataset({
        teamId,
        tmbId: ownerTmb,
        name: 'D1',
        parentId: String(f._id)
      });
      const cf1 = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId: String(d1._id),
        type: DatasetCollectionTypeEnum.folder
      });

      // Parent grants m1 read; F independent config grants private m2 write
      await MongoResourcePermission.insertMany([
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
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(f._id),
          tmbId: fOwner,
          permission: OwnerRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(f._id),
          tmbId: m2,
          permission: WriteRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(d1._id),
          tmbId: ownerTmb,
          permission: OwnerRoleVal
        },
        // collection folder CF1 snapshot seeded from F's independent config
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
          resourceId: String(cf1._id),
          tmbId: m2,
          permission: WriteRoleVal
        }
      ]);

      // pre-condition: while F is non-inherited, m1 cannot read F, private m2 can
      await expect(
        authDatasetByTmbId({ tmbId: m1, datasetId: String(f._id), per: ReadPermissionVal })
      ).rejects.toBe(DatasetErrEnum.unAuthDataset);
      await expect(
        authDatasetByTmbId({ tmbId: m2, datasetId: String(f._id), per: ReadPermissionVal })
      ).resolves.toBeDefined();

      // resume F inheritance (folder, with Collection Folder sync)
      await resumeInheritPermission({
        resource: f,
        folderTypeList: [DatasetTypeEnum.folder],
        resourceType: PerResourceTypeEnum.dataset,
        resourceModel: MongoDataset,
        syncCollectionFolders: true
      });

      // F merged parent (m1 read) + own (m2 write) + own owner
      const fDoc = await MongoDataset.findById(f._id).lean();
      expect(fDoc?.inheritPermission).toBe(true);
      await expect(
        authDatasetByTmbId({ tmbId: m1, datasetId: String(f._id), per: ReadPermissionVal })
      ).resolves.toBeDefined();
      await expect(
        authDatasetByTmbId({ tmbId: m2, datasetId: String(f._id), per: ReadPermissionVal })
      ).resolves.toBeDefined();

      // collection folder CF1 snapshot synced to the merged effective (m1 read + m2 write + owners)
      const cf1Map = await snapshotMap(teamId, String(cf1._id));
      expect(cf1Map.get(m1)).toBe(ReadRoleVal);
      expect(cf1Map.get(m2)).toBe(WriteRoleVal);
      expect(cf1Map.get(ownerTmb)).toBe(OwnerRoleVal); // CF1 owner kept
      // F's owner is capped to manage in the child folder snapshot (parent-owner cap)
      expect(cf1Map.get(fOwner)).toBe(ManageRoleVal);
    },
    TIMEOUT
  );
});
