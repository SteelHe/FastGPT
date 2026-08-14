import { Types } from '@fastgpt/service/common/mongo';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { authDataset } from '@fastgpt/service/support/permission/dataset/auth';
import { NextAPI } from '@/service/middleware/entry';
import { ReadPermissionVal } from '@fastgpt/global/support/permission/constant';
import { readFromSecondary } from '@fastgpt/service/common/mongo/utils';
import { collectionTagsToTagLabel } from '@fastgpt/service/core/dataset/collection/utils';
import { MongoDatasetData } from '@fastgpt/service/core/dataset/data/schema';
import { MongoDatasetTraining } from '@fastgpt/service/core/dataset/training/schema';
import { replaceRegChars } from '@fastgpt/global/common/string/tools';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import {
  activeTrainingExpr,
  finalErrorTrainingExpr,
  getSlowestTrainingStatus,
  remainingTrainingMatch,
  trainingModeRanks
} from '@fastgpt/service/core/dataset/training/query';
import {
  CollectionTrainingStatusEnum,
  type TrainingModeEnum
} from '@fastgpt/global/core/dataset/constants';
import {
  ListCollectionV2BodySchema,
  ListCollectionV2ResponseSchema,
  type ListCollectionV2ResponseType
} from '@fastgpt/global/openapi/core/dataset/collection/api';
import { buildFlattenedCollectionList } from '@fastgpt/service/core/dataset/collection/list/flatten';
import { getReadableCollectionIds } from '@fastgpt/service/support/permission/collection/readableCollection';
import type { CollectionPermissionItemType } from '@fastgpt/service/support/permission/collection/type';
import { getGroupsByTmbId } from '@fastgpt/service/support/permission/memberGroup/controllers';
import { getOrgIdSetWithParentByTmbId } from '@fastgpt/service/support/permission/org/controllers';

const defaultCollectionTrainingStatus = {
  trainingAmount: 0,
  activeTrainingAmount: 0,
  finalErrorAmount: 0,
  hasError: false,
  slowestTrainingStatus: CollectionTrainingStatusEnum.ready
};

type TrainingAmountAggregateItem = {
  _id: string;
  trainingAmount: number;
  activeTrainingAmount: number;
  finalErrorAmount: number;
  modeCounts: {
    mode: TrainingModeEnum;
    activeCount: number;
    finalErrorCount: number;
  }[];
};

const formatTrainingStatus = (item?: TrainingAmountAggregateItem) => {
  if (!item) return defaultCollectionTrainingStatus;

  const { slowestTrainingMode, slowestTrainingStatus } = getSlowestTrainingStatus(
    Object.fromEntries(
      item.modeCounts.map(({ mode, activeCount, finalErrorCount }) => [
        mode,
        { activeCount, finalErrorCount }
      ])
    )
  );

  return {
    trainingAmount: item.trainingAmount,
    activeTrainingAmount: item.activeTrainingAmount,
    finalErrorAmount: item.finalErrorAmount,
    hasError: item.finalErrorAmount > 0,
    slowestTrainingMode,
    slowestTrainingStatus
  };
};

/**
 * 解析当前用户对当前 Dataset 下 Collection 的可读集合（短路规则）：
 * - 团队管理员/所有者：已通过 Dataset read 前置鉴权，直接视为全部可读；
 * - Dataset 无 Collection 自定义权限（hasSetCollectionPermissions=false）：
 *   全部 Collection 纯继承，直接复用 Dataset 有效权限生成可读 ID，O(1) 短路；
 * - 全部 Collection 均为继承态：复用 Dataset 有效权限（read 已通过），直接生成可读 ID；
 * - 存在非继承态：对非继承态单独解析，继承态复用父级结果（getReadableCollectionIds 内部处理）。
 */
const resolveReadableCollectionIds = async ({
  collections,
  tmbId,
  teamId,
  isOwner,
  datasetRole,
  hasSetCollectionPermissions
}: {
  collections: CollectionPermissionItemType[];
  tmbId: string;
  teamId: string;
  isOwner: boolean;
  datasetRole: number;
  hasSetCollectionPermissions?: boolean;
}): Promise<string[]> => {
  if (collections.length === 0) return [];

  if (isOwner) {
    // 团队管理员 / 团队所有者短路：直接全部可读，仍按当前目录/平铺/分页返回
    return collections.map((item) => String(item._id));
  }

  if (hasSetCollectionPermissions === false) {
    // 短路：无任何 Collection 自定义权限 → 每个 Collection 有效权限 = Dataset 有效权限，
    // Dataset read 前置鉴权已通过，全部 Collection 可读（含 folder 快照与 Dataset 链镜像一致）。
    return collections.map((item) => String(item._id));
  }

  const allInherited = collections.every((item) => item.inheritPermission !== false);
  if (allInherited) {
    // 全继承态短路：Dataset read 前置鉴权已通过，普通 Collection 直接复用 Dataset 有效权限，
    // Collection Folder 使用已同步权限快照，逐条解析降为一次。
    return collections.map((item) => String(item._id));
  }

  // 存在非继承态：批量解析（$in 批量加载权限，无 N+1）
  const [groupIds, orgIds] = await Promise.all([
    getGroupsByTmbId({ tmbId, teamId }).then((list) => list.map((item) => String(item._id))),
    getOrgIdSetWithParentByTmbId({ teamId, tmbId })
  ]);
  return getReadableCollectionIds({
    collections,
    tmbId,
    teamId,
    groupIds,
    orgIds: Array.from(orgIds),
    datasetPermission: datasetRole
  });
};

async function handler(req: ApiRequestProps): Promise<ListCollectionV2ResponseType> {
  const {
    datasetId,
    parentId,
    searchText: rawSearchText,
    selectFolder,
    filterTags,
    simple,
    pageSize: rawPageSize,
    offset: rawOffset,
    pageNum: rawPageNum
  } = parseApiInput({ req, bodySchema: ListCollectionV2BodySchema }).body;
  const pageSize = Math.min(Number(rawPageSize ?? 10), 100);
  const offset =
    rawOffset !== undefined ? Number(rawOffset) : (Number(rawPageNum ?? 1) - 1) * pageSize;
  const searchText = rawSearchText?.replace(/'/g, '');

  // auth dataset and get my role（Dataset read 前置门槛）
  const { teamId, tmbId, permission, dataset } = await authDataset({
    req,
    authToken: true,
    authApiKey: true,
    datasetId,
    per: ReadPermissionVal
  });

  // 阶段一：以 datasetId 为边界读取该 Dataset 下全部 Collection 的最小权限/层级字段
  // （根目录不得仅 parentId=null，否则发现不了隐藏 Folder 下可读文件；
  //   第二阶段才读取完整字段与统计，避免首查加载大字段）
  const collections = await MongoDatasetCollection.find(
    {
      teamId: new Types.ObjectId(teamId),
      datasetId: new Types.ObjectId(datasetId)
    },
    undefined,
    { ...readFromSecondary }
  )
    .select({
      _id: 1,
      parentId: 1,
      tmbId: 1,
      type: 1,
      inheritPermission: 1,
      name: 1, // 用于内存 searchText 过滤（当前路径搜索）
      tags: 1 // 用于内存 filterTags 过滤
    })
    .lean();

  const permissionItems: CollectionPermissionItemType[] = collections.map((item) => ({
    _id: String(item._id),
    tmbId: String(item.tmbId),
    parentId: item.parentId ? String(item.parentId) : null,
    inheritPermission: item.inheritPermission,
    type: item.type
  }));

  // 批量解析可读 ID 集合 R（短路：团队 owner / 无 Collection 自定义权限 / 全继承态 / 非继承态批量解析）
  const readableIds = await resolveReadableCollectionIds({
    collections: permissionItems,
    tmbId,
    teamId,
    isOwner: permission.isOwner,
    datasetRole: permission.role,
    hasSetCollectionPermissions: dataset.hasSetCollectionPermissions
  });

  // 内存构建平铺层级，得到当前目录展示节点 visibleIds
  const { visibleIdsByParentId } = buildFlattenedCollectionList(
    permissionItems,
    readableIds,
    parentId ?? null
  );
  let visibleIds = visibleIdsByParentId.get(parentId ?? '') ?? [];

  // 当前路径限定搜索 + 展示过滤（searchText 只匹配当前 parentId 下的 collection，
  // 不删除 parentId 作用域做全局搜索；不可读节点已在可读集合阶段剔除）
  if (searchText || selectFolder || filterTags.length) {
    const idToItem = new Map(collections.map((item) => [String(item._id), item]));
    const nameRegex = searchText ? new RegExp(replaceRegChars(searchText), 'i') : null;
    visibleIds = visibleIds.filter((id) => {
      const item = idToItem.get(id);
      if (!item) return false;
      if (selectFolder && item.type !== DatasetCollectionTypeEnum.folder) return false;
      if (filterTags.length && !item.tags?.some((tag) => filterTags.includes(tag))) return false;
      if (nameRegex && !nameRegex.test(item.name)) return false;
      return true;
    });
  }
  // total = 过滤后当前目录展示节点数（visibleIds.length），不是 countDocuments(match) 原始数
  const total = visibleIds.length;

  if (visibleIds.length === 0) {
    return ListCollectionV2ResponseSchema.parse({ list: [], total: 0 });
  }

  const selectField = {
    _id: 1,
    parentId: 1,
    tmbId: 1,
    name: 1,
    type: 1,
    forbid: 1,
    createTime: 1,
    updateTime: 1,
    trainingType: 1,
    fileId: 1,
    rawLink: 1,
    tags: 1,
    externalFileId: 1
  };

  // 阶段二：仅对当前目录可见 ID 回查完整字段，由 MongoDB 排序 + skip/limit 分页
  const pageCollections = await MongoDatasetCollection.find(
    { _id: { $in: visibleIds.map((id) => new Types.ObjectId(id)) } },
    undefined,
    { ...readFromSecondary }
  )
    .select(selectField)
    .sort({ updateTime: -1 })
    .skip(offset)
    .limit(pageSize)
    .lean();

  // not count data amount
  if (simple) {
    return ListCollectionV2ResponseSchema.parse({
      list: await Promise.all(
        pageCollections.map(async (item) => ({
          ...item,
          tags: await collectionTagsToTagLabel({
            datasetId,
            tags: item.tags
          }),
          dataAmount: 0,
          ...defaultCollectionTrainingStatus,
          permission
        }))
      ),
      total
    });
  }

  const collectionIds = pageCollections.map((item) => new Types.ObjectId(item._id));

  // Compute data amount（仅当前页 ≤ pageSize 条）
  const [trainingAmount, dataAmount]: [
    TrainingAmountAggregateItem[],
    { _id: string; count: number }[]
  ] = await Promise.all([
    MongoDatasetTraining.aggregate(
      [
        {
          $match: {
            teamId: new Types.ObjectId(teamId),
            datasetId: new Types.ObjectId(datasetId),
            collectionId: { $in: collectionIds },
            ...remainingTrainingMatch
          }
        },
        {
          $addFields: {
            modeRank: {
              $switch: {
                branches: trainingModeRanks.map(({ mode, rank }) => ({
                  case: { $eq: ['$mode', mode] },
                  then: rank
                })),
                default: 999
              }
            },
            isActiveTraining: activeTrainingExpr,
            isFinalErrorTraining: finalErrorTrainingExpr
          }
        },
        {
          $group: {
            _id: '$collectionId',
            trainingAmount: { $sum: 1 },
            activeTrainingAmount: { $sum: { $cond: ['$isActiveTraining', 1, 0] } },
            finalErrorAmount: { $sum: { $cond: ['$isFinalErrorTraining', 1, 0] } },
            modeCounts: {
              $push: {
                mode: '$mode',
                modeRank: '$modeRank',
                activeCount: { $cond: ['$isActiveTraining', 1, 0] },
                finalErrorCount: { $cond: ['$isFinalErrorTraining', 1, 0] }
              }
            }
          }
        },
        { $unwind: '$modeCounts' },
        {
          $group: {
            _id: {
              collectionId: '$_id',
              mode: '$modeCounts.mode',
              modeRank: '$modeCounts.modeRank'
            },
            trainingAmount: { $first: '$trainingAmount' },
            activeTrainingAmount: { $first: '$activeTrainingAmount' },
            finalErrorAmount: { $first: '$finalErrorAmount' },
            activeCount: { $sum: '$modeCounts.activeCount' },
            finalErrorCount: { $sum: '$modeCounts.finalErrorCount' }
          }
        },
        {
          $sort: {
            '_id.collectionId': 1,
            '_id.modeRank': 1
          }
        },
        {
          $group: {
            _id: '$_id.collectionId',
            trainingAmount: { $first: '$trainingAmount' },
            activeTrainingAmount: { $first: '$activeTrainingAmount' },
            finalErrorAmount: { $first: '$finalErrorAmount' },
            modeCounts: {
              $push: {
                mode: '$_id.mode',
                activeCount: '$activeCount',
                finalErrorCount: '$finalErrorCount'
              }
            }
          }
        }
      ],
      {
        ...readFromSecondary
      }
    ),
    MongoDatasetData.aggregate(
      [
        {
          $match: {
            teamId: new Types.ObjectId(teamId),
            datasetId: new Types.ObjectId(datasetId),
            collectionId: { $in: collectionIds }
          }
        },
        {
          $group: {
            _id: '$collectionId',
            count: { $sum: 1 }
          }
        }
      ],
      {
        ...readFromSecondary
      }
    )
  ]);

  const list = await Promise.all(
    pageCollections.map(async (item) => ({
      ...item,
      tags: await collectionTagsToTagLabel({
        datasetId,
        tags: item.tags
      }),
      dataAmount: dataAmount.find((amount) => String(amount._id) === String(item._id))?.count || 0,
      ...formatTrainingStatus(
        trainingAmount.find((amount) => String(amount._id) === String(item._id))
      ),
      permission
    }))
  );

  // count collections
  return ListCollectionV2ResponseSchema.parse({ list, total });
}

export default NextAPI(handler);
