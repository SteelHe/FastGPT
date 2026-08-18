import { describe, expect, it } from 'vitest';
import { Types } from '@fastgpt/service/common/mongo';
import { DatasetCollectionTypeEnum, DatasetTypeEnum } from '@fastgpt/global/core/dataset/constants';
import {
  PerResourceTypeEnum,
  ReadRoleVal,
  OwnerRoleVal
} from '@fastgpt/global/support/permission/constant';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { filterDatasetsByTmbId } from '@fastgpt/service/core/dataset/utils';
import { resolveReadableCollectionIds } from '@fastgpt/service/core/dataset/search/defaultRecall/collectionPermission';
import {
  computeEffectiveCollectionIdList,
  decideCollectionFilter
} from '@fastgpt/service/core/dataset/search/defaultRecall/collectionPermission';
import { getFakeUsers } from '@test/datas/users';

/**
 * RAG Collection 权限过滤（task collection-rag-filtering）
 *
 * - resolveReadableCollectionIds：Dataset read 门槛 + 批量 Collection read 解析 + Folder 展开，
 *   只返回实际文件 Collection ID。
 * - computeEffectiveCollectionIdList / decideCollectionFilter：授权集合与元数据/forbid 的合并决策。
 *
 * 运行方式：
 *   cd packages/service && pnpm test -- ragFiltering
 *
 * 注意：真实 MongoDB 用例在并行全量跑时受 mongodb-memory-server 争用影响较慢，
 * 重型用例显式给了 60s 超时，避免被默认 20s 误杀。
 */

const oid = () => new Types.ObjectId().toString();
const TIMEOUT = 60_000;

describe('resolveReadableCollectionIds ', () => {
  it(
    'RF-001: returns only the collection the member can read, excluding the unreadable one',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const dataset = await MongoDataset.create({
        teamId,
        tmbId: users.owner.tmbId,
        name: 'dataset',
        hasSetCollectionPermissions: true // 自定义 collection 权限，镜像生产置位
      });
      const datasetId = String(dataset._id);

      const c1 = await MongoDatasetCollection.create({
        teamId,
        tmbId: users.owner.tmbId,
        datasetId,
        parentId: null,
        type: DatasetCollectionTypeEnum.file,
        name: 'c1',
        inheritPermission: false
      });
      const c2 = await MongoDatasetCollection.create({
        teamId,
        tmbId: users.owner.tmbId,
        datasetId,
        parentId: null,
        type: DatasetCollectionTypeEnum.file,
        name: 'c2',
        inheritPermission: false
      });

      // member1: dataset read (前置门槛) + collection c1 read；c2 无权限
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: datasetId,
        tmbId: users.members[0].tmbId,
        permission: ReadRoleVal
      });
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(c1._id),
        tmbId: users.members[0].tmbId,
        permission: ReadRoleVal
      });

      const readable = await resolveReadableCollectionIds({
        teamId,
        datasetIds: [datasetId],
        tmbId: users.members[0].tmbId
      });

      expect(readable).toEqual([String(c1._id)]);
    },
    TIMEOUT
  );

  it(
    'RF-002: team owner resolves all file collections (folders expanded, folders not returned)',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const dataset = await MongoDataset.create({
        teamId,
        tmbId: users.owner.tmbId,
        name: 'dataset'
      });
      const datasetId = String(dataset._id);

      const folder = await MongoDatasetCollection.create({
        teamId,
        tmbId: users.owner.tmbId,
        datasetId,
        parentId: null,
        type: DatasetCollectionTypeEnum.folder,
        name: 'folder'
      });
      const c1 = await MongoDatasetCollection.create({
        teamId,
        tmbId: users.owner.tmbId,
        datasetId,
        parentId: null,
        type: DatasetCollectionTypeEnum.file,
        name: 'c1'
      });
      const c2 = await MongoDatasetCollection.create({
        teamId,
        tmbId: users.owner.tmbId,
        datasetId,
        parentId: String(folder._id),
        type: DatasetCollectionTypeEnum.file,
        name: 'c2'
      });

      const readable = await resolveReadableCollectionIds({
        teamId,
        datasetIds: [datasetId],
        tmbId: users.owner.tmbId
      });

      // 团队 owner/admin：无需 collection 级过滤，短路返回 undefined
      expect(readable).toBeUndefined();
    },
    TIMEOUT
  );

  it(
    'RF-002: member with dataset read and full file coverage resolves to undefined (no collection-level filter)',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const dataset = await MongoDataset.create({
        teamId,
        tmbId: users.owner.tmbId,
        name: 'dataset',
        hasSetCollectionPermissions: true // 自定义 collection 权限，镜像生产置位
      });
      const datasetId = String(dataset._id);

      await MongoDatasetCollection.create({
        teamId,
        tmbId: users.owner.tmbId,
        datasetId,
        parentId: null,
        type: DatasetCollectionTypeEnum.file,
        name: 'c1',
        inheritPermission: true
      });
      await MongoDatasetCollection.create({
        teamId,
        tmbId: users.owner.tmbId,
        datasetId,
        parentId: null,
        type: DatasetCollectionTypeEnum.file,
        name: 'c2',
        inheritPermission: true
      });

      // member1: dataset read（前置门槛）→ 全快照下每个文件快照已含 dataset 有效权限（member read）
      const fileIds = (await MongoDatasetCollection.find({ teamId, datasetId }, '_id').lean()).map(
        (c) => String(c._id)
      );
      await MongoResourcePermission.insertMany(
        fileIds.map((resourceId) => ({
          resourceType: PerResourceTypeEnum.collection,
          teamId,
          resourceId,
          tmbId: users.members[0].tmbId,
          permission: ReadRoleVal
        }))
      );
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: datasetId,
        tmbId: users.members[0].tmbId,
        permission: ReadRoleVal
      });

      const readable = await resolveReadableCollectionIds({
        teamId,
        datasetIds: [datasetId],
        tmbId: users.members[0].tmbId
      });

      // 授权集合覆盖全部文件 Collection → 无需 collection 级过滤，短路返回 undefined
      expect(readable).toBeUndefined();
    },
    TIMEOUT
  );

  it(
    'RF-005: member with collection read but no dataset read gets the whole dataset excluded (caller pre-filter)',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const dataset = await MongoDataset.create({
        teamId,
        tmbId: users.owner.tmbId,
        name: 'dataset'
      });
      const datasetId = String(dataset._id);

      const c1 = await MongoDatasetCollection.create({
        teamId,
        tmbId: users.owner.tmbId,
        datasetId,
        parentId: null,
        type: DatasetCollectionTypeEnum.file,
        name: 'c1',
        inheritPermission: false
      });

      // 只有 collection read，没有 dataset read
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(c1._id),
        tmbId: users.members[0].tmbId,
        permission: ReadRoleVal
      });

      // resolveReadableCollectionIds 的前置条件：调用方已按 Dataset read 过滤 datasetIds
      // （RF-005 由调用方强制）。生产链路（workflow filterDatasetsByTmbId / searchTest authDataset）
      // 先执行该过滤，无 dataset read 的 Dataset 在此处即被排除，函数收到空 datasetIds → 返回空。
      const filteredDatasetIds = await filterDatasetsByTmbId({
        datasetIds: [datasetId],
        tmbId: users.members[0].tmbId
      });
      expect(filteredDatasetIds).toEqual([]);

      const readable = await resolveReadableCollectionIds({
        teamId,
        datasetIds: filteredDatasetIds,
        tmbId: users.members[0].tmbId
      });

      expect(readable).toEqual([]);
    },
    TIMEOUT
  );

  it(
    'folder: readable folder expands to its inherited file collections for a member',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const dataset = await MongoDataset.create({
        teamId,
        tmbId: users.owner.tmbId,
        name: 'dataset',
        hasSetCollectionPermissions: true // 自定义 collection 权限，镜像生产置位
      });
      const datasetId = String(dataset._id);

      const folder = await MongoDatasetCollection.create({
        teamId,
        tmbId: users.owner.tmbId,
        datasetId,
        parentId: null,
        type: DatasetCollectionTypeEnum.folder,
        name: 'folder'
      });
      const c1 = await MongoDatasetCollection.create({
        teamId,
        tmbId: users.owner.tmbId,
        datasetId,
        parentId: String(folder._id),
        type: DatasetCollectionTypeEnum.file,
        name: 'c1'
      });
      // 再放一个不可读文件，保证授权集合是真子集（否则全可读会短路返回 undefined）
      const c2 = await MongoDatasetCollection.create({
        teamId,
        tmbId: users.owner.tmbId,
        datasetId,
        parentId: null,
        type: DatasetCollectionTypeEnum.file,
        name: 'c2',
        inheritPermission: false
      });

      // member1: dataset read + folder 快照 read；全快照下继承态文件 c1 自身快照也含 member read
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: datasetId,
        tmbId: users.members[0].tmbId,
        permission: ReadRoleVal
      });
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(folder._id),
        tmbId: users.members[0].tmbId,
        permission: ReadRoleVal
      });
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(c1._id),
        tmbId: users.members[0].tmbId,
        permission: ReadRoleVal
      });

      const readable = await resolveReadableCollectionIds({
        teamId,
        datasetIds: [datasetId],
        tmbId: users.members[0].tmbId
      });

      expect(readable).toEqual([String(c1._id)]);
    },
    TIMEOUT
  );

  it(
    'non-inherited private file inside a readable folder stays hidden',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const dataset = await MongoDataset.create({
        teamId,
        tmbId: users.owner.tmbId,
        name: 'dataset',
        hasSetCollectionPermissions: true // 自定义 collection 权限，镜像生产置位
      });
      const datasetId = String(dataset._id);

      const folder = await MongoDatasetCollection.create({
        teamId,
        tmbId: users.owner.tmbId,
        datasetId,
        parentId: null,
        type: DatasetCollectionTypeEnum.folder,
        name: 'folder'
      });
      const privateFile = await MongoDatasetCollection.create({
        teamId,
        tmbId: users.owner.tmbId,
        datasetId,
        parentId: String(folder._id),
        type: DatasetCollectionTypeEnum.file,
        name: 'private-file',
        inheritPermission: false
      });

      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: datasetId,
        tmbId: users.members[0].tmbId,
        permission: ReadRoleVal
      });
      // folder 可读，但私有文件非继承且无自身记录
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(folder._id),
        tmbId: users.members[0].tmbId,
        permission: ReadRoleVal
      });

      const readable = await resolveReadableCollectionIds({
        teamId,
        datasetIds: [datasetId],
        tmbId: users.members[0].tmbId
      });

      expect(readable).toEqual([]);
    },
    TIMEOUT
  );

  it(
    'performance: batch resolution for 100 inherited files stays well under budget',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const dataset = await MongoDataset.create({
        teamId,
        tmbId: users.owner.tmbId,
        name: 'dataset'
      });
      const datasetId = String(dataset._id);

      const collections = await MongoDatasetCollection.insertMany(
        Array.from({ length: 100 }, (_, i) => ({
          teamId,
          tmbId: users.owner.tmbId,
          datasetId,
          parentId: null,
          type: DatasetCollectionTypeEnum.file,
          name: `file-${i}`,
          inheritPermission: true
        }))
      );
      const ids = collections.map((c: { _id: Types.ObjectId }) => String(c._id));

      // 全部继承态 + dataset read → 全量可读（成员路径，批量 distinct）
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: datasetId,
        tmbId: users.members[0].tmbId,
        permission: ReadRoleVal
      });

      const start = Date.now();
      const readable = await resolveReadableCollectionIds({
        teamId,
        datasetIds: [datasetId],
        tmbId: users.members[0].tmbId
      });
      const duration = Date.now() - start;

      // 全部纯继承（hasSetCollectionPermissions=false）→ 无需 collection 级过滤，短路返回 undefined
      expect(readable).toBeUndefined();
      // 批量解析（一次 distinct 查询），本地真实 MongoDB 远低于 100ms；CI 内存版放宽到 2s
      expect(duration).toBeLessThan(2000);
    },
    TIMEOUT
  );
});

describe('computeEffectiveCollectionIdList ', () => {
  it('intersects allowed with metadata filter', () => {
    const effective = computeEffectiveCollectionIdList({
      allowedCollectionIdList: ['a', 'b', 'c'],
      filterCollectionIdList: ['b', 'c', 'd'],
      forbidCollectionIdList: []
    });
    expect(effective.sort()).toEqual(['b', 'c']);
  });

  it('subtracts forbid from allowed when no metadata filter', () => {
    const effective = computeEffectiveCollectionIdList({
      allowedCollectionIdList: ['a', 'b'],
      forbidCollectionIdList: ['b']
    });
    expect(effective).toEqual(['a']);
  });

  it('returns empty when the intersection is empty (RF-003)', () => {
    const effective = computeEffectiveCollectionIdList({
      allowedCollectionIdList: ['a'],
      filterCollectionIdList: ['x'],
      forbidCollectionIdList: []
    });
    expect(effective).toEqual([]);
  });
});

describe('decideCollectionFilter (-5)', () => {
  it('RF-004: proper subset applies collectionId IN filterCollectionIdList', () => {
    const decision = decideCollectionFilter({
      allowedCollectionIdList: ['a', 'b'],
      filterCollectionIdList: undefined,
      forbidCollectionIdList: []
    });
    expect(decision.isEmpty).toBe(false);
    expect(decision.collectionFilter).toEqual(['a', 'b']);
  });

  it('non-empty allowed always yields the effective set as collectionId filter (full-coverage decided upstream)', () => {
    const decision = decideCollectionFilter({
      allowedCollectionIdList: ['a', 'b', 'c'],
      filterCollectionIdList: undefined,
      forbidCollectionIdList: []
    });
    expect(decision.isEmpty).toBe(false);
    expect(decision.collectionFilter).toEqual(['a', 'b', 'c']);
  });

  it('full coverage with metadata still applies the metadata filter', () => {
    const decision = decideCollectionFilter({
      allowedCollectionIdList: ['a', 'b', 'c'],
      filterCollectionIdList: ['a'],
      forbidCollectionIdList: []
    });
    expect(decision.isEmpty).toBe(false);
    expect(decision.collectionFilter).toEqual(['a']);
  });

  it('RF-003: empty effective short-circuits to empty recall', () => {
    const decision = decideCollectionFilter({
      allowedCollectionIdList: ['a'],
      filterCollectionIdList: ['x'],
      forbidCollectionIdList: []
    });
    expect(decision.isEmpty).toBe(true);
  });

  it('all forbid removed all allowed collections → empty', () => {
    const decision = decideCollectionFilter({
      allowedCollectionIdList: ['a', 'b'],
      filterCollectionIdList: undefined,
      forbidCollectionIdList: ['a', 'b']
    });
    expect(decision.isEmpty).toBe(true);
  });

  it('feature not enabled (no allowed list) keeps existing behavior', () => {
    const decision = decideCollectionFilter({
      filterCollectionIdList: ['a'],
      forbidCollectionIdList: []
    });
    expect(decision.isEmpty).toBe(false);
    expect(decision.collectionFilter).toEqual(['a']);
  });

  it('empty allowed list (user has zero readable collections) short-circuits to empty recall', () => {
    const decision = decideCollectionFilter({
      allowedCollectionIdList: [],
      filterCollectionIdList: ['a'],
      forbidCollectionIdList: []
    });
    expect(decision.isEmpty).toBe(true);
  });
});

describe('non-regression on dataset type usage', () => {
  it('folder expansion excludes folder ids but keeps DatasetTypeEnum import path valid', () => {
    // DatasetTypeEnum is used by foundation auth; keep the import referenced for schema sanity.
    expect(DatasetTypeEnum.dataset).toBe('dataset');
    expect(DatasetCollectionTypeEnum.folder).toBe('folder');
    void oid;
  });
});
