import { describe, expect, it } from 'vitest';
import { Types } from '@fastgpt/service/common/mongo';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { DatasetErrEnum } from '@fastgpt/global/common/error/code/dataset';
import {
  ManageRoleVal,
  OwnerRoleVal,
  PerResourceTypeEnum,
  ReadPermissionVal,
  ReadRoleVal
} from '@fastgpt/global/support/permission/constant';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { authDatasetCollection } from '@fastgpt/service/support/permission/dataset/auth';
import {
  COLLECTION_PERMISSION_MIGRATION_VERSION,
  migrateCollectionPermissions
} from '@fastgpt/service/core/dataset/collection/migrateCollectionPermission';
import { getFakeUsers } from '@test/datas/users';
import { createDataset, snapshotMap } from './helpers';

/**
 * scenario 10 / TS-005: 升级存量权限+ 幂等重跑断言。
 *
 * D 下根 Folder F1、子 Folder F2、普通 C1：
 * - F1/F2/C1 均获得 `merge(父级有效 clbs, 自身 clbs)` 完整快照，且各自存在唯一 owner 记录；
 * - 迁移后成员按新权限可读（端到端鉴权）；
 * - 重跑幂等（migratedDatasets=0，权限记录数不变）。
 */
const TIMEOUT = 60_000;

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

describe('scenario 10 + TS-005: legacy permission migration and idempotent re-run', () => {
  it(
    'root folder / child folder get correct parent snapshots, C1 gets a unique owner only; re-run is idempotent; migrated read works',
    async () => {
      const users = await getFakeUsers(2);
      const teamId = users.owner.teamId;
      const ownerTmb = String(users.owner.tmbId);
      const m1 = String(users.members[0].tmbId);
      const m2 = String(users.members[1].tmbId);

      // D grants m1 read; F2 / C1 owned by m2 to exercise the parent-owner cap
      const dataset = await createDataset({ teamId, tmbId: ownerTmb, name: 'D' });
      const datasetId = String(dataset._id);
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: datasetId,
        tmbId: ownerTmb,
        permission: OwnerRoleVal
      });
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: datasetId,
        tmbId: m1,
        permission: ReadRoleVal
      });

      // legacy collections: no inheritPermission, no resource_permissions
      const F1 = await rawInsertCollection({
        teamId,
        datasetId,
        tmbId: ownerTmb,
        type: DatasetCollectionTypeEnum.folder,
        name: 'F1'
      });
      const F2 = await rawInsertCollection({
        teamId,
        datasetId,
        tmbId: m2,
        type: DatasetCollectionTypeEnum.folder,
        name: 'F2',
        parentId: F1
      });
      const C1 = await rawInsertCollection({
        teamId,
        datasetId,
        tmbId: m2,
        type: DatasetCollectionTypeEnum.file,
        name: 'C1'
      });

      // pre-migration: no collection permission records at all
      expect(
        await MongoResourcePermission.countDocuments({
          resourceType: PerResourceTypeEnum.collection,
          teamId
        })
      ).toBe(0);

      const first = await migrateCollectionPermissions({ datasetIds: [datasetId] });
      expect(first.migratedDatasets).toBe(1);
      expect(first.failed).toHaveLength(0);

      // F1 (root folder): Dataset effective clbs + own owner
      const f1Map = await snapshotMap(teamId, F1);
      expect(f1Map.get(ownerTmb)).toBe(OwnerRoleVal);
      expect(f1Map.get(m1)).toBe(ReadRoleVal);

      // F2 (child folder): parent snapshot with parent owner capped to manage + own owner
      const f2Map = await snapshotMap(teamId, F2);
      expect(f2Map.get(ownerTmb)).toBe(ManageRoleVal); // F1 owner capped
      expect(f2Map.get(m1)).toBe(ReadRoleVal);
      expect(f2Map.get(m2)).toBe(OwnerRoleVal); // F2 own owner

      // C1 (normal collection): full snapshot = merge(Dataset 有效 clbs, 自身 owner)
      // D 有效 = [owner:Owner, m1:Read]，C1 owner = m2 → [owner:Manage, m1:Read, m2:Owner]
      const c1Map = await snapshotMap(teamId, C1);
      expect(c1Map.size).toBe(3);
      expect(c1Map.get(ownerTmb)).toBe(ManageRoleVal);
      expect(c1Map.get(m1)).toBe(ReadRoleVal);
      expect(c1Map.get(m2)).toBe(OwnerRoleVal);

      // unique owner per collection (exactly one OwnerRoleVal record each)
      for (const [id, map] of [
        [F1, f1Map],
        [F2, f2Map],
        [C1, c1Map]
      ] as Array<[string, Map<string, number>]>) {
        const ownerRecords = Array.from(map.entries()).filter(([, per]) => per === OwnerRoleVal);
        expect(ownerRecords).toHaveLength(1);
        void id;
      }

      // all collections initialized to inheritPermission=true and version-marked
      const cols = await MongoDatasetCollection.find({ datasetId, teamId }).lean();
      expect(cols).toHaveLength(3);
      for (const c of cols) {
        expect(c.inheritPermission).toBe(true);
        expect(c.permissionMigrationVersion).toBe(COLLECTION_PERMISSION_MIGRATION_VERSION);
      }

      // end-to-end: m1 (dataset read via D) can read C1 after migration
      const auth = await authDatasetCollection({
        req: { auth: users.members[0] } as any,
        authToken: true,
        collectionId: C1,
        per: ReadPermissionVal
      });
      expect(String(auth.collection._id)).toBe(C1);

      // m2 (C1 owner) can read C1 even though it has no dataset read (owner bypass is at dataset level only)
      // -> verify the dataset gate still applies: m2 has no dataset read, so it must be rejected.
      await expect(
        authDatasetCollection({
          req: { auth: users.members[1] } as any,
          authToken: true,
          collectionId: C1,
          per: ReadPermissionVal
        })
      ).rejects.toBe(DatasetErrEnum.unAuthDataset);

      // TS-005: re-run is idempotent
      const before = await MongoResourcePermission.countDocuments({
        resourceType: PerResourceTypeEnum.collection,
        teamId
      });
      const second = await migrateCollectionPermissions({ datasetIds: [datasetId] });
      expect(second.migratedDatasets).toBe(0);
      expect(second.failed).toHaveLength(0);
      const after = await MongoResourcePermission.countDocuments({
        resourceType: PerResourceTypeEnum.collection,
        teamId
      });
      expect(after).toBe(before);
    },
    TIMEOUT
  );
});
