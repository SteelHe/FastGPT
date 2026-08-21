import { DataType, FunctionType } from '@zilliz/milvus2-sdk-node';
import type {
  FieldType,
  FunctionObject
} from '@zilliz/milvus2-sdk-node/dist/milvus/types/Collection';
import type { CreateIndexSimpleReq } from '@zilliz/milvus2-sdk-node/dist/milvus/types/MilvusIndex';
import { serviceEnv } from '../../../env';

export const MILVUS_TEXT_MAX_LENGTH = 65535;
export const MILVUS_QUERY_MAX_LENGTH = 4000;

export type MilvusIndexParam = Omit<CreateIndexSimpleReq, 'collection_name'>;

export type LanguageIdentifier = 'lingua' | 'whatlang';
export type FullTextSource = 'data' | 'index';

export const getMilvusLanguageIdentifier = (): LanguageIdentifier => {
  const value = serviceEnv.MILVUS_LANGUAGE_IDENTIFIER;
  if (value === 'lingua' || value === 'whatlang') return value;
  throw new Error(`Invalid MILVUS_LANGUAGE_IDENTIFIER: ${value}`);
};

export const getMilvusFullTextSource = (): FullTextSource => {
  const value = serviceEnv.MILVUS_FULL_TEXT_SOURCE;
  if (value === 'data' || value === 'index') return value;
  throw new Error(`Invalid MILVUS_FULL_TEXT_SOURCE: ${value}`);
};

// BM25 Function: input text -> output sparse vector
export const createBM25Function = (): FunctionObject => ({
  name: 'text_bm25_emb',
  type: FunctionType.BM25,
  input_field_names: ['text'],
  output_field_names: ['sparse'],
  params: {}
});

// analyzer 由 MILVUS_LANGUAGE_IDENTIFIER 决定(lingua -> Chinese, whatlang -> Mandarin)
export const buildAnalyzerParams = (identifier: LanguageIdentifier) => ({
  tokenizer: {
    type: 'language_identifier',
    identifier,
    analyzers: {
      default: { tokenizer: 'standard' },
      English: { type: 'english' },
      ...(identifier === 'lingua'
        ? { Chinese: { tokenizer: 'jieba' } }
        : { Mandarin: { tokenizer: 'jieba' } })
    }
  }
});

/**
 * 独立全文集合 modeldata_text 的字段定义(设计 §5.2)。
 * data/index 两种粒度共用同一 schema:
 * - data 粒度: 每 dataset_data 一行, id = dataId
 * - index 粒度: 每个 index 一行, id = 向量 dataId, dataId 冗余存储指向 dataset_data
 */
export const createFullTextFieldDefs = (analyzerParams: Record<string, any>): FieldType[] => [
  { name: 'id', data_type: DataType.VarChar, is_primary_key: true, max_length: 64 },
  { name: 'dataId', data_type: DataType.VarChar, max_length: 64 },
  {
    name: 'text',
    data_type: DataType.VarChar,
    max_length: MILVUS_TEXT_MAX_LENGTH,
    enable_analyzer: true,
    enable_match: true,
    analyzer_params: analyzerParams
  },
  { name: 'sparse', data_type: DataType.SparseFloatVector },
  { name: 'createTime', data_type: DataType.Int64 },
  { name: 'teamId', data_type: DataType.VarChar, max_length: 64 },
  { name: 'datasetId', data_type: DataType.VarChar, max_length: 64 },
  { name: 'collectionId', data_type: DataType.VarChar, max_length: 64 }
];

export const createFullTextIndexParams = (): MilvusIndexParam[] => [
  {
    field_name: 'sparse',
    index_name: 'sparse_BM25',
    index_type: 'SPARSE_INVERTED_INDEX',
    metric_type: 'BM25',
    params: { bm25_k1: 1.2, bm25_b: 0.75 }
  },
  { field_name: 'dataId', index_type: 'Trie' },
  { field_name: 'createTime', index_type: 'STL_SORT' },
  { field_name: 'teamId', index_type: 'Trie' },
  { field_name: 'datasetId', index_type: 'Trie' },
  { field_name: 'collectionId', index_type: 'Trie' }
];
