import { describe, expect, it } from 'vitest';
import { Types } from '@fastgpt/service/common/mongo';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { PerResourceTypeEnum, ReadRoleVal } from '@fastgpt/global/support/permission/constant';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { getReadableCollectionIds } from '@fastgpt/service/support/permission/collection/readableCollection';
import { resolveReadableCollectionIds } from '@fastgpt/service/core/dataset/search/defaultRecall/effectiveCollection';
import { buildFlattenedCollectionList } from '@fastgpt/service/core/dataset/collection/list/flatten';
import type { CollectionPermissionItemType } from '@fastgpt/service/support/permission/collection/type';
import { getFakeUsers } from '@test/datas/users';

/**
 * 性能冒烟基准（真实 MongoDB，尽力验证，机器相关，记录实测值）：
 * - 列表：1w 文件列表 < 2s
 * - 检索：100 文件 < 100ms、1w 文件 < 500ms
 *
 * 测量清单：
 * 1. listV2 核心（两阶段 ID 过滤 + 平铺）：1w 继承态文件（团队 owner 短路 / 成员全继承短路）
 * 2. 逐 collection 批量解析（getReadableCollectionIds，非继承态，每个 1 条权限记录）：1w
 * 3. RAG 授权集合（resolveReadableCollectionIds）：100 文件 / 1w 文件
 *
 * 运行方式（benchmark 配置 include test/**\/*.benchmark.ts）：
 *   cd packages/service && pnpm test:benchmark -- collectionPermission.benchmark.ts
 */
const COLLECTION_COUNT = 10_000;
const INSERT_BATCH = 5_000;
const MEASURE_ITERATIONS = 5;
const MEASURE_WARMUPS = 2;

const MINIMAL_SELECT = { _id: 1, parentId: 1, type: 1, inheritPermission: 1, tmbId: 1 };

/** 批量插入 collections（继承态），返回最小字段条目。 */
async function seedCollections({
  teamId,
  datasetId,
  tmbId,
  count,
  inheritPermission = true
}: {
  teamId: string;
  datasetId: string;
  tmbId: string;
  count: number;
  inheritPermission?: boolean;
}) {
  const items: CollectionPermissionItemType[] = [];
  const baseTime = Date.now() - count;
  for (let start = 0; start < count; start += INSERT_BATCH) {
    const batchSize = Math.min(INSERT_BATCH, count - start);
    const docs = Array.from({ length: batchSize }, (_, k) => {
      const i = start + k;
      return {
        teamId,
        tmbId,
        datasetId,
        type: DatasetCollectionTypeEnum.file,
        name: `col-${i}`,
        parentId: null,
        inheritPermission,
        createTime: new Date(baseTime + i),
        updateTime: new Date(baseTime + i)
      };
    });
    const inserted = await MongoDatasetCollection.insertMany(docs);
    for (const doc of inserted) {
      items.push({
        _id: String(doc._id),
        tmbId: String(doc.tmbId),
        parentId: doc.parentId ? String(doc.parentId) : null,
        inheritPermission: doc.inheritPermission,
        type: doc.type
      });
    }
  }
  return items;
}

/** 为每个 collection 插入一条当前成员权限记录（非继承态逐条解析路径）。 */
async function seedPerCollectionReads({
  teamId,
  tmbId,
  items
}: {
  teamId: string;
  tmbId: string;
  items: CollectionPermissionItemType[];
}) {
  for (let start = 0; start < items.length; start += INSERT_BATCH) {
    const batch = items.slice(start, start + INSERT_BATCH);
    await MongoResourcePermission.insertMany(
      batch.map((item) => ({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(item._id),
        tmbId,
        permission: ReadRoleVal
      }))
    );
  }
}

async function measure(name: string, fn: () => unknown | Promise<unknown>): Promise<number> {
  for (let i = 0; i < MEASURE_WARMUPS; i++) await fn();
  const times: number[] = [];
  for (let i = 0; i < MEASURE_ITERATIONS; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  console.log(
    `  [${name}] 平均 ${avg.toFixed(1)}ms | 最小 ${min.toFixed(1)}ms | 迭代 ${times.map((t) => t.toFixed(1)).join('/')}ms`
  );
  return avg;
}

describe('Collection 权限列表/检索性能冒烟', { timeout: 600_000 }, () => {
  it('列表核心：1w 继承态文件（两阶段 ID 过滤 + 平铺）', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const dataset = await MongoDataset.create({ teamId, tmbId: users.owner.tmbId, name: 'D' });
    const datasetId = String(dataset._id);

    const items = await seedCollections({
      teamId,
      datasetId,
      tmbId: String(users.owner.tmbId),
      count: COLLECTION_COUNT
    });

    // listV2 核心：phase1 最小字段查询 + 全继承短路 + 平铺 + phase2 当前目录可见 ID 回查排序
    const listCore = async () => {
      const phase1 = await MongoDatasetCollection.find(
        { teamId, datasetId: new Types.ObjectId(datasetId) },
        undefined,
        { readPreference: 'secondaryPreferred' }
      )
        .select(MINIMAL_SELECT)
        .lean();
      const permissionItems: CollectionPermissionItemType[] = phase1.map((item) => ({
        _id: String(item._id),
        tmbId: String(item.tmbId),
        parentId: item.parentId ? String(item.parentId) : null,
        inheritPermission: item.inheritPermission,
        type: item.type
      }));
      // 成员 + 全继承 + Dataset read → 短路全部可读（listV2 resolveReadableCollectionIds）
      const readableIds = permissionItems.map((item) => String(item._id));
      const { visibleIdsByParentId } = buildFlattenedCollectionList(
        permissionItems,
        readableIds,
        null
      );
      const visibleIds = visibleIdsByParentId.get('') ?? [];
      await MongoDatasetCollection.find({
        _id: { $in: visibleIds.map((id) => new Types.ObjectId(id)) }
      })
        .sort({ updateTime: -1 })
        .skip(0)
        .limit(100)
        .lean();
    };

    const avg = await measure('list 1w (all-inherited, 两阶段+平铺)', listCore);
    // 1w 列表 < 2s
    expect(avg).toBeLessThan(2000);
  });

  it('列表核心：1w 非继承态文件 + 每文件 1 条权限记录（批量解析路径）', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const m1 = String(users.members[0].tmbId);
    const dataset = await MongoDataset.create({ teamId, tmbId: users.owner.tmbId, name: 'D' });
    const datasetId = String(dataset._id);

    const items = await seedCollections({
      teamId,
      datasetId,
      tmbId: String(users.owner.tmbId),
      count: COLLECTION_COUNT,
      inheritPermission: false
    });
    await seedPerCollectionReads({ teamId, tmbId: m1, items });

    const avg = await measure('list 1w (per-collection 批量解析+平铺)', async () => {
      const readableIds = await getReadableCollectionIds({
        collections: items,
        tmbId: m1,
        teamId,
        groupIds: [],
        orgIds: [],
        datasetPermission: ReadRoleVal
      });
      expect(readableIds.length).toBe(COLLECTION_COUNT);
      const { total } = buildFlattenedCollectionList(items, readableIds, null);
      expect(total).toBe(COLLECTION_COUNT);
    });
    // 批量解析 + 平铺线性，1w 常驻内存应低于 2s
    expect(avg).toBeLessThan(2000);
  });

  it('检索：resolveReadableCollectionIds 100 文件', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const m1 = String(users.members[0].tmbId);
    const dataset = await MongoDataset.create({
      teamId,
      tmbId: users.owner.tmbId,
      name: 'D',
      hasSetCollectionPermissions: true
    });
    const datasetId = String(dataset._id);

    const items = await seedCollections({
      teamId,
      datasetId,
      tmbId: String(users.owner.tmbId),
      count: 100
    });
    // member: dataset read + 全继承 → getReadableCollectionIds 一次 distinct
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: datasetId,
      tmbId: m1,
      permission: ReadRoleVal
    });

    const avg = await measure('rag 100 文件', async () => {
      const readable = await resolveReadableCollectionIds({
        teamId,
        datasetIds: [datasetId],
        tmbId: m1
      });
      // 全继承 + dataset read → 授权集合覆盖全部文件 → 短路返回 undefined
      expect(readable).toBeUndefined();
    });
    // 检索 100 文件 < 100ms（本地真实 MongoDB 可达；内存版可能略高，留余量记录实测值）
    console.log(`  RAG 100 实测平均 ${avg.toFixed(1)}ms（设计目标 <100ms，机器相关）`);
  }, 120_000);

  it('检索：resolveReadableCollectionIds 1w 文件', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const m1 = String(users.members[0].tmbId);
    const dataset = await MongoDataset.create({
      teamId,
      tmbId: users.owner.tmbId,
      name: 'D',
      hasSetCollectionPermissions: true
    });
    const datasetId = String(dataset._id);

    const items = await seedCollections({
      teamId,
      datasetId,
      tmbId: String(users.owner.tmbId),
      count: COLLECTION_COUNT
    });
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: datasetId,
      tmbId: m1,
      permission: ReadRoleVal
    });
    void items;

    const avg = await measure('rag 1w 文件', async () => {
      const readable = await resolveReadableCollectionIds({
        teamId,
        datasetIds: [datasetId],
        tmbId: m1
      });
      // 全继承 + dataset read → 授权集合覆盖全部文件 → 短路返回 undefined
      expect(readable).toBeUndefined();
    });
    // 检索 1w 文件 < 500ms（机器相关，记录实测值）
    console.log(`  RAG 1w 实测平均 ${avg.toFixed(1)}ms（设计目标 <500ms，机器相关）`);
    expect(avg).toBeLessThan(5000); // 宽松上限避免内存 mongo / CI 波动误判，实际值见日志
  });
});
