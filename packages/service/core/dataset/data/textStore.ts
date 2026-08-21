import { Types } from '../../../common/mongo';
import { readFromSecondary } from '../../../common/mongo/utils';
import type { ClientSession } from '../../../common/mongo';
import { getLogger, LogCategories } from '../../../common/logger';
import { jiebaSplit } from '../../../common/string/jieba/index';
import { serviceEnv } from '../../../env';
import { FULL_TEXT_WRITE_BATCH_SIZE } from '../../../common/vectorDB/constants';
import { MongoDatasetDataText } from './dataTextSchema';
import { MongoDatasetData } from './schema';
import { getMilvusFullTextStore } from '../../../common/vectorDB/milvus/fullText';

const logger = getLogger(LogCategories.MODULE.DATASET.DATA);

export type FullTextWriteProps = {
  teamId: string;
  datasetId: string;
  collectionId: string;
  /** dataset_data._id */
  dataId: string;
  /** data 粒度: q + '\n' + a */
  text?: string;
  /** index 粒度: 每个索引一行 */
  indexes?: { vectorId: string; text: string }[];
  /** mongo 实现用于事务内原子写;milvus 忽略 */
  session?: ClientSession;
};

export type FullTextSearchProps = {
  teamId: string;
  datasetIds: string[];
  query: string;
  limit: number;
  forbidCollectionIdList: string[];
  filterCollectionIdList?: string[];
};

// 检索结果统一返回 dataId(dataset_data._id)，两种粒度在 store 内部归一化。
export type FullTextSearchItem = {
  dataId: string;
  collectionId: string;
  score: number;
};

export interface FullTextStore {
  init(): Promise<void>;
  /** 批量写入，内部按 FULL_TEXT_WRITE_BATCH_SIZE 分片 */
  write(props: FullTextWriteProps[]): Promise<void>;
  deleteByDataId(dataId: string, session?: ClientSession): Promise<void>;
  deleteByDatasetIds(
    props: { teamId: string; datasetIds: string[] },
    session?: ClientSession
  ): Promise<void>;
  deleteByCollectionIds(
    props: { teamId: string; datasetIds: string[]; collectionIds: string[] },
    session?: ClientSession
  ): Promise<void>;
  search(props: FullTextSearchProps): Promise<FullTextSearchItem[]>;
}

export const getFullTextEngine = (): 'mongo' | 'milvus' => {
  const value = serviceEnv.FULL_TEXT_ENGINE;
  if (value === 'mongo' || value === 'milvus') return value;
  throw new Error(`Invalid FULL_TEXT_ENGINE: ${value}`);
};

/**
 * Mongo 全文实现。
 * 保持与 main 现状一致的语义：写在事务内原子执行，失败即抛，由外层 session 回滚。
 */
export class MongoFullTextStore implements FullTextStore {
  async init(): Promise<void> {
    // mongo 全文无需额外初始化
  }

  async write(propsList: FullTextWriteProps[]): Promise<void> {
    if (propsList.length === 0) return;
    const session = propsList[0]?.session;

    for (let i = 0; i < propsList.length; i += FULL_TEXT_WRITE_BATCH_SIZE) {
      const chunk = propsList.slice(i, i + FULL_TEXT_WRITE_BATCH_SIZE);
      const ops = await Promise.all(
        chunk.map(async (props) => {
          const fullTextToken = await jiebaSplit({ text: `${props.text ?? ''}`.trim() });
          return {
            updateOne: {
              filter: { dataId: new Types.ObjectId(props.dataId) },
              update: {
                $set: {
                  teamId: new Types.ObjectId(props.teamId),
                  datasetId: new Types.ObjectId(props.datasetId),
                  collectionId: new Types.ObjectId(props.collectionId),
                  fullTextToken
                }
              },
              upsert: true
            }
          };
        })
      );
      // schema 类型声明为 string(z.infer),但运行时存 ObjectId,bulkWrite 严格类型不接受显式 cast
      await MongoDatasetDataText.bulkWrite(ops as any, session ? { session } : {});
    }
  }

  async deleteByDataId(dataId: string, session?: ClientSession): Promise<void> {
    await MongoDatasetDataText.deleteMany(
      { dataId: new Types.ObjectId(dataId) },
      session ? { session } : {}
    );
  }

  async deleteByDatasetIds(
    props: { teamId: string; datasetIds: string[] },
    session?: ClientSession
  ): Promise<void> {
    await MongoDatasetDataText.deleteMany(
      {
        teamId: new Types.ObjectId(props.teamId),
        datasetId: { $in: props.datasetIds.map((id) => new Types.ObjectId(id)) }
      },
      session ? { session } : {}
    );
  }

  async deleteByCollectionIds(
    props: { teamId: string; datasetIds: string[]; collectionIds: string[] },
    session?: ClientSession
  ): Promise<void> {
    await MongoDatasetDataText.deleteMany(
      {
        teamId: new Types.ObjectId(props.teamId),
        datasetId: { $in: props.datasetIds.map((id) => new Types.ObjectId(id)) },
        collectionId: { $in: props.collectionIds.map((id) => new Types.ObjectId(id)) }
      },
      session ? { session } : {}
    );
  }

  async search(props: FullTextSearchProps): Promise<FullTextSearchItem[]> {
    const { teamId, datasetIds, query, limit, forbidCollectionIdList, filterCollectionIdList } =
      props;

    const rows = (await MongoDatasetDataText.aggregate(
      [
        {
          $match: {
            teamId: new Types.ObjectId(teamId),
            $text: { $search: await jiebaSplit({ text: query }) },
            datasetId: { $in: datasetIds.map((id) => new Types.ObjectId(id)) },
            ...(filterCollectionIdList
              ? {
                  collectionId: {
                    $in: filterCollectionIdList
                      .filter((id) => !forbidCollectionIdList.includes(id))
                      .map((id) => new Types.ObjectId(id))
                  }
                }
              : forbidCollectionIdList?.length
                ? {
                    collectionId: {
                      $nin: forbidCollectionIdList.map((id) => new Types.ObjectId(id))
                    }
                  }
                : {})
          }
        },
        { $sort: { score: { $meta: 'textScore' } } },
        { $limit: limit },
        { $project: { _id: 1, collectionId: 1, dataId: 1, score: { $meta: 'textScore' } } }
      ],
      { ...readFromSecondary }
    )) as { dataId: string; collectionId: string; score: number }[];

    return rows.map((item) => ({
      dataId: String(item.dataId),
      collectionId: String(item.collectionId),
      score: item.score
    }));
  }
}

let mongoFullTextStore: MongoFullTextStore | undefined;

/**
 * 按 FULL_TEXT_ENGINE 分发。
 * 运行时依赖单向 textStore -> milvus/fullText(值导入)；milvus/fullText 对 textStore 仅 type-only import，无循环。
 */
export const getFullTextStore = (): FullTextStore => {
  if (getFullTextEngine() === 'mongo') {
    if (!mongoFullTextStore) mongoFullTextStore = new MongoFullTextStore();
    return mongoFullTextStore;
  }
  return getMilvusFullTextStore();
};

// 启动初始化(engine=milvus 时建集合 + 能力探测;engine=mongo no-op)
export const initFullTextStore = async (): Promise<void> => {
  await getFullTextStore().init();
};

/**
 * 方案 A：全文写失败不阻塞数据操作。
 * mongo 保持事务内原子(失败即抛，由外层 session 回滚)；
 * milvus 尽力写，失败置 fullTextPending(修复任务消费，本计划不含该任务)。
 */
export const writeFullText = async (props: FullTextWriteProps): Promise<void> => {
  if (getFullTextEngine() === 'mongo') {
    await getFullTextStore().write([props]);
    return;
  }
  try {
    await getFullTextStore().write([props]);
  } catch (err) {
    logger.error('Milvus full text write failed, mark fullTextPending', {
      dataId: props.dataId,
      error: err
    });
    try {
      await MongoDatasetData.updateOne(
        { _id: new Types.ObjectId(props.dataId) },
        { $set: { fullTextPending: true } }
      );
    } catch (innerErr) {
      logger.error('Failed to set fullTextPending', { dataId: props.dataId, error: innerErr });
    }
  }
};

/** 方案 A 删除同理：mongo 原子，milvus 尽力(残留由 createTime 清理任务兜底，本计划不含)。 */
export const deleteFullText = async (fn: () => Promise<void>): Promise<void> => {
  if (getFullTextEngine() === 'mongo') {
    await fn();
    return;
  }
  try {
    await fn();
  } catch (err) {
    logger.warn('Milvus full text delete failed (best-effort)', { error: err });
  }
};
