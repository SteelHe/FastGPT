import { describe, expect, it } from 'vitest';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { DatasetErrEnum } from '@fastgpt/global/common/error/code/dataset';
import {
  ManagePermissionVal,
  PerResourceTypeEnum,
  ReadPermissionVal,
  ReadRoleVal
} from '@fastgpt/global/support/permission/constant';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { authDatasetCollection } from '@fastgpt/service/support/permission/dataset/auth';
import { resolveReadableCollectionIds } from '@fastgpt/service/support/permission/collection/readableCollection';
import { getFakeUsers } from '@test/datas/users';
import { createCollection, createDataset } from './helpers';

/**
 * Error-1 端到端回归（真实 MongoDB，「列表可见但点进去无权限」一致性）：
 * - 团队 owner/admin 对「非继承态 collection」（他人创建的独立配置，自身无 clb 记录、
 *   且非该 collection 的 tmbId owner）应可通过 authDatasetCollection 的 read/manage 校验，
 *   与 listV2 的团队 owner 短路（列表全可见）保持一致。
 * - 团队 owner 的 Dataset read 门槛不能被绕过：本用例中 dataset 为成员所有，团队 owner
 *   经 `authDatasetByTmbId` 的 isOwner（团队 owner）通过门槛；普通成员无 dataset read 时
 *   仍整体拒绝（已有 scenario 8 覆盖）。
 * - 旁路不影响普通成员：无 collection 权限的普通成员即使 dataset read 通过仍被拒绝。
 */
const TIMEOUT = 60_000;

describe('Error-1: team owner/admin bypass on a non-inherited collection ', () => {
  it(
    'team owner can read & manage a member-created non-inherited collection, matching list visibility',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const memberTmb = String(users.members[0].tmbId);
      const ownerTmb = String(users.owner.tmbId);

      // member-created dataset + non-inherited independent collection (no owner clb for team owner)
      const dataset = await createDataset({ teamId, tmbId: memberTmb, name: 'D1' });
      const datasetId = String(dataset._id);
      const c1 = await createCollection({
        teamId,
        tmbId: memberTmb,
        datasetId,
        name: 'member-private',
        inheritPermission: false
      });
      const collectionId = String(c1._id);

      // no resource_permissions records at all: team owner must be granted by the bypass
      const clbs = await MongoResourcePermission.find({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: collectionId
      }).lean();
      expect(clbs).toHaveLength(0);

      // 1) list-visible consistency: the shared RAG/list resolver short-circuits team owner
      const readable = await resolveReadableCollectionIds({
        teamId,
        datasetIds: [datasetId],
        tmbId: ownerTmb
      });
      expect(readable).toContain(collectionId);

      // 2) single-resource auth: team owner passes read and manage (previously denied -> Error-1)
      const readResult = await authDatasetCollection({
        req: { auth: users.owner } as any,
        authToken: true,
        collectionId,
        per: ReadPermissionVal
      });
      expect(readResult.collection._id).toBe(collectionId);
      expect(readResult.permission.checkPer(ReadPermissionVal)).toBe(true);
      // team owner is NOT the collection owner, so no false owner flag
      expect(readResult.permission.isOwner).toBe(false);

      const manageResult = await authDatasetCollection({
        req: { auth: users.owner } as any,
        authToken: true,
        collectionId,
        per: ManagePermissionVal
      });
      expect(manageResult.permission.checkPer(ManagePermissionVal)).toBe(true);
    },
    TIMEOUT
  );

  it(
    'team manager (manage on team) with dataset read can manage a member-created non-inherited collection',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const memberTmb = String(users.members[0].tmbId);
      const managerTmb = String(users.manager.tmbId);

      const dataset = await createDataset({ teamId, tmbId: memberTmb, name: 'D1' });
      const datasetId = String(dataset._id);
      const c1 = await createCollection({
        teamId,
        tmbId: memberTmb,
        datasetId,
        name: 'member-private',
        inheritPermission: false
      });
      const collectionId = String(c1._id);

      // manager passes the Dataset read gate via a dataset clb record
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: datasetId,
        tmbId: managerTmb,
        permission: ReadRoleVal
      });

      const result = await authDatasetCollection({
        req: { auth: users.manager } as any,
        authToken: true,
        collectionId,
        per: ManagePermissionVal
      });
      expect(result.permission.checkPer(ManagePermissionVal)).toBe(true);
      expect(result.permission.isOwner).toBe(false);
    },
    TIMEOUT
  );

  it(
    'regular member without any collection permission is still denied (no bypass for non-admin)',
    async () => {
      const users = await getFakeUsers(2);
      const teamId = users.owner.teamId;
      const memberTmb = String(users.members[0].tmbId);
      const otherMemberTmb = String(users.members[1].tmbId);

      const dataset = await createDataset({ teamId, tmbId: memberTmb, name: 'D1' });
      const datasetId = String(dataset._id);
      const c1 = await createCollection({
        teamId,
        tmbId: memberTmb,
        datasetId,
        name: 'member-private',
        inheritPermission: false
      });
      const collectionId = String(c1._id);

      // otherMember has dataset read but no collection record -> collection-level check rejects
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: datasetId,
        tmbId: otherMemberTmb,
        permission: ReadRoleVal
      });

      await expect(
        authDatasetCollection({
          req: { auth: users.members[1] } as any,
          authToken: true,
          collectionId,
          per: ReadPermissionVal
        })
      ).rejects.toBe(DatasetErrEnum.unAuthDatasetCollection);
    },
    TIMEOUT
  );
});
