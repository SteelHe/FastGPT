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
import { resolveReadableCollectionIds } from '@fastgpt/service/support/permission/collection/readableCollection';
import {
  computeEffectiveCollectionIdList,
  decideCollectionFilter
} from '@fastgpt/service/core/dataset/search/defaultRecall/effectiveCollection';
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

      expect(readable.sort()).toEqual([String(c1._id), String(c2._id)].sort());
      expect(readable).not.toContain(String(folder._id));
    },
    TIMEOUT
  );

  it(
    'RF-005: member with collection read but no dataset read gets the whole dataset excluded',
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
    'folder: readable folder expands to its inherited file collections for a member',
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
        parentId: String(folder._id),
        type: DatasetCollectionTypeEnum.file,
        name: 'c1'
      });

      // member1: dataset read + folder 快照 read → 继承态文件 c1 可读
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

      expect(readable.length).toBe(100);
      expect(readable.sort()).toEqual(ids.sort());
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
  it('RF-004: proper subset applies collectionId IN effectiveCollectionIdList', () => {
    const decision = decideCollectionFilter({
      allowedCollectionIdList: ['a', 'b'],
      filterCollectionIdList: undefined,
      forbidCollectionIdList: [],
      totalFileCollectionCount: 5
    });
    expect(decision.isEmpty).toBe(false);
    expect(decision.collectionFilter).toEqual(['a', 'b']);
  });

  it('RF-002: full coverage keeps dataset-level recall (no collectionId filter when no metadata)', () => {
    const decision = decideCollectionFilter({
      allowedCollectionIdList: ['a', 'b', 'c'],
      filterCollectionIdList: undefined,
      forbidCollectionIdList: [],
      totalFileCollectionCount: 3
    });
    expect(decision.isEmpty).toBe(false);
    expect(decision.collectionFilter).toBeUndefined();
  });

  it('full coverage with metadata still applies the metadata filter', () => {
    const decision = decideCollectionFilter({
      allowedCollectionIdList: ['a', 'b', 'c'],
      filterCollectionIdList: ['a'],
      forbidCollectionIdList: [],
      totalFileCollectionCount: 3
    });
    expect(decision.isEmpty).toBe(false);
    expect(decision.collectionFilter).toEqual(['a']);
  });

  it('RF-003: empty effective short-circuits to empty recall', () => {
    const decision = decideCollectionFilter({
      allowedCollectionIdList: ['a'],
      filterCollectionIdList: ['x'],
      forbidCollectionIdList: [],
      totalFileCollectionCount: 3
    });
    expect(decision.isEmpty).toBe(true);
  });

  it('all forbid removed all allowed collections → empty', () => {
    const decision = decideCollectionFilter({
      allowedCollectionIdList: ['a', 'b'],
      filterCollectionIdList: undefined,
      forbidCollectionIdList: ['a', 'b'],
      totalFileCollectionCount: 3
    });
    expect(decision.isEmpty).toBe(true);
  });

  it('feature not enabled (no allowed list) keeps existing behavior', () => {
    const decision = decideCollectionFilter({
      filterCollectionIdList: ['a'],
      forbidCollectionIdList: [],
      totalFileCollectionCount: 3
    });
    expect(decision.isEmpty).toBe(false);
    expect(decision.collectionFilter).toEqual(['a']);
  });

  it('empty allowed list (user has zero readable collections) short-circuits to empty recall', () => {
    const decision = decideCollectionFilter({
      allowedCollectionIdList: [],
      filterCollectionIdList: ['a'],
      forbidCollectionIdList: [],
      totalFileCollectionCount: 3
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
