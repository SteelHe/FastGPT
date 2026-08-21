import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataType, FunctionType } from '@zilliz/milvus2-sdk-node';

const mocks = vi.hoisted(() => ({
  serviceEnv: {
    MILVUS_LANGUAGE_IDENTIFIER: 'lingua',
    MILVUS_FULL_TEXT_SOURCE: 'data'
  }
}));

vi.mock('@fastgpt/service/env', () => ({
  serviceEnv: mocks.serviceEnv
}));

import {
  buildAnalyzerParams,
  createBM25Function,
  createFullTextFieldDefs,
  createFullTextIndexParams,
  getMilvusFullTextSource,
  getMilvusLanguageIdentifier,
  MILVUS_TEXT_MAX_LENGTH
} from '@fastgpt/service/common/vectorDB/milvus/fullTextConfig';

describe('Milvus full-text config', () => {
  beforeEach(() => {
    mocks.serviceEnv.MILVUS_LANGUAGE_IDENTIFIER = 'lingua';
    mocks.serviceEnv.MILVUS_FULL_TEXT_SOURCE = 'data';
  });

  describe('buildAnalyzerParams', () => {
    it('lingua identifier maps to Chinese/jieba analyzer', () => {
      const params = buildAnalyzerParams('lingua');
      expect(params.tokenizer.type).toBe('language_identifier');
      expect(params.tokenizer.identifier).toBe('lingua');
      expect(params.tokenizer.analyzers.Chinese).toEqual({ tokenizer: 'jieba' });
      expect(params.tokenizer.analyzers.Mandarin).toBeUndefined();
      expect(params.tokenizer.analyzers.English).toEqual({ type: 'english' });
      expect(params.tokenizer.analyzers.default).toEqual({ tokenizer: 'standard' });
    });

    it('whatlang identifier maps to Mandarin/jieba analyzer', () => {
      const params = buildAnalyzerParams('whatlang');
      expect(params.tokenizer.identifier).toBe('whatlang');
      expect(params.tokenizer.analyzers.Mandarin).toEqual({ tokenizer: 'jieba' });
      expect(params.tokenizer.analyzers.Chinese).toBeUndefined();
    });
  });

  describe('createBM25Function', () => {
    it('returns BM25 function mapping text to sparse', () => {
      const fn = createBM25Function();
      expect(fn.type).toBe(FunctionType.BM25);
      expect(fn.input_field_names).toEqual(['text']);
      expect(fn.output_field_names).toEqual(['sparse']);
    });
  });

  describe('createFullTextFieldDefs', () => {
    it('defines separate full-text collection schema with dataId and text/sparse', () => {
      const fields = createFullTextFieldDefs(buildAnalyzerParams('lingua'));

      const id = fields.find((f) => f.name === 'id');
      expect(id?.is_primary_key).toBe(true);
      expect(id?.max_length).toBe(64);

      const dataId = fields.find((f) => f.name === 'dataId');
      expect(dataId?.data_type).toBe(DataType.VarChar);

      const text = fields.find((f) => f.name === 'text');
      expect(text?.data_type).toBe(DataType.VarChar);
      expect(text?.max_length).toBe(MILVUS_TEXT_MAX_LENGTH);
      expect(text?.enable_analyzer).toBe(true);
      expect(text?.enable_match).toBe(true);
      expect(text?.analyzer_params).toBeDefined();

      const sparse = fields.find((f) => f.name === 'sparse');
      expect(sparse?.data_type).toBe(DataType.SparseFloatVector);

      for (const name of ['createTime', 'teamId', 'datasetId', 'collectionId']) {
        expect(fields.find((f) => f.name === name)).toBeDefined();
      }
    });
  });

  describe('createFullTextIndexParams', () => {
    it('indexes sparse with BM25 and ownership fields with Trie/STL_SORT', () => {
      const params = createFullTextIndexParams();
      const sparseIndex = params.find((p) => p.field_name === 'sparse');
      expect(sparseIndex?.index_type).toBe('SPARSE_INVERTED_INDEX');
      expect(sparseIndex?.metric_type).toBe('BM25');

      expect(params.find((p) => p.field_name === 'dataId')?.index_type).toBe('Trie');
      expect(params.find((p) => p.field_name === 'createTime')?.index_type).toBe('STL_SORT');
      expect(params.find((p) => p.field_name === 'teamId')?.index_type).toBe('Trie');
      expect(params.find((p) => p.field_name === 'datasetId')?.index_type).toBe('Trie');
      expect(params.find((p) => p.field_name === 'collectionId')?.index_type).toBe('Trie');
    });
  });

  describe('env getters', () => {
    it('returns configured language identifier and source', () => {
      expect(getMilvusLanguageIdentifier()).toBe('lingua');
      expect(getMilvusFullTextSource()).toBe('data');
    });

    it('throws on invalid language identifier', () => {
      mocks.serviceEnv.MILVUS_LANGUAGE_IDENTIFIER = 'bad' as any;
      expect(() => getMilvusLanguageIdentifier()).toThrow('Invalid MILVUS_LANGUAGE_IDENTIFIER');
    });

    it('throws on invalid full-text source', () => {
      mocks.serviceEnv.MILVUS_FULL_TEXT_SOURCE = 'bad' as any;
      expect(() => getMilvusFullTextSource()).toThrow('Invalid MILVUS_FULL_TEXT_SOURCE');
    });
  });
});
