import json5 from 'json5';
import { MongoDatasetCollection } from '../../collection/schema';
import { MongoDatasetCollectionTags } from '../../tag/schema';
import { readFromSecondary } from '../../../../common/mongo/utils';
import { computeFilterIntersection } from '../utils';

/* ========== New format key-value tag filtering types ========== */

/** A single key-value tag condition: { tagName: { $op: value } } */
type TagCondition = Record<string, Record<string, unknown>>;

/* ========== checkValue: pure value comparsion ========== */

type CompareOp =
  | '$eq'
  | '$ne'
  | '$gt'
  | '$lt'
  | '$gte'
  | '$lte'
  | '$contains'
  | '$notContains'
  | '$startsWith'
  | '$endsWith'
  | '$regex'
  | '$empty'
  | '$notEmpty';

export function checkValue(
  op: CompareOp,
  target: unknown,
  storedVal: string | number | null | undefined,
  tagType: string
): boolean {
  // $empty / $notEmpty — check existence
  if (op === '$empty') {
    return storedVal === null || storedVal === undefined || storedVal === '';
  }
  if (op === '$notEmpty') {
    return storedVal !== null && storedVal !== undefined && storedVal !== '';
  }

  // target is null means the condition is invalid
  if (target === null || target === undefined) return false;

  switch (tagType) {
    case 'number': {
      const stored = Number(storedVal);
      const t = Number(target);
      if (isNaN(stored) || isNaN(t)) return false;
      switch (op) {
        case '$eq':
          return stored === t;
        case '$ne':
          return stored !== t;
        case '$gt':
          return stored > t;
        case '$lt':
          return stored < t;
        case '$gte':
          return stored >= t;
        case '$lte':
          return stored <= t;
        default:
          return false;
      }
    }
    case 'datetime': {
      // Datetime values are stored as unix millisecond timestamps
      const stored = Number(storedVal);
      const t = Number(target);
      if (isNaN(stored) || isNaN(t)) return false;
      switch (op) {
        case '$eq':
          return stored === t;
        case '$ne':
          return stored !== t;
        case '$gt':
          return stored > t;
        case '$lt':
          return stored < t;
        case '$gte':
          return stored >= t;
        case '$lte':
          return stored <= t;
        default:
          return false;
      }
    }
    case 'string':
    default: {
      const stored = String(storedVal ?? '');
      const t = String(target);
      switch (op) {
        case '$eq':
          return stored === t;
        case '$ne':
          return stored !== t;
        case '$contains':
          return stored.toLowerCase().includes(t.toLowerCase());
        case '$notContains':
          return !stored.toLowerCase().includes(t.toLowerCase());
        case '$startsWith':
          return stored.toLowerCase().startsWith(t.toLowerCase());
        case '$endsWith':
          return stored.toLowerCase().endsWith(t.toLowerCase());
        case '$regex':
          try {
            return new RegExp(t).test(stored);
          } catch {
            return false;
          }
        default:
          return false;
      }
    }
  }
}

/* ========== filterCollectionByKeyValueTags ========== */

/**
 * Filter collections by key-value tag conditions (new format).
 *
 * AND conditions must all be satisfied; OR conditions need at least one match.
 * A condition whose tag does not exist in a dataset fails that condition:
 * AND → no match; OR → that condition does not count as a match.
 */
export async function filterCollectionByKeyValueTags({
  andConditions,
  orConditions,
  teamId,
  datasetIds
}: {
  andConditions: TagCondition[];
  orConditions: TagCondition[];
  teamId: string;
  datasetIds: string[];
}): Promise<string[] | undefined> {
  // 1. Collect all tag names from conditions
  const allConditions = [...andConditions, ...orConditions];
  const tagNames = new Set<string>();
  for (const cond of allConditions) {
    const tagName = Object.keys(cond)[0];
    if (tagName) tagNames.add(tagName);
  }
  if (tagNames.size === 0) return undefined;

  // 2. Query tag documents to get tagId and tagType, grouped by dataset
  const tagDocs = await MongoDatasetCollectionTags.find(
    {
      teamId,
      datasetId: { $in: datasetIds },
      tag: { $in: Array.from(tagNames) }
    },
    '_id datasetId tag tagType',
    { ...readFromSecondary }
  ).lean();

  const datasetTagMap = new Map<string, Map<string, { id: string; type: string }>>();
  for (const doc of tagDocs) {
    const dsId = String(doc.datasetId);
    if (!datasetTagMap.has(dsId)) datasetTagMap.set(dsId, new Map());
    datasetTagMap.get(dsId)!.set(doc.tag, {
      id: String(doc._id),
      type: doc.tagType || 'string'
    });
  }
  if (datasetTagMap.size === 0) return [];

  // 3. Check a single value condition against one collection's tags.
  // Tag missing in the dataset → not satisfied; entry missing in the collection
  // → not satisfied.
  const matchCondition = (
    cond: TagCondition,
    tagMap: Map<string, { id: string; type: string }>,
    tagsArr: Array<{ tagId: string; value?: string | number }>
  ): boolean => {
    const tagName = Object.keys(cond)[0];
    const tagInfo = tagMap.get(tagName);
    if (!tagInfo) return false;
    const entry = tagsArr.find((t) => t.tagId === tagInfo.id);
    if (!entry) return false;
    const opObj = cond[tagName] as Record<string, unknown>;
    const op = Object.keys(opObj)[0];
    return checkValue(op as CompareOp, opObj[op], entry.value, tagInfo.type);
  };

  const allCollectionIds: string[] = [];

  // 4. Iterate each dataset (the same tag name may map to different tagIds per dataset)
  for (const [dsId, tagMap] of datasetTagMap) {
    const andTagIds = (andConditions || [])
      .map((cond) => tagMap.get(Object.keys(cond)[0])?.id)
      .filter((id): id is string => Boolean(id));
    const orTagIds = (orConditions || [])
      .map((cond) => tagMap.get(Object.keys(cond)[0])?.id)
      .filter((id): id is string => Boolean(id));

    if (andTagIds.length === 0 && orTagIds.length === 0) continue;

    // Mongo pre-filter by tagId. AND → $all (more precise); pure OR → $in.
    // A single 'tags.tagId' predicate keeps the compound index
    // { teamId, datasetId, 'tags.tagId' } usable; exact matching happens below.
    const tagIdQuery =
      andTagIds.length > 0
        ? { 'tags.tagId': { $all: andTagIds } }
        : { 'tags.tagId': { $in: orTagIds } };

    const collections = await MongoDatasetCollection.find(
      { teamId, datasetId: dsId, ...tagIdQuery },
      '_id tags',
      { ...readFromSecondary }
    )
      // 生产环境同时存在 {teamId,datasetId,tags} 与 {teamId,datasetId,'tags.tagId'} 两个多键索引时，
      // 查询规划器可能误选前者（在整段 tags 数组上建索引，无法精准定位 tagId），导致全表 FETCH（实测慢约 8x）。
      // 这里用 hint 强制走 tags.tagId 索引，避免依赖规划器的索引选择。
      .hint({ teamId: 1, datasetId: 1, 'tags.tagId': 1 })
      .lean();

    // 5. Application-layer value comparison
    for (const col of collections) {
      const tagsArr = (
        (col.tags || []) as Array<{ tagId?: string; value?: string | number } | string>
      ).filter(
        (t): t is { tagId: string; value?: string | number } =>
          typeof t === 'object' && t !== null && Boolean(t.tagId)
      );

      // AND: all must pass
      const andOk = (andConditions || []).every((cond) => matchCondition(cond, tagMap, tagsArr));
      if (!andOk) continue;

      // OR: at least one must pass
      if (orConditions?.length) {
        const orOk = orConditions.some((cond) => matchCondition(cond, tagMap, tagsArr));
        if (!orOk) continue;
      }

      allCollectionIds.push(String(col._id));
    }
  }

  return allCollectionIds.length > 0 ? allCollectionIds : [];
}

export const getForbidCollectionIdList = async ({
  teamId,
  datasetIds
}: {
  teamId: string;
  datasetIds: string[];
}) => {
  const collections = await MongoDatasetCollection.find(
    {
      teamId,
      datasetId: { $in: datasetIds },
      forbid: true
    },
    '_id'
  );

  return collections.map((item) => String(item._id));
};

/**
 * 按知识库集合元数据过滤 collectionId。
 *
 * 标签过滤保持原有语义：`$and` 优先生效，且 `$and` 中字符串标签和 null 不能共存。
 * 输入 collectionIds 可以是文件夹，会递归展开为实际文件集合。
 */
export const filterCollectionByMetadata = async ({
  teamId,
  datasetIds,
  collectionFilterMatch
}: {
  teamId: string;
  datasetIds: string[];
  collectionFilterMatch?: string;
}): Promise<string[] | undefined> => {
  const getAllCollectionIds = async ({
    parentCollectionIds
  }: {
    parentCollectionIds?: string[];
  }): Promise<string[] | undefined> => {
    if (!parentCollectionIds) return;
    if (parentCollectionIds.length === 0) {
      return [];
    }

    const collections = await MongoDatasetCollection.find(
      {
        teamId,
        datasetId: { $in: datasetIds },
        _id: { $in: parentCollectionIds }
      },
      '_id type',
      {
        ...readFromSecondary
      }
    ).lean();

    const resultIds = new Set<string>();
    collections.forEach((item) => {
      if (item.type !== 'folder') {
        resultIds.add(String(item._id));
      }
    });

    const folderIds = collections
      .filter((item) => item.type === 'folder')
      .map((item) => String(item._id));

    // Get all child collection ids
    if (folderIds.length) {
      const childCollections = await MongoDatasetCollection.find(
        {
          teamId,
          datasetId: { $in: datasetIds },
          parentId: { $in: folderIds }
        },
        '_id type',
        {
          ...readFromSecondary
        }
      ).lean();

      const childIds = await getAllCollectionIds({
        parentCollectionIds: childCollections.map((item) => String(item._id))
      });

      childIds?.forEach((id) => resultIds.add(id));
    }

    return Array.from(resultIds);
  };

  if (!collectionFilterMatch || !global.feConfigs.isPlus) return;

  let tagCollectionIdList: string[] | undefined = undefined;
  let createTimeCollectionIdList: string[] | undefined = undefined;
  let inputCollectionIdList: string[] | undefined = undefined;

  try {
    const jsonMatch = json5.parse(collectionFilterMatch);

    const andTagsRaw = jsonMatch?.tags?.$and as unknown[] | undefined;
    const orTagsRaw = jsonMatch?.tags?.$or as unknown[] | undefined;

    // Detect new format: first element is a non-array object
    const isNewFormatItem = (item: unknown): boolean =>
      typeof item === 'object' && !Array.isArray(item) && item !== null;

    const hasNewFormat =
      (andTagsRaw && andTagsRaw.length > 0 && isNewFormatItem(andTagsRaw[0])) ||
      (orTagsRaw && orTagsRaw.length > 0 && isNewFormatItem(orTagsRaw[0]));

    if (hasNewFormat) {
      // New format: route to key-value tag filter
      tagCollectionIdList = await filterCollectionByKeyValueTags({
        andConditions: ((andTagsRaw || []) as TagCondition[]).filter(
          (item) => typeof item === 'object' && !Array.isArray(item) && item !== null
        ),
        orConditions: ((orTagsRaw || []) as TagCondition[]).filter(
          (item) => typeof item === 'object' && !Array.isArray(item) && item !== null
        ),
        teamId,
        datasetIds
      });
    } else {
      // Old format (string-based tags) — keep existing logic unchanged
      const andTags = andTagsRaw as (string | null)[] | undefined;
      const orTags = orTagsRaw as (string | null)[] | undefined;

      if (andTags && andTags.length > 0) {
        const uniqueAndTags = Array.from(new Set(andTags));
        if (uniqueAndTags.includes(null) && uniqueAndTags.some((tag) => typeof tag === 'string')) {
          return [];
        }
        if (uniqueAndTags.every((tag) => typeof tag === 'string')) {
          const matchedTags = await MongoDatasetCollectionTags.find(
            {
              teamId,
              datasetId: { $in: datasetIds },
              tag: { $in: uniqueAndTags as string[] }
            },
            '_id datasetId tag',
            { ...readFromSecondary }
          ).lean();

          // Group tags by dataset
          const datasetTagMap = new Map<string, { tagIds: string[]; tagNames: Set<string> }>();

          matchedTags.forEach((tag) => {
            const datasetId = String(tag.datasetId);
            if (!datasetTagMap.has(datasetId)) {
              datasetTagMap.set(datasetId, {
                tagIds: [],
                tagNames: new Set()
              });
            }

            const datasetData = datasetTagMap.get(datasetId)!;
            datasetData.tagIds.push(String(tag._id));
            datasetData.tagNames.add(tag.tag);
          });

          const validDatasetIds = Array.from(datasetTagMap.entries())
            .filter(([, data]) => uniqueAndTags.every((tag) => data.tagNames.has(tag as string)))
            .map(([datasetId]) => datasetId);

          if (validDatasetIds.length === 0) return [];

          const collectionsPromises = validDatasetIds.map((datasetId) => {
            const { tagIds } = datasetTagMap.get(datasetId)!;
            return MongoDatasetCollection.find(
              {
                teamId,
                datasetId,
                tags: { $all: tagIds }
              },
              '_id',
              { ...readFromSecondary }
            ).lean();
          });

          const collectionsResults = await Promise.all(collectionsPromises);
          tagCollectionIdList = collectionsResults.flat().map((item) => String(item._id));
        } else if (uniqueAndTags.every((tag) => tag === null)) {
          const collections = await MongoDatasetCollection.find(
            {
              teamId,
              datasetId: { $in: datasetIds },
              $or: [{ tags: { $size: 0 } }, { tags: { $exists: false } }]
            },
            '_id',
            { ...readFromSecondary }
          ).lean();
          tagCollectionIdList = collections.map((item) => String(item._id));
        }
      } else if (orTags && orTags.length > 0) {
        // Get tagId by tag string
        const orTagArray = await MongoDatasetCollectionTags.find(
          {
            teamId,
            datasetId: { $in: datasetIds },
            tag: { $in: orTags.filter((tag) => tag !== null) }
          },
          '_id',
          { ...readFromSecondary }
        ).lean();
        const orTagIds = orTagArray.map((item) => String(item._id));

        // Get collections by tagId
        const collections = await MongoDatasetCollection.find(
          {
            teamId,
            datasetId: { $in: datasetIds },
            $or: [
              { tags: { $in: orTagIds } },
              ...(orTags.includes(null) ? [{ tags: { $size: 0 } }] : [])
            ]
          },
          '_id',
          { ...readFromSecondary }
        ).lean();

        tagCollectionIdList = collections.map((item) => String(item._id));
      }
    }

    // time
    const getCreateTime = jsonMatch?.createTime?.$gte as string | undefined;
    const lteCreateTime = jsonMatch?.createTime?.$lte as string | undefined;
    if (getCreateTime || lteCreateTime) {
      const collections = await MongoDatasetCollection.find(
        {
          teamId,
          datasetId: { $in: datasetIds },
          createTime: {
            ...(getCreateTime && { $gte: new Date(getCreateTime) }),
            ...(lteCreateTime && {
              $lte: new Date(lteCreateTime)
            })
          }
        },
        '_id'
      );
      createTimeCollectionIdList = collections.map((item) => String(item._id));
    }

    // collectionIds
    const inputCollectionIds = jsonMatch?.collectionIds as string[] | undefined;
    if (Array.isArray(inputCollectionIds) && inputCollectionIds.length > 0) {
      inputCollectionIdList = await getAllCollectionIds({
        parentCollectionIds: inputCollectionIds
      });
      if (inputCollectionIdList && inputCollectionIdList.length === 0) {
        return [];
      }
    }

    // Concat tag, time and collectionIds
    const collectionIds = computeFilterIntersection([
      tagCollectionIdList,
      createTimeCollectionIdList,
      inputCollectionIdList
    ]);

    return await getAllCollectionIds({
      parentCollectionIds: collectionIds
    });
  } catch {}
};
