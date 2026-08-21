import { SearchScoreTypeEnum } from '@fastgpt/global/core/dataset/constants';
import type {
  DatasetCollectionSchemaType,
  DatasetDataSchemaType,
  SearchDataResponseItemType
} from '@fastgpt/global/core/dataset/type';
import { readFromSecondary } from '../../../../common/mongo/utils';
import { getLogger, LogCategories } from '../../../../common/logger';
import { MongoDatasetCollection } from '../../collection/schema';
import { MongoDatasetData } from '../../data/schema';
import { getFullTextStore, type FullTextSearchItem } from '../../data/textStore';
import { datasetCollectionSelectField, datasetDataSelectField } from './constant';
import { buildSearchResultItem, concatRecallLists } from './result';

const logger = getLogger(LogCategories.MODULE.DATASET.DATA);

type FullTextRecallSource = 'text' | 'imageCaption';

/**
 * 执行 full-text 召回并按 query 来源分组返回。
 * 底层引擎由 FULL_TEXT_ENGINE 决定(mongo -> $text + jieba;milvus -> BM25)，
 * 统一走 getFullTextStore().search，结果归一化为 { dataId, collectionId, score }。
 * 目前 full-text 只处理文本类 query：用户文本和图片 caption。
 */
export const fullTextRecall = async ({
  teamId,
  datasetIds,
  queryGroups,
  limit,
  filterCollectionIdList,
  forbidCollectionIdList
}: {
  teamId: string;
  datasetIds: string[];
  queryGroups: {
    source: FullTextRecallSource;
    queries: string[];
  }[];
  limit: number;
  filterCollectionIdList?: string[];
  forbidCollectionIdList: string[];
}): Promise<{
  textFullTextRecallResults: SearchDataResponseItemType[];
  imageCaptionFullTextRecallResults: SearchDataResponseItemType[];
}> => {
  const queryTasks = queryGroups.flatMap((group) =>
    group.queries
      .map((query) => query.trim())
      .filter(Boolean)
      .map((query) => ({ source: group.source, query }))
  );

  if (limit === 0 || queryTasks.length === 0) {
    return {
      textFullTextRecallResults: [],
      imageCaptionFullTextRecallResults: []
    };
  }

  const store = getFullTextStore();
  const taskItems = await Promise.all(
    queryTasks.map(async ({ source, query }) => {
      const items = await store.search({
        teamId,
        datasetIds,
        query,
        limit,
        forbidCollectionIdList,
        filterCollectionIdList
      });
      return { source, items };
    })
  );

  return buildResultsFromRecallItems({ taskItems, limit });
};

/**
 * 统一结果组装：反查 data/collection、建 item、按 source 分组、concat。
 * 与 main 现状逻辑保持一致，仅召回来源替换为统一 store。
 */
const buildResultsFromRecallItems = async ({
  taskItems,
  limit
}: {
  taskItems: { source: FullTextRecallSource; items: FullTextSearchItem[] }[];
  limit: number;
}): Promise<{
  textFullTextRecallResults: SearchDataResponseItemType[];
  imageCaptionFullTextRecallResults: SearchDataResponseItemType[];
}> => {
  const dataIds = Array.from(
    new Set(taskItems.flatMap((t) => t.items.map((r) => r.dataId)).filter(Boolean))
  );
  const collectionIds = Array.from(
    new Set(taskItems.flatMap((t) => t.items.map((r) => r.collectionId)).filter(Boolean))
  );

  // full-text 只保存 dataId/collectionId/score，展示字段仍回查主 data 与 collection。
  const [dataMaps, collectionMaps] = await Promise.all([
    MongoDatasetData.find(
      {
        _id: { $in: dataIds }
      },
      datasetDataSelectField,
      { ...readFromSecondary }
    )
      .lean()
      .then((res) => {
        const map = new Map<string, DatasetDataSchemaType>();

        res.forEach((item) => {
          map.set(String(item._id), item);
        });

        return map;
      }),
    MongoDatasetCollection.find(
      {
        _id: { $in: collectionIds }
      },
      datasetCollectionSelectField,
      { ...readFromSecondary }
    )
      .lean()
      .then((res) => {
        const map = new Map<string, DatasetCollectionSchemaType>();

        res.forEach((item) => {
          map.set(String(item._id), item);
        });

        return map;
      })
  ]);

  const groupedRecallLists: Record<FullTextRecallSource, SearchDataResponseItemType[][]> = {
    text: [],
    imageCaption: []
  };

  for (const task of taskItems) {
    const list = (
      await Promise.all(
        task.items.map((item, index) => {
          const collection = collectionMaps.get(String(item.collectionId));
          if (!collection) {
            logger.warn('Dataset collection not found during full-text recall', {
              collectionId: item.collectionId,
              dataId: item.dataId
            });
            return;
          }

          const data = dataMaps.get(String(item.dataId));
          if (!data) {
            logger.warn('Dataset data not found during full-text recall', {
              dataId: item.dataId,
              collectionId: item.collectionId
            });
            return;
          }

          return buildSearchResultItem({
            data,
            collection,
            includeIndexes: true,
            score: [
              {
                type: SearchScoreTypeEnum.fullText,
                value: item.score || 0,
                index
              }
            ]
          });
        })
      )
    )
      .filter((item) => {
        if (!item) return false;
        return true;
      })
      .map((item, index) => {
        return {
          ...item,
          score: item!.score.map((item) => ({ ...item, index }))
        };
      }) as SearchDataResponseItemType[];

    groupedRecallLists[task.source].push(list);
  }

  return {
    textFullTextRecallResults: concatRecallLists(groupedRecallLists.text, limit),
    imageCaptionFullTextRecallResults: concatRecallLists(groupedRecallLists.imageCaption, limit)
  };
};
