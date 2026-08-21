import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from '@fastgpt/service/common/mongo';

const mocks = vi.hoisted(() => ({
  getFullTextEngine: vi.fn(),
  getFullTextStore: vi.fn(),
  textStoreInit: vi.fn(),
  textStoreWrite: vi.fn(),
  mongoTextFind: vi.fn(),
  mongoTextCount: vi.fn(),
  mongoTextDeleteMany: vi.fn(),
  mongoDataFind: vi.fn(),
  mongoDataFindById: vi.fn(),
  migrationLogCreate: vi.fn(),
  migrationLogFindOne: vi.fn(),
  migrationLogUpdateOne: vi.fn(),
  migrationFailedFind: vi.fn(),
  migrationFailedBulkWrite: vi.fn(),
  migrationFailedDeleteOne: vi.fn(),
  milvusClientInstances: [] as any[],
  milvusQueryQueue: [] as any[][],
  milvusQueryCount: 0,
  makeQuery: (items: any[]) => ({
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(items)
  })
}));

vi.mock('@fastgpt/service/common/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LogCategories: { MODULE: { DATASET: { DATA: ['dataset', 'data'] } } }
}));

vi.mock('@fastgpt/service/common/vectorDB/constants', () => ({
  DatasetVectorTextTableName: 'modeldata_text',
  FULL_TEXT_WRITE_BATCH_SIZE: 50
}));

vi.mock('@fastgpt/service/core/dataset/data/dataTextSchema', () => ({
  MongoDatasetDataText: {
    find: mocks.mongoTextFind,
    countDocuments: mocks.mongoTextCount,
    deleteMany: mocks.mongoTextDeleteMany
  }
}));

vi.mock('@fastgpt/service/core/dataset/data/schema', () => ({
  MongoDatasetData: {
    find: mocks.mongoDataFind,
    findById: mocks.mongoDataFindById
  }
}));

vi.mock('@fastgpt/service/core/dataset/data/textStore', () => ({
  getFullTextEngine: mocks.getFullTextEngine,
  getFullTextStore: mocks.getFullTextStore
}));

vi.mock('@fastgpt/service/core/dataset/fullText/schema', () => ({
  MongoFullTextMigrationLog: {
    create: mocks.migrationLogCreate,
    findOne: mocks.migrationLogFindOne,
    updateOne: mocks.migrationLogUpdateOne
  },
  MongoFullTextMigrationFailed: {
    find: mocks.migrationFailedFind,
    bulkWrite: mocks.migrationFailedBulkWrite,
    deleteOne: mocks.migrationFailedDeleteOne
  }
}));

vi.mock('@fastgpt/global/common/error/utils', () => ({
  getErrText: (err: any) => err?.message ?? String(err)
}));

vi.mock('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: class {
    address: string;
    token: string | undefined;
    connectPromise: Promise<void>;
    hasCollection: any;
    query: any;
    dropCollection: any;
    constructor(config: { address: string; token?: string }) {
      this.address = config.address;
      this.token = config.token;
      this.connectPromise = Promise.resolve();
      this.hasCollection = vi.fn(async () => ({ value: true }));
      this.query = vi.fn(async ({ output_fields }: any) => {
        if (output_fields?.[0] === 'count(*)') {
          return { data: [{ 'count(*)': mocks.milvusQueryCount }] };
        }
        return { data: mocks.milvusQueryQueue.shift() ?? [] };
      });
      this.dropCollection = vi.fn(async () => ({}));
      mocks.milvusClientInstances.push(this);
    }
  }
}));

import { runFullTextMigration } from '@fastgpt/service/core/dataset/fullText/migration';

const TEAM_ID = '507f1f77bcf86cd7994390a1';
const DATASET_ID = '507f1f77bcf86cd7994390a2';
const COLLECTION_ID = '507f1f77bcf86cd7994390a3';
const DATA_ID_1 = '507f1f77bcf86cd7994390a4';
const DATA_ID_2 = '507f1f77bcf86cd7994390a5';

const makeTargetStore = (targetClient?: any) => ({
  init: mocks.textStoreInit,
  write: mocks.textStoreWrite,
  getClient: () =>
    Promise.resolve(targetClient ?? { query: vi.fn(async () => ({ data: [{ 'count(*)': 0 }] })) })
});

const makeDataRows = () => [
  {
    _id: new Types.ObjectId(DATA_ID_1),
    teamId: new Types.ObjectId(TEAM_ID),
    datasetId: new Types.ObjectId(DATASET_ID),
    collectionId: new Types.ObjectId(COLLECTION_ID),
    q: 'q1',
    a: 'a1',
    indexes: [{ dataId: 'vec-1', text: 'i1' }]
  },
  {
    _id: new Types.ObjectId(DATA_ID_2),
    teamId: new Types.ObjectId(TEAM_ID),
    datasetId: new Types.ObjectId(DATASET_ID),
    collectionId: new Types.ObjectId(COLLECTION_ID),
    q: 'q2',
    a: 'a2',
    indexes: []
  }
];

const makeTextRows = () => [
  { _id: new Types.ObjectId(DATA_ID_1), dataId: DATA_ID_1 },
  { _id: new Types.ObjectId(DATA_ID_2), dataId: DATA_ID_2 }
];

describe('runFullTextMigration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.milvusClientInstances.length = 0;
    mocks.milvusQueryQueue.length = 0;
    mocks.milvusQueryCount = 0;
    mocks.textStoreWrite.mockResolvedValue(undefined);
    mocks.migrationLogCreate.mockResolvedValue({});
    mocks.migrationLogUpdateOne.mockResolvedValue({});
    mocks.migrationFailedDeleteOne.mockResolvedValue({});
    mocks.migrationFailedBulkWrite.mockResolvedValue({});
  });

  describe('validation', () => {
    it('throws when oldEngine equals newEngine', async () => {
      mocks.getFullTextEngine.mockReturnValue('mongo');
      await expect(runFullTextMigration({ oldEngine: 'mongo' })).rejects.toThrow(
        'must be different'
      );
    });

    it('throws when oldEngine=milvus without oldMilvusAddress', async () => {
      mocks.getFullTextEngine.mockReturnValue('mongo');
      await expect(runFullTextMigration({ oldEngine: 'milvus' })).rejects.toThrow(
        'oldMilvusAddress is required'
      );
    });

    it('throws on invalid oldEngine', async () => {
      mocks.getFullTextEngine.mockReturnValue('mongo');
      await expect(runFullTextMigration({ oldEngine: 'bad' as any })).rejects.toThrow(
        'Invalid oldEngine'
      );
    });
  });

  describe('dry-run', () => {
    it('reports source count without writing or creating a log', async () => {
      mocks.getFullTextEngine.mockReturnValue('milvus');
      mocks.getFullTextStore.mockReturnValue(makeTargetStore());
      mocks.mongoTextCount.mockResolvedValue(1500);

      const result = await runFullTextMigration({ oldEngine: 'mongo', dryRun: true });

      expect(result.status).toBe('dry-run');
      expect(result.sourceCount).toBe(1500);
      expect(result.message).toContain('1500');
      expect(mocks.textStoreInit).toHaveBeenCalledTimes(1);
      expect(mocks.textStoreWrite).not.toHaveBeenCalled();
      expect(mocks.migrationLogCreate).not.toHaveBeenCalled();
    });
  });

  describe('mongo -> milvus', () => {
    it('migrates all rows and finalizes as done', async () => {
      mocks.getFullTextEngine.mockReturnValue('milvus');
      mocks.getFullTextStore.mockReturnValue(
        makeTargetStore({ query: vi.fn(async () => ({ data: [{ 'count(*)': 2 }] })) })
      );
      mocks.mongoTextCount.mockResolvedValue(2);

      const textBatches = [makeTextRows(), []];
      mocks.mongoTextFind.mockImplementation(() => mocks.makeQuery(textBatches.shift() ?? []));
      mocks.mongoDataFind.mockImplementation(() => mocks.makeQuery(makeDataRows()));
      mocks.migrationFailedFind.mockImplementation(() => mocks.makeQuery([]));

      const result = await runFullTextMigration({ oldEngine: 'mongo', batchSize: 10 });

      expect(result.status).toBe('done');
      expect(result.processedCount).toBe(2);
      expect(result.failedCount).toBe(0);
      expect(result.sourceCount).toBe(2);
      expect(result.targetCount).toBe(2);
      expect(mocks.migrationLogCreate).toHaveBeenCalledTimes(1);
      // 2 行 < 50，合成一次批量写入
      expect(mocks.textStoreWrite).toHaveBeenCalledTimes(1);
      expect(mocks.textStoreWrite).toHaveBeenCalledWith([
        {
          teamId: TEAM_ID,
          datasetId: DATASET_ID,
          collectionId: COLLECTION_ID,
          dataId: DATA_ID_1,
          text: 'q1\na1',
          indexes: [{ vectorId: 'vec-1', text: 'i1' }]
        },
        {
          teamId: TEAM_ID,
          datasetId: DATASET_ID,
          collectionId: COLLECTION_ID,
          dataId: DATA_ID_2,
          text: 'q2\na2',
          indexes: []
        }
      ]);
      expect(mocks.migrationLogUpdateOne).toHaveBeenLastCalledWith(
        { migrationId: expect.any(String) },
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'done', processedCount: 2 })
        })
      );
      // removeOld 未开启
      expect(mocks.mongoTextDeleteMany).not.toHaveBeenCalled();
    });

    it('writes source batches in FULL_TEXT_WRITE_BATCH_SIZE chunks', async () => {
      mocks.getFullTextEngine.mockReturnValue('milvus');
      mocks.getFullTextStore.mockReturnValue(makeTargetStore());
      mocks.mongoTextCount.mockResolvedValue(120);
      mocks.migrationFailedFind.mockImplementation(() => mocks.makeQuery([]));

      const makeBulkId = (i: number) => new Types.ObjectId(String(i).padStart(24, '0'));
      const bulkTextRows = Array.from({ length: 120 }, (_, i) => ({
        _id: makeBulkId(i),
        dataId: makeBulkId(i).toString()
      }));
      const bulkDataRows = Array.from({ length: 120 }, (_, i) => ({
        _id: makeBulkId(i),
        teamId: new Types.ObjectId(TEAM_ID),
        datasetId: new Types.ObjectId(DATASET_ID),
        collectionId: new Types.ObjectId(COLLECTION_ID),
        q: `q${i}`,
        a: `a${i}`,
        indexes: []
      }));

      const textBatches = [bulkTextRows, []];
      mocks.mongoTextFind.mockImplementation(() => mocks.makeQuery(textBatches.shift() ?? []));
      mocks.mongoDataFind.mockImplementation(() => mocks.makeQuery(bulkDataRows));

      const result = await runFullTextMigration({ oldEngine: 'mongo', batchSize: 200 });

      expect(result.status).toBe('done');
      expect(result.processedCount).toBe(120);
      // 120 条 → 50/50/20 三次批量写入
      expect(mocks.textStoreWrite).toHaveBeenCalledTimes(3);
      expect(mocks.textStoreWrite.mock.calls.map((call) => (call[0] as any[]).length)).toEqual([
        50, 50, 20
      ]);
    });

    it('records failed chunks and self-heals recoverable rows on resume retry', async () => {
      mocks.getFullTextEngine.mockReturnValue('milvus');
      mocks.getFullTextStore.mockReturnValue(makeTargetStore());
      mocks.mongoTextCount.mockResolvedValue(2);
      // 整片写入失败(片内含 DATA_ID_1 即抛),批次内重试后仍失败
      mocks.textStoreWrite.mockImplementation(async (items: any[]) => {
        if (items.some((item) => item.dataId === DATA_ID_1)) throw new Error('write failed');
      });

      const textBatches = [makeTextRows(), []];
      mocks.mongoTextFind.mockImplementation(() => mocks.makeQuery(textBatches.shift() ?? []));
      mocks.mongoDataFind.mockImplementation(() => mocks.makeQuery(makeDataRows()));
      // 断点补齐阶段:失败列表含整片 DATA_ID_1 + DATA_ID_2,逐条重试自愈
      mocks.migrationFailedFind.mockImplementation(() =>
        mocks.makeQuery([
          { migrationId: 'm-1', dataId: DATA_ID_1, error: 'write failed' },
          { migrationId: 'm-1', dataId: DATA_ID_2, error: 'write failed' }
        ])
      );
      mocks.mongoDataFindById.mockImplementation((id: string) => ({
        lean: vi.fn().mockResolvedValue(id === DATA_ID_1 ? makeDataRows()[0] : makeDataRows()[1])
      }));

      const result = await runFullTextMigration({ oldEngine: 'mongo', batchSize: 10 });

      expect(result.status).toBe('failed');
      expect(result.processedCount).toBe(1); // DATA_ID_2 逐条重试成功
      expect(result.failedCount).toBe(1); // DATA_ID_1 重试仍失败
      expect(mocks.migrationFailedBulkWrite).toHaveBeenCalledTimes(1);
      expect(mocks.migrationFailedBulkWrite).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            updateOne: expect.objectContaining({
              filter: { migrationId: expect.any(String), dataId: DATA_ID_1 }
            })
          }),
          expect.objectContaining({
            updateOne: expect.objectContaining({
              filter: { migrationId: expect.any(String), dataId: DATA_ID_2 }
            })
          })
        ]),
        { ordered: false }
      );
      // DATA_ID_2 重试成功后从失败列表删除
      expect(mocks.migrationFailedDeleteOne).toHaveBeenCalledWith({
        migrationId: expect.any(String),
        dataId: DATA_ID_2
      });
    });

    it('deletes old mongo indexes when removeOld and done', async () => {
      mocks.getFullTextEngine.mockReturnValue('milvus');
      mocks.getFullTextStore.mockReturnValue(makeTargetStore());
      mocks.mongoTextCount.mockResolvedValue(2);

      const textBatches = [makeTextRows(), []];
      mocks.mongoTextFind.mockImplementation(() => mocks.makeQuery(textBatches.shift() ?? []));
      mocks.mongoDataFind.mockImplementation(() => mocks.makeQuery(makeDataRows()));
      mocks.migrationFailedFind.mockImplementation(() => mocks.makeQuery([]));

      const result = await runFullTextMigration({
        oldEngine: 'mongo',
        batchSize: 10,
        removeOld: true
      });

      expect(result.status).toBe('done');
      expect(mocks.mongoTextDeleteMany).toHaveBeenCalledWith({});
    });

    it('marks failed and blocks removeOld when source count mismatch', async () => {
      mocks.getFullTextEngine.mockReturnValue('milvus');
      mocks.getFullTextStore.mockReturnValue(makeTargetStore());
      mocks.mongoTextCount.mockResolvedValue(3); // 源声称 3 行,实际只扫到 2 个 dataId

      const textBatches = [makeTextRows(), []];
      mocks.mongoTextFind.mockImplementation(() => mocks.makeQuery(textBatches.shift() ?? []));
      mocks.mongoDataFind.mockImplementation(() => mocks.makeQuery(makeDataRows()));
      mocks.migrationFailedFind.mockImplementation(() => mocks.makeQuery([]));

      const result = await runFullTextMigration({
        oldEngine: 'mongo',
        batchSize: 10,
        removeOld: true
      });

      expect(result.status).toBe('failed');
      expect(result.error).toContain('count mismatch');
      // 计数校验未通过,禁止删除旧索引
      expect(mocks.mongoTextDeleteMany).not.toHaveBeenCalled();
    });
  });

  describe('milvus source -> mongo target', () => {
    it('migrates from old milvus, deduping index-granularity rows by dataId', async () => {
      mocks.getFullTextEngine.mockReturnValue('mongo');
      mocks.getFullTextStore.mockReturnValue(makeTargetStore());
      mocks.mongoTextCount.mockResolvedValue(2); // 目标 mongo 计数
      mocks.milvusQueryCount = 3; // 源含 index 粒度重复行
      mocks.milvusQueryQueue = [
        [
          { id: 'v1', dataId: DATA_ID_1 },
          { id: 'v2', dataId: DATA_ID_1 },
          { id: 'v3', dataId: DATA_ID_2 }
        ],
        []
      ];
      mocks.mongoDataFind.mockImplementation(() => mocks.makeQuery(makeDataRows()));
      mocks.migrationFailedFind.mockImplementation(() => mocks.makeQuery([]));

      const result = await runFullTextMigration({
        oldEngine: 'milvus',
        oldMilvusAddress: 'http://old-milvus:19530',
        batchSize: 10
      });

      expect(result.status).toBe('done');
      expect(result.processedCount).toBe(2); // DATA_ID_1 去重
      expect(result.sourceCount).toBe(3);
      expect(result.targetCount).toBe(2);
      expect(mocks.milvusClientInstances.length).toBe(1);
      expect(mocks.milvusClientInstances[0].address).toBe('http://old-milvus:19530');
      expect(mocks.milvusClientInstances[0].hasCollection).toHaveBeenCalledWith({
        collection_name: 'modeldata_text'
      });
      // removeOld 未开启,不 drop 源集合
      expect(mocks.milvusClientInstances[0].dropCollection).not.toHaveBeenCalled();
    });

    it('drops old milvus collection when removeOld and done', async () => {
      mocks.getFullTextEngine.mockReturnValue('mongo');
      mocks.getFullTextStore.mockReturnValue(makeTargetStore());
      mocks.mongoTextCount.mockResolvedValue(1);
      mocks.milvusQueryCount = 1;
      mocks.milvusQueryQueue = [[{ id: 'v1', dataId: DATA_ID_1 }], []];
      mocks.mongoDataFind.mockImplementation(() => mocks.makeQuery(makeDataRows()));
      mocks.migrationFailedFind.mockImplementation(() => mocks.makeQuery([]));

      const result = await runFullTextMigration({
        oldEngine: 'milvus',
        oldMilvusAddress: 'http://old-milvus:19530',
        removeOld: true
      });

      expect(result.status).toBe('done');
      expect(mocks.milvusClientInstances[0].dropCollection).toHaveBeenCalledWith({
        collection_name: 'modeldata_text'
      });
    });
  });

  describe('resume', () => {
    const mockFindOneLog = (log: any) => {
      mocks.migrationLogFindOne.mockImplementation(() => ({
        lean: vi.fn().mockResolvedValue(log)
      }));
    };

    it('throws when resumed log engine mismatch', async () => {
      mocks.getFullTextEngine.mockReturnValue('milvus');
      mockFindOneLog({
        migrationId: 'm-1',
        oldEngine: 'mongo',
        newEngine: 'mongo',
        status: 'running',
        cursor: ''
      });

      await expect(
        runFullTextMigration({ oldEngine: 'mongo', resumeMigrationId: 'm-1' })
      ).rejects.toThrow('engine mismatch');
    });

    it('throws when resumed log already done', async () => {
      mocks.getFullTextEngine.mockReturnValue('milvus');
      mockFindOneLog({
        migrationId: 'm-1',
        oldEngine: 'mongo',
        newEngine: 'milvus',
        status: 'done',
        cursor: ''
      });

      await expect(
        runFullTextMigration({ oldEngine: 'mongo', resumeMigrationId: 'm-1' })
      ).rejects.toThrow('already done');
    });

    it('continues from persisted cursor and does not create a new log', async () => {
      mocks.getFullTextEngine.mockReturnValue('milvus');
      mocks.getFullTextStore.mockReturnValue(makeTargetStore());
      // 续跑只统计 cursor 之后的剩余行
      mocks.mongoTextCount.mockResolvedValue(1);
      mockFindOneLog({
        migrationId: 'm-1',
        oldEngine: 'mongo',
        newEngine: 'milvus',
        status: 'running',
        cursor: DATA_ID_1
      });

      // 续跑只处理 cursor 之后的数据
      const textBatches = [[{ _id: new Types.ObjectId(DATA_ID_2), dataId: DATA_ID_2 }], []];
      mocks.mongoTextFind.mockImplementation(() => mocks.makeQuery(textBatches.shift() ?? []));
      mocks.mongoDataFind.mockImplementation(() => mocks.makeQuery([makeDataRows()[1]]));
      mocks.migrationFailedFind.mockImplementation(() => mocks.makeQuery([]));

      const result = await runFullTextMigration({ oldEngine: 'mongo', resumeMigrationId: 'm-1' });

      expect(result.status).toBe('done');
      expect(result.processedCount).toBe(1);
      expect(mocks.migrationLogCreate).not.toHaveBeenCalled();
      expect(mocks.mongoTextFind).toHaveBeenCalledWith(
        { _id: { $gt: new Types.ObjectId(DATA_ID_1) } },
        { _id: 1, dataId: 1 }
      );
    });
  });
});
