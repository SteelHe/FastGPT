import { LoadState, MilvusClient } from '@zilliz/milvus2-sdk-node';
import type {
  FullTextSearchItem,
  FullTextSearchProps,
  FullTextStore,
  FullTextWriteProps
} from '../../../core/dataset/data/textStore';
import {
  DatasetVectorDbName,
  DatasetVectorTextTableName,
  FULL_TEXT_WRITE_BATCH_SIZE,
  MILVUS_ADDRESS,
  MILVUS_TOKEN
} from '../constants';
import {
  buildAnalyzerParams,
  createBM25Function,
  createFullTextIndexParams,
  createFullTextFieldDefs,
  getMilvusFullTextSource,
  getMilvusLanguageIdentifier,
  MILVUS_QUERY_MAX_LENGTH,
  MILVUS_TEXT_MAX_LENGTH
} from './fullTextConfig';
import { retryFn } from '@fastgpt/global/common/system/utils';
import { getLogger, LogCategories } from '../../logger';

const logger = getLogger(LogCategories.INFRA.VECTOR);

const truncateText = (text?: string): string => {
  const t = text ?? '';
  return t.length > MILVUS_TEXT_MAX_LENGTH ? t.slice(0, MILVUS_TEXT_MAX_LENGTH) : t;
};

/**
 * Milvus BM25 全文实现(设计 §5)。
 * 独立集合 modeldata_text，data/index 两种粒度共用同一 schema：
 * - data 粒度: 每 dataset_data 一行(id=dataId)，写用 upsert 保持幂等
 * - index 粒度: 每个 index 一行(id=向量 dataId)，写用 删旧+插新
 * 检索通过 BM25 命中 sparse，输出 dataId(两种粒度每行都冗余 dataId，无需向量反查)。
 */
export class MilvusFullTextStore implements FullTextStore {
  getClient = async (): Promise<MilvusClient> => {
    if (!MILVUS_ADDRESS) return Promise.reject('MILVUS_ADDRESS is not set');
    if (global.milvusClient) return global.milvusClient;

    const client = new MilvusClient({ address: MILVUS_ADDRESS, token: MILVUS_TOKEN });
    await client.connectPromise;
    global.milvusClient = client;
    return client;
  };

  async init(): Promise<void> {
    // 非法粒度/语言识别器 → 启动报错
    const granularity = getMilvusFullTextSource();
    const identifier = getMilvusLanguageIdentifier();

    const client = await this.getClient();

    // init db(zilliz cloud will error)
    try {
      const { db_names } = await client.listDatabases();
      if (!db_names.includes(DatasetVectorDbName)) {
        await client.createDatabase({ db_name: DatasetVectorDbName });
      }
      await client.useDatabase({ db_name: DatasetVectorDbName });
    } catch (error) {
      logger.warn('Milvus full-text database initialization skipped or failed', { error });
    }

    const { value: hasCollection } = await client.hasCollection({
      collection_name: DatasetVectorTextTableName
    });
    if (!hasCollection) {
      const result = await client.createCollection({
        collection_name: DatasetVectorTextTableName,
        description: 'Store dataset full-text (BM25)',
        enableDynamicField: true,
        fields: createFullTextFieldDefs(buildAnalyzerParams(identifier)),
        index_params: createFullTextIndexParams(),
        functions: [createBM25Function()]
      });
      logger.info('Milvus full-text collection created', {
        collection: DatasetVectorTextTableName,
        result
      });
    }

    const { state: colLoadState } = await client.getLoadState({
      collection_name: DatasetVectorTextTableName
    });
    if (
      colLoadState === LoadState.LoadStateNotExist ||
      colLoadState === LoadState.LoadStateNotLoad
    ) {
      await client.loadCollectionSync({ collection_name: DatasetVectorTextTableName });
      logger.info('Milvus full-text collection loaded', {
        collection: DatasetVectorTextTableName
      });
    }

    // 能力探测: 校验 text/sparse 字段存在(不支持的 Milvus 版本会在这里暴露 → 启动失败)
    const desc = await client.describeCollection({ collection_name: DatasetVectorTextTableName });
    const fieldNames = (desc.schema?.fields ?? []).map((f) => f.name);
    if (!fieldNames.includes('sparse') || !fieldNames.includes('text')) {
      throw new Error(
        'Milvus full-text unsupported: collection missing text/sparse fields (need Milvus 2.6+)'
      );
    }

    logger.info('Milvus full-text store initialized', { granularity, identifier });
  }

  async write(propsList: FullTextWriteProps[]): Promise<void> {
    if (propsList.length === 0) return;
    const client = await this.getClient();
    const granularity = getMilvusFullTextSource();

    // 批内按 dataId 去重(data 粒度每 dataId 一行,index 粒度每 dataId 多行)
    const deduped = Array.from(new Map(propsList.map((props) => [props.dataId, props])).values());

    for (let i = 0; i < deduped.length; i += FULL_TEXT_WRITE_BATCH_SIZE) {
      const chunk = deduped.slice(i, i + FULL_TEXT_WRITE_BATCH_SIZE);

      if (granularity === 'data') {
        await retryFn(() =>
          client.upsert({
            collection_name: DatasetVectorTextTableName,
            data: chunk.map((props) => ({
              id: props.dataId,
              dataId: props.dataId,
              text: truncateText(props.text),
              createTime: Date.now(),
              teamId: props.teamId,
              datasetId: props.datasetId,
              collectionId: props.collectionId
            }))
          })
        );
        continue;
      }

      // index 粒度: 批内删旧 + 插新(整体幂等，避免 update 残留旧索引行)
      await client.delete({
        collection_name: DatasetVectorTextTableName,
        filter: `(dataId in [${chunk.map((props) => `"${props.dataId}"`).join(',')}])`
      });
      const rows = chunk.flatMap((props) =>
        (props.indexes ?? []).map((index) => ({
          id: index.vectorId,
          dataId: props.dataId,
          text: truncateText(index.text),
          createTime: Date.now(),
          teamId: props.teamId,
          datasetId: props.datasetId,
          collectionId: props.collectionId
        }))
      );
      if (rows.length > 0) {
        await retryFn(() =>
          client.insert({ collection_name: DatasetVectorTextTableName, data: rows })
        );
      }
    }
  }

  async deleteByDataId(dataId: string): Promise<void> {
    const client = await this.getClient();
    await client.delete({
      collection_name: DatasetVectorTextTableName,
      filter: `(dataId == "${dataId}")`
    });
  }

  async deleteByDatasetIds(props: { teamId: string; datasetIds: string[] }): Promise<void> {
    const client = await this.getClient();
    await client.delete({
      collection_name: DatasetVectorTextTableName,
      filter: `(teamId == "${props.teamId}") and (datasetId in [${props.datasetIds
        .map((id) => `"${id}"`)
        .join(',')}])`
    });
  }

  async deleteByCollectionIds(props: {
    teamId: string;
    datasetIds: string[];
    collectionIds: string[];
  }): Promise<void> {
    const client = await this.getClient();
    await client.delete({
      collection_name: DatasetVectorTextTableName,
      filter: `(teamId == "${props.teamId}") and (datasetId in [${props.datasetIds
        .map((id) => `"${id}"`)
        .join(',')}]) and (collectionId in [${props.collectionIds
        .map((id) => `"${id}"`)
        .join(',')}])`
    });
  }

  async search(props: FullTextSearchProps): Promise<FullTextSearchItem[]> {
    const client = await this.getClient();
    const { teamId, datasetIds, query, limit, forbidCollectionIdList, filterCollectionIdList } =
      props;

    if (!query || limit === 0 || datasetIds.length === 0) return [];

    const trimmedQuery =
      query.length > MILVUS_QUERY_MAX_LENGTH ? query.slice(0, MILVUS_QUERY_MAX_LENGTH) : query;

    // 与 embRecall 一致的 collection 过滤逻辑
    const formatForbidCollectionIdList = (() => {
      if (!filterCollectionIdList) return forbidCollectionIdList;
      return forbidCollectionIdList
        .map((id) => String(id))
        .filter((id) => !filterCollectionIdList.includes(id));
    })();
    const forbidColQuery =
      formatForbidCollectionIdList.length > 0
        ? `and (collectionId not in [${formatForbidCollectionIdList.map((id) => `"${id}"`).join(',')}])`
        : '';
    const formatFilterCollectionId = (() => {
      if (!filterCollectionIdList) return;
      return filterCollectionIdList
        .map((id) => String(id))
        .filter((id) => !forbidCollectionIdList.includes(id));
    })();
    const collectionIdQuery = formatFilterCollectionId
      ? `and (collectionId in [${formatFilterCollectionId.map((id) => `"${id}"`).join(',')}])`
      : '';
    if (formatFilterCollectionId && formatFilterCollectionId.length === 0) return [];

    const filterStr =
      `(teamId == "${teamId}") and (datasetId in [${datasetIds.map((id) => `"${id}"`).join(',')}]) ${collectionIdQuery} ${forbidColQuery}`.trim();

    const searchResult = await retryFn(() =>
      client.search({
        collection_name: DatasetVectorTextTableName,
        data: [trimmedQuery],
        anns_field: 'sparse',
        filter: filterStr,
        limit,
        output_fields: ['dataId', 'collectionId'],
        params: { metric_type: 'BM25' }
      } as any)
    );

    const rows = (searchResult.results || []) as {
      score: number;
      id: string;
      dataId?: string;
      collectionId?: string;
    }[];
    // 两种粒度每行都冗余 dataId(§5.2)，直接归一化返回，无需向量反查
    return rows.map((item) => ({
      dataId: item.dataId ?? String(item.id),
      collectionId: item.collectionId ?? '',
      score: item.score
    }));
  }
}

let milvusFullTextStore: MilvusFullTextStore | undefined;

export const getMilvusFullTextStore = (): MilvusFullTextStore => {
  if (!milvusFullTextStore) milvusFullTextStore = new MilvusFullTextStore();
  return milvusFullTextStore;
};
