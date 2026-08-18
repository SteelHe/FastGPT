import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from '@fastgpt/service/common/mongo';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import type { SearchDataResponseItemType } from '@fastgpt/global/core/dataset/type';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoDatasetData } from '@fastgpt/service/core/dataset/data/schema';
import { getFakeUsers } from '@test/datas/users';

/**
 * RAG Collection 权限过滤 —— 召回引擎层（-6, task collection-rag-filtering）
 *
 * 评审缺陷修复回归：fullTextRecall.ts 的 Mongo 回查防线曾对 dataset_collections 误用
 * 不存在的 collectionId 字段（应为 _id），导致真子集权限过滤时全文召回被清空。
 *
 * 本文件在真实 MongoDB 上直接调用 fullTextRecall / embeddingRecall，覆盖 RF-004 的
 * "embedding 与 full-text 均应用 collectionId IN filterCollectionIdList" 断言：
 * - 召回候选同时包含可读与不可读 collection（模拟向量库/全文索引延迟或旧索引）；
 * - 真子集 filterCollectionIdList=[可读] 时，Mongo 回查防线只保留可读 collection 的结果，
 *   既不被清空（修复点），也不泄漏不可读 collection（不过滤越权）。
 *
 * 外部依赖 mock（与既有 defaultRecall.test.ts 一致）：
 * - getVectors / recallFromVectorStore：真实 embedding 服务与向量库无法在单测环境运行；
 * - MongoDatasetDataText.aggregate：Mongo full-text $text 依赖 jieba 词典与文本索引，
 *   在 CI 内存版上不稳定，mock 为受控召回候选（候选来源与权限过滤无关）；
 * - jiebaSplit：全文 $text 检索词由受控 aggregate mock 消费，无需真实分词。
 *
 * MongoDatasetData / MongoDatasetCollection 保持真实连接，回查防线在真实 DB 上验证。
 *
 * 运行方式：
 *   cd packages/service && pnpm vitest run test/core/dataset/search/recallPermissionFiltering.test.ts --coverage.enabled=false
 */

const mockGetVectors = vi.hoisted(() => vi.fn());
const mockGetEmbeddingModel = vi.hoisted(() => vi.fn());
const mockIsImageEmbeddingModel = vi.hoisted(() => vi.fn());
const mockRecallFromVectorStore = vi.hoisted(() => vi.fn());
const mockDataTextAggregate = vi.hoisted(() => vi.fn());

vi.mock('@fastgpt/service/core/ai/embedding', () => ({
  getVectors: mockGetVectors
}));

vi.mock('@fastgpt/service/core/ai/model', () => ({
  getEmbeddingModel: mockGetEmbeddingModel,
  isImageEmbeddingModel: mockIsImageEmbeddingModel
}));

vi.mock('@fastgpt/service/common/vectorDB/controller', () => ({
  recallFromVectorStore: mockRecallFromVectorStore
}));

vi.mock('@fastgpt/service/core/dataset/data/dataTextSchema', () => ({
  DatasetDataTextCollectionName: 'dataset_data_texts',
  MongoDatasetDataText: {
    aggregate: mockDataTextAggregate
  }
}));

vi.mock('@fastgpt/service/common/string/jieba/index', () => ({
  jiebaSplit: vi.fn(async () => 'fastgpt collection')
}));

import { fullTextRecall } from '@fastgpt/service/core/dataset/search/defaultRecall/fullTextRecall';
import { embeddingRecall } from '@fastgpt/service/core/dataset/search/defaultRecall/embeddingRecall';

const TIMEOUT = 60_000;

const oid = () => new Types.ObjectId().toString();

/** 建一个 Dataset + 两个文件 Collection（c1 可读 / c2 不可读）+ 各自一个数据块 */
const setupDataset = async () => {
  const users = await getFakeUsers(1);
  const teamId = users.owner.teamId;
  const tmbId = users.owner.tmbId;

  const dataset = await MongoDataset.create({
    teamId,
    tmbId,
    name: 'dataset'
  });
  const datasetId = String(dataset._id);

  const c1 = await MongoDatasetCollection.create({
    teamId,
    tmbId,
    datasetId,
    parentId: null,
    type: DatasetCollectionTypeEnum.file,
    name: 'c1-readable'
  });
  const c2 = await MongoDatasetCollection.create({
    teamId,
    tmbId,
    datasetId,
    parentId: null,
    type: DatasetCollectionTypeEnum.file,
    name: 'c2-secret'
  });

  const d1 = await MongoDatasetData.create({
    teamId,
    tmbId,
    datasetId,
    collectionId: c1._id,
    q: 'readable content',
    a: '',
    chunkIndex: 0,
    indexes: [{ dataId: 'index-d1', text: 'readable content' }]
  });
  const d2 = await MongoDatasetData.create({
    teamId,
    tmbId,
    datasetId,
    collectionId: c2._id,
    q: 'secret content',
    a: '',
    chunkIndex: 0,
    indexes: [{ dataId: 'index-d2', text: 'secret content' }]
  });

  return {
    teamId,
    datasetId,
    c1: String(c1._id),
    c2: String(c2._id),
    d1: String(d1._id),
    d2: String(d2._id)
  };
};

describe('fullTextRecall 权限过滤回查防线（RF-004）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    'RF-004: 真子集 filterCollectionIdList=[c1] 时全文召回不被清空，且只含 c1（不过滤越权）',
    async () => {
      const { teamId, datasetId, c1, c2, d1, d2 } = await setupDataset();

      // 模拟全文索引返回可读 + 不可读两个候选（真实场景：索引延迟/旧索引可能带出 c2）
      mockDataTextAggregate.mockResolvedValue([
        {
          _id: oid(),
          collectionId: new Types.ObjectId(c1),
          dataId: new Types.ObjectId(d1),
          score: 5
        },
        {
          _id: oid(),
          collectionId: new Types.ObjectId(c2),
          dataId: new Types.ObjectId(d2),
          score: 4
        }
      ]);

      const result = await fullTextRecall({
        teamId,
        datasetIds: [datasetId],
        queryGroups: [{ source: 'text', queries: ['readable'] }],
        limit: 10,
        filterCollectionIdList: [c1],
        forbidCollectionIdList: []
      });

      // 修复点：MongoDatasetCollection 回查不再误用 collectionId 字段 → c1 候选保留，召回非空
      expect(result.textFullTextRecallResults).toHaveLength(1);
      expect(result.textFullTextRecallResults[0].collectionId).toBe(c1);
      expect(result.textFullTextRecallResults[0].q).toBe('readable content');
      // 越权防线：c2 候选在回查时被授权集合剔除
      expect(
        result.textFullTextRecallResults.some(
          (item: SearchDataResponseItemType) => item.collectionId === c2
        )
      ).toBe(false);
      expect(
        result.textFullTextRecallResults.some(
          (item: SearchDataResponseItemType) => item.q === 'secret content'
        )
      ).toBe(false);
    },
    TIMEOUT
  );

  it(
    'control: 未启用权限过滤（无 filterCollectionIdList）时全文召回同时含 c1 与 c2',
    async () => {
      const { teamId, datasetId, c1, c2, d1, d2 } = await setupDataset();

      mockDataTextAggregate.mockResolvedValue([
        {
          _id: oid(),
          collectionId: new Types.ObjectId(c1),
          dataId: new Types.ObjectId(d1),
          score: 5
        },
        {
          _id: oid(),
          collectionId: new Types.ObjectId(c2),
          dataId: new Types.ObjectId(d2),
          score: 4
        }
      ]);

      const result = await fullTextRecall({
        teamId,
        datasetIds: [datasetId],
        queryGroups: [{ source: 'text', queries: ['readable'] }],
        limit: 10,
        forbidCollectionIdList: []
      });

      expect(result.textFullTextRecallResults).toHaveLength(2);
      expect(
        result.textFullTextRecallResults
          .map((item: SearchDataResponseItemType) => item.collectionId)
          .sort()
      ).toEqual([c1, c2].sort());
    },
    TIMEOUT
  );
});

describe('embeddingRecall 权限过滤回查防线（RF-004）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEmbeddingModel.mockReturnValue({
      model: 'mock-embedding-model',
      name: 'Mock Embedding Model',
      maxToken: 100
    });
    mockIsImageEmbeddingModel.mockReturnValue(false);
    mockGetVectors.mockResolvedValue({
      tokens: 10,
      vectors: [[0.1, 0.2]]
    });
  });

  it(
    'RF-004: 真子集 filterCollectionIdList=[c1] 时向量召回不被清空，只含 c1，且 filterCollectionIdList 下传',
    async () => {
      const { teamId, datasetId, c1, c2 } = await setupDataset();

      // 模拟向量库返回可读 + 不可读两个候选（真实场景：旧向量可能带出 c2）
      mockRecallFromVectorStore.mockResolvedValue({
        results: [
          { id: 'index-d1', collectionId: c1, score: 0.9 },
          { id: 'index-d2', collectionId: c2, score: 0.8 }
        ]
      });

      const result = await embeddingRecall({
        teamId,
        datasetIds: [datasetId],
        model: 'mock-embedding-model',
        imageQueries: [],
        textQueries: ['readable'],
        imageCaptionQueries: [],
        limit: 10,
        forbidCollectionIdList: [],
        filterCollectionIdList: [c1]
      });

      // 向量层已应用 collectionId IN filterCollectionIdList
      expect(mockRecallFromVectorStore).toHaveBeenCalledWith(
        expect.objectContaining({ filterCollectionIdList: [c1] })
      );

      // 回查防线：只保留可读 collection，非空、不含 c2
      expect(result.textEmbeddingRecallResults).toHaveLength(1);
      expect(result.textEmbeddingRecallResults[0].collectionId).toBe(c1);
      expect(result.textEmbeddingRecallResults[0].q).toBe('readable content');
      expect(
        result.textEmbeddingRecallResults.some(
          (item: SearchDataResponseItemType) => item.collectionId === c2
        )
      ).toBe(false);
    },
    TIMEOUT
  );

  it(
    'control: 未启用权限过滤（无 filterCollectionIdList）时向量召回同时含 c1 与 c2',
    async () => {
      const { teamId, datasetId, c1, c2 } = await setupDataset();

      mockRecallFromVectorStore.mockResolvedValue({
        results: [
          { id: 'index-d1', collectionId: c1, score: 0.9 },
          { id: 'index-d2', collectionId: c2, score: 0.8 }
        ]
      });

      const result = await embeddingRecall({
        teamId,
        datasetIds: [datasetId],
        model: 'mock-embedding-model',
        imageQueries: [],
        textQueries: ['readable'],
        imageCaptionQueries: [],
        limit: 10,
        forbidCollectionIdList: []
      });

      expect(result.textEmbeddingRecallResults).toHaveLength(2);
      expect(
        result.textEmbeddingRecallResults
          .map((item: SearchDataResponseItemType) => item.collectionId)
          .sort()
      ).toEqual([c1, c2].sort());
    },
    TIMEOUT
  );
});

describe('embeddingRecall / fullTextRecall 同一 filterCollectionIdList 的 forbid 兼容', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    'forbidCollectionIdList 与 filterCollectionIdList 同时存在时，授权集合仍生效且不被 forbid 误伤',
    async () => {
      const { teamId, datasetId, c1, c2, d1 } = await setupDataset();

      mockDataTextAggregate.mockResolvedValue([
        {
          _id: oid(),
          collectionId: new Types.ObjectId(c1),
          dataId: new Types.ObjectId(d1),
          score: 5
        }
      ]);

      // forbid 不含 c1，effective=[c1]：应返回 c1（授权集合是主防线，forbid 是附加防线）
      const result = await fullTextRecall({
        teamId,
        datasetIds: [datasetId],
        queryGroups: [{ source: 'text', queries: ['readable'] }],
        limit: 10,
        filterCollectionIdList: [c1],
        forbidCollectionIdList: [c2]
      });

      expect(result.textFullTextRecallResults).toHaveLength(1);
      expect(result.textFullTextRecallResults[0].collectionId).toBe(c1);
    },
    TIMEOUT
  );
});

afterEach(() => {
  vi.clearAllMocks();
});
