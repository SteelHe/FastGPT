import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from '@fastgpt/service/common/mongo';

const mocks = vi.hoisted(() => ({
  serviceEnv: {
    FULL_TEXT_ENGINE: 'mongo'
  },
  jiebaSplit: vi.fn(async ({ text }: { text: string }) => text.replace(/\s+/g, ' ').trim()),
  mongoDatasetDataTextBulkWrite: vi.fn(),
  mongoDatasetDataTextAggregate: vi.fn(),
  mongoDatasetDataTextDeleteMany: vi.fn(),
  mongoDatasetDataUpdateOne: vi.fn(),
  milvusFullTextStoreWrite: vi.fn(),
  milvusFullTextStoreInit: vi.fn()
}));

vi.mock('@fastgpt/service/env', () => ({
  serviceEnv: mocks.serviceEnv
}));

vi.mock('@fastgpt/service/core/dataset/data/dataTextSchema', () => ({
  MongoDatasetDataText: {
    bulkWrite: mocks.mongoDatasetDataTextBulkWrite,
    aggregate: mocks.mongoDatasetDataTextAggregate,
    deleteMany: mocks.mongoDatasetDataTextDeleteMany
  }
}));

vi.mock('@fastgpt/service/core/dataset/data/schema', () => ({
  MongoDatasetData: {
    updateOne: mocks.mongoDatasetDataUpdateOne
  }
}));

vi.mock('@fastgpt/service/common/string/jieba/index', () => ({
  jiebaSplit: mocks.jiebaSplit
}));

vi.mock('@fastgpt/service/common/vectorDB/milvus/fullText', () => ({
  getMilvusFullTextStore: () => ({
    init: mocks.milvusFullTextStoreInit,
    write: mocks.milvusFullTextStoreWrite,
    deleteByDataId: vi.fn(),
    deleteByDatasetIds: vi.fn(),
    deleteByCollectionIds: vi.fn(),
    search: vi.fn()
  })
}));

import {
  deleteFullText,
  getFullTextEngine,
  getFullTextStore,
  MongoFullTextStore,
  writeFullText
} from '@fastgpt/service/core/dataset/data/textStore';

const TEAM_ID = '507f1f77bcf86cd7994390a1';
const DATASET_ID = '507f1f77bcf86cd7994390a2';
const COLLECTION_ID = '507f1f77bcf86cd7994390a3';
const DATA_ID = '507f1f77bcf86cd7994390a4';

describe('full-text store facade', () => {
  beforeEach(() => {
    mocks.serviceEnv.FULL_TEXT_ENGINE = 'mongo';
    vi.clearAllMocks();
    mocks.jiebaSplit.mockImplementation(async ({ text }: { text: string }) =>
      text.replace(/\s+/g, ' ').trim()
    );
  });

  describe('getFullTextEngine', () => {
    it('returns mongo/milvus for valid env', () => {
      expect(getFullTextEngine()).toBe('mongo');
      mocks.serviceEnv.FULL_TEXT_ENGINE = 'milvus';
      expect(getFullTextEngine()).toBe('milvus');
    });

    it('throws on invalid FULL_TEXT_ENGINE', () => {
      mocks.serviceEnv.FULL_TEXT_ENGINE = 'bad' as any;
      expect(() => getFullTextEngine()).toThrow('Invalid FULL_TEXT_ENGINE');
    });
  });

  describe('MongoFullTextStore.write', () => {
    it('tokenizes and batch-upserts with a single bulkWrite, passing through session', async () => {
      const store = new MongoFullTextStore();
      const session = { id: 'session-1' } as any;

      await store.write([
        {
          teamId: TEAM_ID,
          datasetId: DATASET_ID,
          collectionId: COLLECTION_ID,
          dataId: DATA_ID,
          text: 'question\nanswer',
          session
        }
      ]);

      expect(mocks.jiebaSplit).toHaveBeenCalledWith({ text: 'question\nanswer' });
      expect(mocks.mongoDatasetDataTextBulkWrite).toHaveBeenCalledWith(
        [
          {
            updateOne: {
              filter: { dataId: new Types.ObjectId(DATA_ID) },
              update: {
                $set: {
                  teamId: new Types.ObjectId(TEAM_ID),
                  datasetId: new Types.ObjectId(DATASET_ID),
                  collectionId: new Types.ObjectId(COLLECTION_ID),
                  fullTextToken: 'question answer'
                }
              },
              upsert: true
            }
          }
        ],
        { session }
      );
    });
  });

  describe('MongoFullTextStore.search', () => {
    it('normalizes aggregate rows to FullTextSearchItem', async () => {
      const store = new MongoFullTextStore();
      mocks.mongoDatasetDataTextAggregate.mockResolvedValue([
        { dataId: DATA_ID, collectionId: COLLECTION_ID, score: 0.8 }
      ]);

      const result = await store.search({
        teamId: TEAM_ID,
        datasetIds: [DATASET_ID],
        query: 'hello',
        limit: 10,
        forbidCollectionIdList: []
      });

      expect(result).toEqual([{ dataId: DATA_ID, collectionId: COLLECTION_ID, score: 0.8 }]);
      expect(mocks.jiebaSplit).toHaveBeenCalledWith({ text: 'hello' });
    });
  });

  describe('writeFullText', () => {
    it('propagates errors on the mongo path to keep in-transaction atomicity', async () => {
      const err = new Error('mongo text write failed');
      mocks.mongoDatasetDataTextBulkWrite.mockRejectedValueOnce(err);

      await expect(
        writeFullText({
          teamId: TEAM_ID,
          datasetId: DATASET_ID,
          collectionId: COLLECTION_ID,
          dataId: DATA_ID,
          text: 'q\na'
        })
      ).rejects.toBe(err);
      // 事务内失败不允许 fallback 修改主数据
      expect(mocks.mongoDatasetDataUpdateOne).not.toHaveBeenCalled();
    });

    it('swallows milvus write failure and marks fullTextPending', async () => {
      mocks.serviceEnv.FULL_TEXT_ENGINE = 'milvus';
      mocks.milvusFullTextStoreWrite.mockRejectedValueOnce(new Error('milvus down'));

      await expect(
        writeFullText({
          teamId: TEAM_ID,
          datasetId: DATASET_ID,
          collectionId: COLLECTION_ID,
          dataId: DATA_ID,
          text: 'q\na'
        })
      ).resolves.toBeUndefined();
      expect(mocks.mongoDatasetDataUpdateOne).toHaveBeenCalledWith(
        { _id: new Types.ObjectId(DATA_ID) },
        { $set: { fullTextPending: true } }
      );
    });
  });

  describe('getFullTextStore + deleteFullText', () => {
    it('returns mongo store when engine=mongo', () => {
      expect(getFullTextStore()).toBeInstanceOf(MongoFullTextStore);
    });

    it('deleteFullText propagates on mongo path and swallows on milvus path', async () => {
      const mongoErr = new Error('mongo delete failed');
      await expect(deleteFullText(() => Promise.reject(mongoErr))).rejects.toBe(mongoErr);

      mocks.serviceEnv.FULL_TEXT_ENGINE = 'milvus';
      await expect(
        deleteFullText(() => Promise.reject(new Error('milvus delete failed')))
      ).resolves.toBeUndefined();
    });
  });
});
