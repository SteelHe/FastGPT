import { describe, expect, it } from 'vitest';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import {
  OwnerRoleVal,
  PerResourceTypeEnum,
  ReadRoleVal
} from '@fastgpt/global/support/permission/constant';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { resolveReadableCollectionIds } from '@fastgpt/service/support/permission/collection/readableCollection';
import {
  computeEffectiveCollectionIdList,
  decideCollectionFilter
} from '@fastgpt/service/core/dataset/search/defaultRecall/effectiveCollection';
import { getFakeUsers } from '@test/datas/users';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { createCollection, createDataset, addDatasetClb } from './helpers';

/**
 * scenario 11: RAG 文件级过滤（链路）.
 *
 * D 下有 C1（可读）/ C2（不可读）以及一个可读 Folder（其下继承文件可读）：
 * - 授权集合 = 实际文件 ID（Folder 展开）；不可读 C2 不在其中；
 * - effective = allowed ∩ 元数据 - forbid；
 * - decideCollectionFilter 仅在真子集时设置 collectionId IN，C2 不会被召回。
 */
const TIMEOUT = 60_000;

describe('scenario 11: RAG recall only includes readable collections', () => {
  it(
    'authorized file set = {C1, folderFile}, unreadable C2 is filtered out at the recall boundary',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const ownerTmb = String(users.owner.tmbId);
      const m1 = String(users.members[0].tmbId);

      const dataset = await createDataset({ teamId, tmbId: ownerTmb, name: 'D' });
      const datasetId = String(dataset._id);

      const c1 = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId,
        name: 'c1',
        inheritPermission: false
      });
      const c2 = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId,
        name: 'c2',
        inheritPermission: false
      });
      const folder = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId,
        type: DatasetCollectionTypeEnum.folder,
        name: 'folder'
      });
      const folderFile = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId,
        parentId: String(folder._id),
        name: 'folder-file',
        inheritPermission: true
      });

      // m1: dataset read (前置门槛) + collection read on c1 + folder snapshot read (inherits folderFile)
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: datasetId,
        tmbId: m1,
        permission: ReadRoleVal
      });
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(c1._id),
        tmbId: m1,
        permission: ReadRoleVal
      });
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(folder._id),
        tmbId: m1,
        permission: ReadRoleVal
      });

      const allowed = await resolveReadableCollectionIds({
        teamId,
        datasetIds: [datasetId],
        tmbId: m1
      });

      // actual file IDs only (folder expanded to its inherited file), c2 excluded
      expect(allowed.sort()).toEqual([String(c1._id), String(folderFile._id)].sort());
      expect(allowed).not.toContain(String(c2._id));
      expect(allowed).not.toContain(String(folder._id));

      // merge with metadata filter / forbid (pure chain): no metadata -> allowed unchanged
      const effective = computeEffectiveCollectionIdList({
        allowedCollectionIdList: allowed,
        forbidCollectionIdList: []
      });
      expect(effective.sort()).toEqual(allowed.sort());

      // decideCollectionFilter: allowed is a proper subset of all file collections (3) -> IN filter set
      const decision = decideCollectionFilter({
        allowedCollectionIdList: allowed,
        filterCollectionIdList: undefined,
        forbidCollectionIdList: [],
        totalFileCollectionCount: 3
      });
      expect(decision.isEmpty).toBe(false);
      expect(decision.collectionFilter?.sort()).toEqual(
        [String(c1._id), String(folderFile._id)].sort()
      );
      // c2 is never part of the recall filter
      expect(decision.collectionFilter).not.toContain(String(c2._id));

      // empty intersection with a metadata filter short-circuits to empty recall (safety)
      const emptyDecision = decideCollectionFilter({
        allowedCollectionIdList: allowed,
        filterCollectionIdList: [String(c2._id)],
        forbidCollectionIdList: [],
        totalFileCollectionCount: 3
      });
      expect(emptyDecision.isEmpty).toBe(true);
    },
    TIMEOUT
  );

  it(
    ' hasSetCollectionPermissions=false short-circuits to all file collections for a member with dataset read',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const ownerTmb = String(users.owner.tmbId);
      const m1 = String(users.members[0].tmbId);

      // 纯继承 Dataset：无任何 collection 自定义权限，显式保持 flag=false
      const dataset = await createDataset({ teamId, tmbId: ownerTmb, name: 'D-flag' });
      const datasetId = String(dataset._id);
      await MongoDataset.updateOne(
        { _id: datasetId },
        { $set: { hasSetCollectionPermissions: false } }
      );

      const c1 = await createCollection({ teamId, tmbId: ownerTmb, datasetId, name: 'c1' });
      const c2 = await createCollection({ teamId, tmbId: ownerTmb, datasetId, name: 'c2' });
      const folder = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId,
        type: DatasetCollectionTypeEnum.folder,
        name: 'folder'
      });
      const folderFile = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId,
        parentId: String(folder._id),
        name: 'folder-file'
      });

      // m1: dataset read（前置门槛）
      await addDatasetClb({ teamId, resourceId: datasetId, tmbId: m1, permission: ReadRoleVal });

      // 短路：无任何 collection 自定义权限 → 全部文件 collection 可读（folder 展开为文件），无需逐 collection 权限记录
      const allowed = await resolveReadableCollectionIds({
        teamId,
        datasetIds: [datasetId],
        tmbId: m1
      });
      expect(allowed.sort()).toEqual(
        [String(c1._id), String(c2._id), String(folderFile._id)].sort()
      );
    },
    TIMEOUT
  );
});
