import { MongoDatasetCollection } from './schema';
import type { ClientSession } from '../../../common/mongo';
import { MongoDatasetCollectionTags } from '../tag/schema';
import { readFromSecondary } from '../../../common/mongo/utils';
import type {
  CollectionTagValueType,
  CollectionWithDatasetType
} from '@fastgpt/global/core/dataset/type';
import { DatasetErrEnum } from '@fastgpt/global/common/error/code/dataset';
import {
  DatasetCollectionDataProcessModeEnum,
  DatasetCollectionSyncResultEnum,
  DatasetCollectionTypeEnum,
  DatasetSourceReadTypeEnum,
  TrainingModeEnum
} from '@fastgpt/global/core/dataset/constants';
import { readDatasetSourceRawText } from '../read';
import { hashStr } from '@fastgpt/global/common/string/tools';
import { mongoSessionRun } from '../../../common/mongo/sessionRun';
import { createCollectionAndInsertData, delCollection } from './controller';
import { collectionCanSync } from '@fastgpt/global/core/dataset/collection/utils';

/**
 * get all collection by top collectionId
 */
export async function findCollectionAndChild({
  teamId,
  datasetId,
  collectionId,
  fields = '_id parentId name metadata'
}: {
  teamId: string;
  datasetId: string;
  collectionId: string;
  fields?: string;
}) {
  async function find(id: string) {
    // find children
    const children = await MongoDatasetCollection.find(
      { teamId, datasetId, parentId: id },
      fields
    ).lean();

    let collections = children;

    for (const child of children) {
      const grandChildrenIds = await find(child._id);
      collections = collections.concat(grandChildrenIds);
    }

    return collections;
  }
  const [collection, childCollections] = await Promise.all([
    MongoDatasetCollection.findById(collectionId, fields).lean(),
    find(collectionId)
  ]);

  if (!collection) {
    return Promise.reject('Collection not found');
  }

  return [collection, ...childCollections];
}

export function getCollectionUpdateTime({ name, time }: { time?: Date; name: string }) {
  if (time) return time;
  if (name.startsWith('手动') || ['manual', 'mark'].includes(name)) return new Date('2999/9/9');
  return new Date();
}

/**
 * 统一解析 collection 创建时的 tags 入参：
 * - string 元素（标签名）→ 查找或创建标签，返回 ObjectId 字符串
 * - {tag, value} 元素 → 查找或创建标签，校验值类型，返回 {tagId, value}
 *
 * 返回值可直接写入 collection.tags 字段存储
 */
export const createOrGetCollectionTags = async ({
  tags,
  datasetId,
  teamId,
  session
}: {
  tags?: (string | { tag: string; value: string | number })[];
  datasetId: string;
  teamId: string;
  session?: ClientSession;
}): Promise<(string | CollectionTagValueType)[] | undefined> => {
  if (!tags) return undefined;

  if (tags.length === 0) return [];

  // Collect all tag names from both string and object elements
  const stringNames: string[] = [];
  const objectInputs: { tag: string; value: string | number }[] = [];

  for (const item of tags) {
    if (typeof item === 'string') {
      stringNames.push(item);
    } else {
      objectInputs.push(item);
    }
  }

  const allNames = [...stringNames, ...objectInputs.map((o) => o.tag)];
  if (allNames.length === 0) return [];

  // 1. Query all existing tags by name
  const existingTags = await MongoDatasetCollectionTags.find(
    {
      teamId,
      datasetId,
      tag: { $in: allNames }
    },
    undefined,
    { session }
  ).lean();

  const existingNameMap = new Map(
    existingTags.map((t) => [t.tag, { _id: t._id, tagType: t.tagType || 'string' }])
  );

  // 2. Validate object inputs BEFORE creating new tags（先校验再写入）
  for (const input of objectInputs) {
    const existing = existingNameMap.get(input.tag);
    const expectedType = existing ? existing.tagType : 'string'; // 新标签默认 string
    const valueType = typeof input.value;

    if (expectedType === 'string' && valueType !== 'string') {
      return Promise.reject(DatasetErrEnum.tagValueInvalid);
    }
    if ((expectedType === 'number' || expectedType === 'datetime') && valueType !== 'number') {
      return Promise.reject(DatasetErrEnum.tagValueInvalid);
    }
  }

  // 3. Find names that don't exist yet, and create them
  const namesToCreate = allNames.filter((name) => !existingNameMap.has(name));
  if (namesToCreate.length > 0) {
    const newTags = await MongoDatasetCollectionTags.insertMany(
      namesToCreate.map((name) => ({ teamId, datasetId, tag: name })),
      { session, ordered: true }
    );
    for (const nt of newTags) {
      existingNameMap.set(nt.tag, { _id: nt._id, tagType: (nt as any).tagType || 'string' });
    }
  }

  // 4. Build result: string names → ObjectId, object inputs → {tagId, value}
  const result: (string | CollectionTagValueType)[] = [];

  for (const name of stringNames) {
    const info = existingNameMap.get(name);
    if (info) result.push(String(info._id));
  }

  for (const input of objectInputs) {
    const info = existingNameMap.get(input.tag);
    if (!info) continue;
    result.push({ tagId: String(info._id), value: input.value });
  }

  return result;
};

/**
 * 将 collection 的 tags（混合格式）解析为可重入的输入格式
 * - 旧格式 ObjectId → 标签名（如 "safety"）
 * - 新格式 {tagId, value} → {tag: 标签名, value}（如 {tag: "safety", value: "A"}）
 *
 * 输出结果可作为 createOrGetCollectionTags 的 tags 参数，用于同步、重建等场景
 */
export const collectionTagsToTagLabel = async ({
  datasetId,
  tags
}: {
  datasetId: string;
  tags?: (string | CollectionTagValueType)[];
}): Promise<(string | { tag: string; value: string | number })[] | undefined> => {
  if (!tags) return undefined;
  if (tags.length === 0) return [];

  // Get all the tags
  const collectionTags = await MongoDatasetCollectionTags.find({ datasetId }, undefined, {
    ...readFromSecondary
  }).lean();
  const tagsMap = new Map<string, string>();
  collectionTags.forEach((tag) => {
    tagsMap.set(String(tag._id), tag.tag);
  });

  return tags
    .map((tag) => {
      if (typeof tag === 'string') {
        // Old format: tag is an ObjectId string, resolve to tag name
        const tagName = tagsMap.get(tag);
        if (!tagName) return null;
        return tagName;
      } else {
        // New format: { tagId, value }, resolve tagId to tag name
        const tagName = tagsMap.get(tag.tagId);
        if (!tagName) return null;
        return { tag: tagName, value: tag.value };
      }
    })
    .filter((item): item is string | { tag: string; value: string | number } => item !== null);
};

export const syncCollection = async (collection: CollectionWithDatasetType) => {
  const dataset = collection.dataset;

  if (!collectionCanSync(collection.type)) {
    return Promise.reject(DatasetErrEnum.notSupportSync);
  }

  // Get new text
  const sourceReadType = await (async () => {
    if (collection.type === DatasetCollectionTypeEnum.link) {
      if (!collection.rawLink) return Promise.reject('rawLink is missing');
      return {
        type: DatasetSourceReadTypeEnum.link,
        sourceId: collection.rawLink,
        selector: collection.metadata?.webPageSelector
      };
    }

    const sourceId = collection.apiFileId;

    if (!sourceId) return Promise.reject('apiFileId is missing');

    return {
      type: DatasetSourceReadTypeEnum.apiFile,
      sourceId,
      apiDatasetServer: dataset.apiDatasetServer
    };
  })();

  const { title, rawText } = await readDatasetSourceRawText({
    teamId: collection.teamId,
    tmbId: collection.tmbId,
    datasetId: collection.datasetId,
    ...sourceReadType
  });

  if (!rawText) {
    return DatasetCollectionSyncResultEnum.failed;
  }

  // Check if the original text is the same: skip if same
  const hashRawText = hashStr(rawText);
  if (collection.hashRawText && hashRawText !== collection.hashRawText) {
    await mongoSessionRun(async (session) => {
      // Delete old collection
      await delCollection({
        collections: [collection],
        delImg: false,
        delFile: false,
        session
      });

      // Create new collection
      await createCollectionAndInsertData({
        session,
        dataset,
        rawText: rawText,
        createCollectionParams: {
          ...collection,
          name: title || collection.name,
          updateTime: new Date(),
          tags: await collectionTagsToTagLabel({
            datasetId: collection.datasetId,
            tags: collection.tags
          })
        }
      });
    });

    return DatasetCollectionSyncResultEnum.success;
  } else if (title && collection.name !== title) {
    await MongoDatasetCollection.updateOne({ _id: collection._id }, { $set: { name: title } });
    return DatasetCollectionSyncResultEnum.success;
  }
  return DatasetCollectionSyncResultEnum.sameRaw;
};

/*
  QA: 独立进程
  Chunk: Image Index -> Auto index -> chunk index
*/
export const getTrainingModeByCollection = ({
  trainingType,
  autoIndexes,
  imageIndex,
  supportImageIndex = false
}: {
  trainingType?: DatasetCollectionDataProcessModeEnum;
  autoIndexes?: boolean;
  imageIndex?: boolean;
  supportImageIndex?: boolean;
}) => {
  if (
    trainingType === DatasetCollectionDataProcessModeEnum.imageParse &&
    global.feConfigs?.isPlus
  ) {
    return TrainingModeEnum.imageParse;
  }

  if (trainingType === DatasetCollectionDataProcessModeEnum.qa) {
    return TrainingModeEnum.qa;
  }
  if (
    trainingType === DatasetCollectionDataProcessModeEnum.chunk &&
    imageIndex &&
    supportImageIndex &&
    global.feConfigs?.isPlus
  ) {
    return TrainingModeEnum.image;
  }
  if (
    trainingType === DatasetCollectionDataProcessModeEnum.chunk &&
    autoIndexes &&
    global.feConfigs?.isPlus
  ) {
    return TrainingModeEnum.auto;
  }
  return TrainingModeEnum.chunk;
};
