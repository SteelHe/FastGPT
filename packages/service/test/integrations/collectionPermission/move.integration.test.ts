import { describe, expect, it } from 'vitest';
import { mongoSessionRun } from '@fastgpt/service/common/mongo/sessionRun';
import { DatasetCollectionTypeEnum, DatasetTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { DatasetErrEnum } from '@fastgpt/global/common/error/code/dataset';
import {
  OwnerRoleVal,
  PerResourceTypeEnum,
  ReadPermissionVal,
  ReadRoleVal,
  WriteRoleVal
} from '@fastgpt/global/support/permission/constant';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { getResourceOwnedClbs } from '@fastgpt/service/support/permission/controller';
import { authDatasetByTmbId } from '@fastgpt/service/support/permission/dataset/auth';
import { syncDatasetCollectionFolders } from '@fastgpt/service/support/permission/collection/folderSync';
import {
  syncChildrenPermission,
  syncCollaborators
} from '@fastgpt/service/support/permission/inheritPermission';
import { getFakeUsers } from '@test/datas/users';
import { createCollection, createDataset, snapshotMap } from './helpers';

/**
 * 集成场景（跨能力链路，真实 MongoDB）：
 * - 场景 3：Move dataset（A 有 M1，B 有 M2，D 从 A 移到 B）→ M1 不可读 D，M2 可读 D
 * - 场景 4：Move folder（F 下 SF、D，F 从 A 移到 B）→ SF 快照同步为 B；D 动态合并新父权限
 *
 * 移动流程对齐 projects/app/src/pages/api/core/dataset/update.ts
 * syncCollaborators(merge 目标父) -> syncChildrenPermission -> syncDatasetCollectionFolders。
 */
const TIMEOUT = 60_000;

describe('scenario 3: move a dataset to a folder with a different collaborator', () => {
  it(
    'D under A (M1 read) moved to B (M2 read): M1 loses read, M2 gains read, CF1 snapshot reseeded',
    async () => {
      const users = await getFakeUsers(2);
      const teamId = users.owner.teamId;
      const ownerTmb = String(users.owner.tmbId);
      const m1 = String(users.members[0].tmbId);
      const m2 = String(users.members[1].tmbId);

      const a = await createDataset({
        teamId,
        tmbId: ownerTmb,
        name: 'A',
        type: DatasetTypeEnum.folder
      });
      const b = await createDataset({
        teamId,
        tmbId: ownerTmb,
        name: 'B',
        type: DatasetTypeEnum.folder
      });
      const d = await createDataset({
        teamId,
        tmbId: ownerTmb,
        name: 'D',
        parentId: String(a._id)
      });
      const cf1 = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId: String(d._id),
        type: DatasetCollectionTypeEnum.folder
      });

      await MongoResourcePermission.insertMany([
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(a._id),
          tmbId: ownerTmb,
          permission: OwnerRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(a._id),
          tmbId: m1,
          permission: ReadRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(b._id),
          tmbId: ownerTmb,
          permission: OwnerRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(b._id),
          tmbId: m2,
          permission: ReadRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(d._id),
          tmbId: ownerTmb,
          permission: OwnerRoleVal
        },
        // CF1 snapshot seeded from A chain (m1 read)
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
          tmbId: m1,
          permission: ReadRoleVal
        }
      ]);

      // pre-condition: M1 reads D (via A), M2 cannot
      await expect(
        authDatasetByTmbId({ tmbId: m1, datasetId: String(d._id), per: ReadPermissionVal })
      ).resolves.toBeDefined();
      await expect(
        authDatasetByTmbId({ tmbId: m2, datasetId: String(d._id), per: ReadPermissionVal })
      ).rejects.toBe(DatasetErrEnum.unAuthDataset);

      // move D to B (inheritPermission=true)
      await mongoSessionRun(async (session) => {
        await MongoDataset.updateOne(
          { _id: d._id },
          { parentId: String(b._id), inheritPermission: true },
          { session }
        );
        const parentClbs = await getResourceOwnedClbs({
          teamId,
          resourceId: String(b._id),
          resourceType: PerResourceTypeEnum.dataset,
          session
        });
        await syncCollaborators({
          teamId,
          resourceId: String(d._id),
          resourceType: PerResourceTypeEnum.dataset,
          collaborators: parentClbs,
          session
        });
        await syncChildrenPermission({
          resource: d,
          resourceModel: MongoDataset,
          folderTypeList: [DatasetTypeEnum.folder],
          resourceType: PerResourceTypeEnum.dataset,
          session,
          collaborators: parentClbs
        });
        const rootClbs = await getResourceOwnedClbs({
          teamId,
          resourceId: String(d._id),
          resourceType: PerResourceTypeEnum.dataset,
          session
        });
        await syncDatasetCollectionFolders({ teamId, datasetId: String(d._id), rootClbs, session });
      });

      const dDoc = await MongoDataset.findById(d._id).lean();
      expect(String(dDoc?.parentId)).toBe(String(b._id));
      expect(dDoc?.inheritPermission).toBe(true);

      // M1 no longer reads D; M2 reads D (dynamic merge of new parent B)
      await expect(
        authDatasetByTmbId({ tmbId: m1, datasetId: String(d._id), per: ReadPermissionVal })
      ).rejects.toBe(DatasetErrEnum.unAuthDataset);
      await expect(
        authDatasetByTmbId({ tmbId: m2, datasetId: String(d._id), per: ReadPermissionVal })
      ).resolves.toBeDefined();

      // CF1 snapshot reseeded via syncCollaborators（并入不删除）：新增 m2 read，旧 m1 read 保留
      const cf1Map = await snapshotMap(teamId, String(cf1._id));
      expect(cf1Map.get(m2)).toBe(ReadRoleVal);
      expect(cf1Map.get(m1)).toBe(ReadRoleVal);
      expect(cf1Map.get(ownerTmb)).toBe(OwnerRoleVal);
    },
    TIMEOUT
  );
});

describe('scenario 4: move a folder with a sub-folder and a dataset', () => {
  it(
    'F under A moved to B: SF snapshot re-synced to B clbs, D dynamically merges the new parent permission',
    async () => {
      const users = await getFakeUsers(2);
      const teamId = users.owner.teamId;
      const ownerTmb = String(users.owner.tmbId);
      const m1 = String(users.members[0].tmbId);
      const m2 = String(users.members[1].tmbId);

      const a = await createDataset({
        teamId,
        tmbId: ownerTmb,
        name: 'A',
        type: DatasetTypeEnum.folder
      });
      const b = await createDataset({
        teamId,
        tmbId: ownerTmb,
        name: 'B',
        type: DatasetTypeEnum.folder
      });
      const f = await createDataset({
        teamId,
        tmbId: ownerTmb,
        name: 'F',
        type: DatasetTypeEnum.folder,
        parentId: String(a._id)
      });
      const sf = await createDataset({
        teamId,
        tmbId: ownerTmb,
        name: 'SF',
        type: DatasetTypeEnum.folder,
        parentId: String(f._id)
      });
      const d = await createDataset({
        teamId,
        tmbId: ownerTmb,
        name: 'D',
        parentId: String(f._id)
      });
      const cf1 = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId: String(d._id),
        type: DatasetCollectionTypeEnum.folder
      });

      // A chain granted m1 read, propagated to F / SF (folder snapshots) and CF1 (collection folder)
      await MongoResourcePermission.insertMany([
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(a._id),
          tmbId: ownerTmb,
          permission: OwnerRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(a._id),
          tmbId: m1,
          permission: ReadRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(b._id),
          tmbId: ownerTmb,
          permission: OwnerRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(b._id),
          tmbId: m2,
          permission: ReadRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(f._id),
          tmbId: ownerTmb,
          permission: OwnerRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(f._id),
          tmbId: m1,
          permission: ReadRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(sf._id),
          tmbId: ownerTmb,
          permission: OwnerRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(sf._id),
          tmbId: m1,
          permission: ReadRoleVal
        },
        {
          resourceType: PerResourceTypeEnum.dataset,
          teamId,
          resourceId: String(d._id),
          tmbId: ownerTmb,
          permission: OwnerRoleVal
        },
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
          tmbId: m1,
          permission: ReadRoleVal
        }
      ]);

      // pre-condition: m1 reads D (via A->F), m2 cannot
      await expect(
        authDatasetByTmbId({ tmbId: m1, datasetId: String(d._id), per: ReadPermissionVal })
      ).resolves.toBeDefined();
      await expect(
        authDatasetByTmbId({ tmbId: m2, datasetId: String(d._id), per: ReadPermissionVal })
      ).rejects.toBe(DatasetErrEnum.unAuthDataset);

      // move F to B (inheritPermission=true)
      await mongoSessionRun(async (session) => {
        await MongoDataset.updateOne(
          { _id: f._id },
          { parentId: String(b._id), inheritPermission: true },
          { session }
        );
        const parentClbs = await getResourceOwnedClbs({
          teamId,
          resourceId: String(b._id),
          resourceType: PerResourceTypeEnum.dataset,
          session
        });
        await syncCollaborators({
          teamId,
          resourceId: String(f._id),
          resourceType: PerResourceTypeEnum.dataset,
          collaborators: parentClbs,
          session
        });
        await syncChildrenPermission({
          resource: f,
          resourceModel: MongoDataset,
          folderTypeList: [DatasetTypeEnum.folder],
          resourceType: PerResourceTypeEnum.dataset,
          session,
          collaborators: parentClbs
        });
        const rootClbs = await getResourceOwnedClbs({
          teamId,
          resourceId: String(f._id),
          resourceType: PerResourceTypeEnum.dataset,
          session
        });
        await syncDatasetCollectionFolders({ teamId, datasetId: String(f._id), rootClbs, session });
      });

      // SF (child dataset folder) snapshot re-synced to B's clbs: m2 read present, m1 removed
      const sfClbs = await MongoResourcePermission.find({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: String(sf._id)
      }).lean();
      const sfMap = new Map(
        sfClbs.map((c) => [String(c.tmbId ?? c.groupId ?? c.orgId), c.permission])
      );
      expect(sfMap.get(m2)).toBe(ReadRoleVal);
      expect(sfMap.has(m1)).toBe(false);
      expect(sfMap.get(ownerTmb)).toBe(OwnerRoleVal);

      // D (dataset under the moved folder) dynamically merges the new parent permission
      await expect(
        authDatasetByTmbId({ tmbId: m2, datasetId: String(d._id), per: ReadPermissionVal })
      ).resolves.toBeDefined();

      // CF1 collection folder snapshot reseeded from D's effective (contains m2 read)
      const cf1Map = await snapshotMap(teamId, String(cf1._id));
      expect(cf1Map.get(m2)).toBe(ReadRoleVal);
    },
    TIMEOUT
  );
});
