import { getForbidCollectionIdList, filterCollectionByMetadata } from './collectionFilter';
import { decideCollectionFilter } from './collectionPermission';
import { embeddingRecall } from './embeddingRecall';
import { fullTextRecall } from './fullTextRecall';

/**
 * 默认召回的并行调度层。
 * 这里先统一计算 forbid collection、metadata filter 与授权集合（allowed）的合并结果，
 * 再把同一份 collection 约束下发给 embedding/full-text 两条召回链路，保证两种召回方式
 * 看到的集合范围一致。
 *
 * 权限过滤语义（-5）：
 * - 检索入口在 Dataset read 鉴权通过后传入 `allowedCollectionIdList`（实际文件 Collection ID）。
 * - effective = (allowed ∩ filterCollectionIdList) - forbidCollectionIdList；
 *   交集为空时直接返回空召回，不执行向量/全文检索（RF-003）。
 * - allowed === undefined（未启用权限过滤 / 授权覆盖全部文件 Collection）时不设置
 *   collectionId IN 过滤，按 Dataset 级别召回（性能路径，RF-002）；仅真子集时设置过滤（RF-004）。
 * - forbidCollectionIdList 保留为额外防线，不替代授权集合。
 */
export const multiQueryRecall = async ({
  teamId,
  datasetIds,
  model,
  imageQueries,
  collectionFilterMatch,
  embeddingLimit,
  fullTextLimit,
  textQueries,
  imageCaptionQueries,
  allowedCollectionIdList
}: {
  teamId: string;
  datasetIds: string[];
  model: string;
  imageQueries: string[];
  collectionFilterMatch?: string;
  embeddingLimit: number;
  fullTextLimit: number;
  textQueries: string[];
  imageCaptionQueries: string[];
  /** 授权文件 Collection ID（检索入口在 Dataset read 鉴权后解析，可空表示未启用权限过滤） */
  allowedCollectionIdList?: string[];
}) => {
  const [forbidCollectionIdList, filterCollectionIdList] = await Promise.all([
    getForbidCollectionIdList({
      teamId,
      datasetIds
    }),
    filterCollectionByMetadata({
      teamId,
      datasetIds,
      collectionFilterMatch
    })
  ]);

  // 授权集合与元数据/forbid 合并，决定实际下发的 collectionId 过滤（-4）。
  // allowed === undefined（未启用权限过滤 / 授权覆盖全部文件 Collection）时不再额外做
  // 全量计数——全量短路已由 resolveReadableCollectionIds 在解析阶段直接返回 undefined。
  const { isEmpty, collectionFilter } = decideCollectionFilter({
    allowedCollectionIdList,
    filterCollectionIdList,
    forbidCollectionIdList
  });

  // 交集为空 → 直接返回空召回，不执行向量/全文检索
  if (isEmpty) {
    return {
      tokens: 0,
      textEmbeddingRecallResults: [],
      imageCaptionEmbeddingRecallResults: [],
      imageVectorRecallResults: [],
      textFullTextRecallResults: [],
      imageCaptionFullTextRecallResults: []
    };
  }

  const [
    {
      tokens,
      textEmbeddingRecallResults,
      imageCaptionEmbeddingRecallResults,
      imageVectorRecallResults
    },
    { textFullTextRecallResults, imageCaptionFullTextRecallResults }
  ] = await Promise.all([
    embeddingRecall({
      teamId,
      datasetIds,
      model,
      imageQueries,
      textQueries,
      imageCaptionQueries,
      limit: embeddingLimit,
      forbidCollectionIdList,
      filterCollectionIdList: collectionFilter
    }),
    fullTextRecall({
      teamId,
      datasetIds,
      queryGroups: [
        { source: 'text', queries: textQueries },
        { source: 'imageCaption', queries: imageCaptionQueries }
      ],
      limit: fullTextLimit,
      filterCollectionIdList: collectionFilter,
      forbidCollectionIdList
    })
  ]);

  return {
    tokens,
    textEmbeddingRecallResults,
    imageCaptionEmbeddingRecallResults,
    imageVectorRecallResults,
    textFullTextRecallResults,
    imageCaptionFullTextRecallResults
  };
};
