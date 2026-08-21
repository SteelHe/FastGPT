import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadState } from '@zilliz/milvus2-sdk-node';
import {
  DatasetVectorDbName,
  DatasetVectorTextTableName,
  FULL_TEXT_WRITE_BATCH_SIZE
} from '@fastgpt/service/common/vectorDB/constants';

const mocks = vi.hoisted(() => ({
  serviceEnv: {
    MILVUS_LANGUAGE_IDENTIFIER: 'lingua',
    MILVUS_FULL_TEXT_SOURCE: 'data'
  }
}));

vi.mock('@fastgpt/service/env', () => ({
  serviceEnv: mocks.serviceEnv
}));

// constants 在模块加载时捕获 serviceEnv.MILVUS_ADDRESS(setup 阶段已用真实 env 实例化)，
// test-file 的 env mock 无法回填已捕获值，因此直接 mock constants 提供 MILVUS_ADDRESS。
vi.mock('@fastgpt/service/common/vectorDB/constants', () => ({
  DatasetVectorDbName: 'fastgpt',
  DatasetVectorTextTableName: 'modeldata_text',
  FULL_TEXT_WRITE_BATCH_SIZE: 50,
  MILVUS_ADDRESS: 'http://mock-milvus:19530',
  MILVUS_TOKEN: ''
}));

import { MilvusFullTextStore } from '@fastgpt/service/common/vectorDB/milvus/fullText';

type FakeClient = Record<string, ReturnType<typeof vi.fn>>;

let fakeClient: FakeClient;

const makeFakeClient = () => ({
  listDatabases: vi.fn(async () => ({ db_names: ['testdb'] })),
  createDatabase: vi.fn(async () => ({})),
  useDatabase: vi.fn(async () => ({})),
  hasCollection: vi.fn(async () => ({ value: false })),
  createCollection: vi.fn(async () => ({})),
  getLoadState: vi.fn(async () => ({ state: LoadState.LoadStateNotLoad })),
  loadCollectionSync: vi.fn(async () => ({})),
  describeCollection: vi.fn(async () => ({
    schema: { fields: [{ name: 'sparse' }, { name: 'text' }] }
  })),
  upsert: vi.fn(async () => ({})),
  insert: vi.fn(async () => ({})),
  delete: vi.fn(async () => ({})),
  search: vi.fn(async () => ({ results: [] }))
});

describe('Milvus full-text store', () => {
  beforeEach(() => {
    mocks.serviceEnv.MILVUS_LANGUAGE_IDENTIFIER = 'lingua';
    mocks.serviceEnv.MILVUS_FULL_TEXT_SOURCE = 'data';
    fakeClient = makeFakeClient();
    (global as any).milvusClient = fakeClient;
  });

  afterEach(() => {
    delete (global as any).milvusClient;
  });

  describe('init', () => {
    it('creates and loads the collection when missing, then probes text/sparse fields', async () => {
      const store = new MilvusFullTextStore();
      await store.init();

      expect(fakeClient.listDatabases).toHaveBeenCalled();
      expect(fakeClient.useDatabase).toHaveBeenCalledWith({ db_name: DatasetVectorDbName });
      expect(fakeClient.hasCollection).toHaveBeenCalledWith({
        collection_name: DatasetVectorTextTableName
      });
      expect(fakeClient.createCollection).toHaveBeenCalledTimes(1);
      const createCall = fakeClient.createCollection.mock.calls[0]![0] as Record<string, any>;
      expect(createCall.collection_name).toBe(DatasetVectorTextTableName);
      expect(createCall.enableDynamicField).toBe(true);
      const textField = createCall.fields.find((f: { name: string }) => f.name === 'text');
      expect(textField.enable_analyzer).toBe(true);
      expect(textField.enable_match).toBe(true);
      expect(createCall.fields.some((f: { name: string }) => f.name === 'sparse')).toBe(true);
      expect(createCall.fields.some((f: { name: string }) => f.name === 'dataId')).toBe(true);
      const sparseIndex = createCall.index_params.find(
        (p: { field_name: string }) => p.field_name === 'sparse'
      );
      expect(sparseIndex.metric_type).toBe('BM25');
      expect(sparseIndex.index_type).toBe('SPARSE_INVERTED_INDEX');
      expect(createCall.functions[0].input_field_names).toEqual(['text']);
      expect(createCall.functions[0].output_field_names).toEqual(['sparse']);
      expect(fakeClient.loadCollectionSync).toHaveBeenCalledWith({
        collection_name: DatasetVectorTextTableName
      });
      expect(fakeClient.describeCollection).toHaveBeenCalled();
    });

    it('skips create when collection already exists and loaded', async () => {
      fakeClient.hasCollection.mockResolvedValueOnce({ value: true });
      fakeClient.getLoadState.mockResolvedValueOnce({ state: LoadState.LoadStateLoaded });

      const store = new MilvusFullTextStore();
      await store.init();

      expect(fakeClient.createCollection).not.toHaveBeenCalled();
      expect(fakeClient.loadCollectionSync).not.toHaveBeenCalled();
    });

    it('throws when collection lacks sparse/text fields (unsupported Milvus)', async () => {
      fakeClient.hasCollection.mockResolvedValueOnce({ value: true });
      fakeClient.getLoadState.mockResolvedValueOnce({ state: LoadState.LoadStateLoaded });
      fakeClient.describeCollection.mockResolvedValueOnce({
        schema: { fields: [{ name: 'id' }] }
      });

      const store = new MilvusFullTextStore();
      await expect(store.init()).rejects.toThrow('Milvus full-text unsupported');
    });
  });

  describe('write', () => {
    const singleProps = {
      teamId: 'team-1',
      datasetId: 'dataset-1',
      collectionId: 'collection-1',
      dataId: 'data-1',
      text: 'q\na'
    };

    it('data granularity upserts a single row keyed by dataId', async () => {
      const store = new MilvusFullTextStore();
      await store.write([singleProps]);

      expect(fakeClient.delete).not.toHaveBeenCalled();
      expect(fakeClient.upsert).toHaveBeenCalledWith({
        collection_name: DatasetVectorTextTableName,
        data: [
          expect.objectContaining({
            id: 'data-1',
            dataId: 'data-1',
            text: 'q\na',
            teamId: 'team-1',
            datasetId: 'dataset-1',
            collectionId: 'collection-1'
          })
        ]
      });
    });

    it('data granularity splits a large batch into FULL_TEXT_WRITE_BATCH_SIZE upserts', async () => {
      const store = new MilvusFullTextStore();
      const items = Array.from({ length: FULL_TEXT_WRITE_BATCH_SIZE * 2 + 20 }, (_, i) => ({
        ...singleProps,
        dataId: `data-${i}`,
        text: `q${i}\na${i}`
      }));
      await store.write(items);

      expect(fakeClient.upsert).toHaveBeenCalledTimes(3);
      expect(fakeClient.upsert.mock.calls.map((call: any[]) => call[0].data.length)).toEqual([
        FULL_TEXT_WRITE_BATCH_SIZE,
        FULL_TEXT_WRITE_BATCH_SIZE,
        20
      ]);
      // 每片都是独立 upsert，id 与 dataId 一致
      expect(fakeClient.upsert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.arrayContaining([expect.objectContaining({ id: 'data-0' })])
        })
      );
    });

    it('index granularity deletes old rows then inserts one per index', async () => {
      mocks.serviceEnv.MILVUS_FULL_TEXT_SOURCE = 'index';
      const store = new MilvusFullTextStore();
      await store.write([
        {
          ...singleProps,
          indexes: [
            { vectorId: 'vec-1', text: 'index text 1' },
            { vectorId: 'vec-2', text: 'index text 2' }
          ]
        }
      ]);

      expect(fakeClient.delete).toHaveBeenCalledWith({
        collection_name: DatasetVectorTextTableName,
        filter: '(dataId in ["data-1"])'
      });
      expect(fakeClient.insert).toHaveBeenCalledWith({
        collection_name: DatasetVectorTextTableName,
        data: [
          expect.objectContaining({ id: 'vec-1', dataId: 'data-1', text: 'index text 1' }),
          expect.objectContaining({ id: 'vec-2', dataId: 'data-1', text: 'index text 2' })
        ]
      });
    });

    it('index granularity splits a large batch into delete+insert per chunk', async () => {
      mocks.serviceEnv.MILVUS_FULL_TEXT_SOURCE = 'index';
      const store = new MilvusFullTextStore();
      const items = Array.from({ length: FULL_TEXT_WRITE_BATCH_SIZE + 1 }, (_, i) => ({
        ...singleProps,
        dataId: `data-${i}`,
        indexes: [{ vectorId: `vec-${i}`, text: `index ${i}` }]
      }));
      await store.write(items);

      expect(fakeClient.delete).toHaveBeenCalledTimes(2);
      expect(fakeClient.delete).toHaveBeenNthCalledWith(1, {
        collection_name: DatasetVectorTextTableName,
        filter: `(dataId in [${items
          .slice(0, FULL_TEXT_WRITE_BATCH_SIZE)
          .map((item) => `"${item.dataId}"`)
          .join(',')}])`
      });
      expect(fakeClient.insert).toHaveBeenCalledTimes(2);
      expect(fakeClient.insert.mock.calls.map((call: any[]) => call[0].data.length)).toEqual([
        FULL_TEXT_WRITE_BATCH_SIZE,
        1
      ]);
    });

    it('index granularity skips insert when there are no indexes', async () => {
      mocks.serviceEnv.MILVUS_FULL_TEXT_SOURCE = 'index';
      const store = new MilvusFullTextStore();
      await store.write([{ ...singleProps, text: '', indexes: [] }]);

      expect(fakeClient.delete).toHaveBeenCalled();
      expect(fakeClient.insert).not.toHaveBeenCalled();
    });

    it('deduplicates repeated dataIds within a batch', async () => {
      const store = new MilvusFullTextStore();
      await store.write([singleProps, { ...singleProps, text: 'q2\na2' }]);

      expect(fakeClient.upsert).toHaveBeenCalledTimes(1);
      const upserted = fakeClient.upsert.mock.calls[0][0].data;
      expect(upserted).toHaveLength(1);
      expect(upserted[0]).toEqual(expect.objectContaining({ id: 'data-1', text: 'q2\na2' }));
    });
  });

  describe('search', () => {
    const baseProps = {
      teamId: 'team-1',
      datasetIds: ['dataset-1'],
      query: 'hello world',
      limit: 10,
      forbidCollectionIdList: []
    };

    it('returns early for empty query / zero limit / empty datasets', async () => {
      const store = new MilvusFullTextStore();
      expect(await store.search({ ...baseProps, query: '' })).toEqual([]);
      expect(await store.search({ ...baseProps, limit: 0 })).toEqual([]);
      expect(await store.search({ ...baseProps, datasetIds: [] })).toEqual([]);
      expect(fakeClient.search).not.toHaveBeenCalled();
    });

    it('builds BM25 filter and normalizes results with dataId fallback', async () => {
      fakeClient.search.mockResolvedValueOnce({
        results: [
          { id: 'vec-1', dataId: 'data-1', collectionId: 'collection-1', score: 0.9 },
          { id: 'vec-2', score: 0.5 }
        ]
      });

      const store = new MilvusFullTextStore();
      const result = await store.search(baseProps);

      expect(fakeClient.search).toHaveBeenCalledWith(
        expect.objectContaining({
          collection_name: DatasetVectorTextTableName,
          data: ['hello world'],
          anns_field: 'sparse',
          filter: '(teamId == "team-1") and (datasetId in ["dataset-1"])',
          limit: 10,
          output_fields: ['dataId', 'collectionId'],
          params: { metric_type: 'BM25' }
        })
      );
      expect(result).toEqual([
        { dataId: 'data-1', collectionId: 'collection-1', score: 0.9 },
        { dataId: 'vec-2', collectionId: '', score: 0.5 }
      ]);
    });

    it('combines filter and forbid collection lists into the expr', async () => {
      fakeClient.search.mockResolvedValueOnce({ results: [] });

      const store = new MilvusFullTextStore();
      await store.search({
        ...baseProps,
        filterCollectionIdList: ['collection-1'],
        forbidCollectionIdList: ['collection-2']
      });

      expect(fakeClient.search).toHaveBeenCalledWith(
        expect.objectContaining({
          filter:
            '(teamId == "team-1") and (datasetId in ["dataset-1"]) and (collectionId in ["collection-1"]) and (collectionId not in ["collection-2"])'
        })
      );
    });

    it('returns empty when filter list collapses to zero after diffing', async () => {
      const store = new MilvusFullTextStore();
      const result = await store.search({
        ...baseProps,
        filterCollectionIdList: ['collection-1'],
        forbidCollectionIdList: ['collection-1']
      });
      expect(result).toEqual([]);
      expect(fakeClient.search).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deleteByDataId filters on dataId', async () => {
      const store = new MilvusFullTextStore();
      await store.deleteByDataId('data-1');
      expect(fakeClient.delete).toHaveBeenCalledWith({
        collection_name: DatasetVectorTextTableName,
        filter: '(dataId == "data-1")'
      });
    });

    it('deleteByDatasetIds filters on teamId + datasetId list', async () => {
      const store = new MilvusFullTextStore();
      await store.deleteByDatasetIds({ teamId: 'team-1', datasetIds: ['d1', 'd2'] });
      expect(fakeClient.delete).toHaveBeenCalledWith({
        collection_name: DatasetVectorTextTableName,
        filter: '(teamId == "team-1") and (datasetId in ["d1","d2"])'
      });
    });
  });
});
