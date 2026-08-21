import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getMilvusFullTextStore } from '@fastgpt/service/common/vectorDB/milvus/fullText';
import { DatasetVectorTextTableName } from '@fastgpt/service/common/vectorDB/constants';

// 集成测试使用真实 Milvus，unmock 常量和 store
vi.unmock('@fastgpt/service/common/vectorDB/milvus');
vi.unmock('@fastgpt/service/common/vectorDB/constants');
vi.unmock('@fastgpt/service/common/vectorDB/milvus/fullText');
vi.unmock('@fastgpt/service/env');

const isEnabled = Boolean(process.env.MILVUS_ADDRESS);

describe.skipIf(!isEnabled)('Milvus FullText Integration', () => {
  const store = getMilvusFullTextStore();

  const teamId = `test-ft-team-${process.pid}`;
  const datasetId = `test-ft-dataset-${process.pid}`;
  const collectionId = `test-ft-collection-${process.pid}`;
  const dataId = `test-ft-data-${process.pid}`;
  const query = 'FastGPT 全文检索集成测试';

  beforeAll(async () => {
    await store.init();
  }, 60000);

  afterAll(async () => {
    // 清理本测试写入的数据
    await store.deleteByDatasetIds({ teamId, datasetIds: [datasetId] });
  });

  it('init creates/uses the modeldata_text collection with BM25 functions', async () => {
    const { MilvusClient } = await import('@zilliz/milvus2-sdk-node');
    const client =
      global.milvusClient ??
      new MilvusClient({ address: process.env.MILVUS_ADDRESS!, token: process.env.MILVUS_TOKEN });
    const { value: hasCollection } = await client.hasCollection({
      collection_name: DatasetVectorTextTableName
    });
    expect(hasCollection).toBe(true);
  });

  it('write → search → delete round trip', async () => {
    await store.write([
      {
        teamId,
        datasetId,
        collectionId,
        dataId,
        text: `${query}\n支持 BM25 全文检索`,
        // index 粒度使用；data 粒度忽略 indexes
        indexes: [{ vectorId: `${dataId}-vec-1`, text: query }]
      }
    ]);

    const results = await store.search({
      teamId,
      datasetIds: [datasetId],
      query,
      limit: 5,
      forbidCollectionIdList: []
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.dataId === dataId)).toBe(true);
    for (const r of results) {
      expect(typeof r.collectionId).toBe('string');
      expect(typeof r.score).toBe('number');
    }

    await store.deleteByDataId(dataId);

    const afterDelete = await store.search({
      teamId,
      datasetIds: [datasetId],
      query,
      limit: 5,
      forbidCollectionIdList: []
    });
    expect(afterDelete.some((r) => r.dataId === dataId)).toBe(false);
  }, 60000);
});
