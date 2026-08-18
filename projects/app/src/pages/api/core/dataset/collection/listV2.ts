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
import {
  canShortCircuitCollectionPermission,
  getReadableCollectionIds
} from '@fastgpt/service/support/permission/collection/readableCollection';
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

/** 列表回查的完整字段（两阶段路径与短路路径共用）。 */
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
 * 解析当前用户对当前 Dataset 下 Collection 的可读集合。
 *
 * 调用方已通过 `canShortCircuitCollectionPermission` 判定（非团队 owner/admin、Dataset 已
 * 配置过 Collection 权限），此处仅剩真子集场景：批量加载 group/org 后逐条判定可读性
 * （`$in` 批量加载权限，无 N+1）。owner / 纯继承 / 全继承短路已由调用方前置处理，不再重复。
 */
const resolveReadableCollectionIds = async ({
  collections,
  tmbId,
  teamId,
  datasetRole
}: {
  collections: CollectionPermissionItemType[];
  tmbId: string;
  teamId: string;
  datasetRole: number;
}): Promise<string[]> => {
  if (collections.length === 0) return [];

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
  const { teamId, tmbId, permission } = await authDataset({
    req,
    authToken: true,
    authApiKey: true,
    datasetId,
    per: ReadPermissionVal
  });

  // 短路判定：团队 owner/admin 或纯继承（hasSetCollectionPermissions=false）→
  // 无需逐 collection 权限解析，直接按原流程在当前目录 DB 过滤（性能优）。
  const canShortCircuit = await canShortCircuitCollectionPermission({
    teamId,
    datasetIds: [datasetId],
    tmbId
  });

  // 响应构建（短路 DB 路径与两阶段路径共用）
  const buildListResponse = async (pageCollections: any[], total: number) => {
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
        dataAmount:
          dataAmount.find((amount) => String(amount._id) === String(item._id))?.count || 0,
        ...formatTrainingStatus(
          trainingAmount.find((amount) => String(amount._id) === String(item._id))
        ),
        permission
      }))
    );

    return ListCollectionV2ResponseSchema.parse({ list, total });
  };

  // 短路路径：按当前目录（parentId）+ 搜索/标签/类型在 DB 直接过滤（原流程，性能优）。
  if (canShortCircuit) {
    const match: Record<string, unknown> = {
      teamId: new Types.ObjectId(teamId),
      datasetId: new Types.ObjectId(datasetId),
      parentId: parentId ? new Types.ObjectId(parentId) : null
    };
    if (selectFolder) match.type = DatasetCollectionTypeEnum.folder;
    if (filterTags.length) match.tags = { $in: filterTags };
    if (searchText) match.name = { $regex: replaceRegChars(searchText), $options: 'i' };

    const total = await MongoDatasetCollection.countDocuments(match, { ...readFromSecondary });
    if (total === 0) {
      return ListCollectionV2ResponseSchema.parse({ list: [], total: 0 });
    }
    const pageCollections = await MongoDatasetCollection.find(match, undefined, {
      ...readFromSecondary
    })
      .select(selectField)
      .sort({ updateTime: -1 })
      .skip(offset)
      .limit(pageSize)
      .lean();

    return buildListResponse(pageCollections, total);
  }

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
      inheritPermission: 1
    })
    .lean();

  const permissionItems: CollectionPermissionItemType[] = collections.map((item) => ({
    _id: String(item._id),
    tmbId: String(item.tmbId),
    parentId: item.parentId ? String(item.parentId) : null,
    inheritPermission: item.inheritPermission,
    type: item.type
  }));

  // 批量解析可读 ID 集合 R（owner / 纯继承短路已由 canShortCircuitCollectionPermission 前置处理）
  const readableIds = await resolveReadableCollectionIds({
    collections: permissionItems,
    tmbId,
    teamId,
    datasetRole: permission.role
  });

  // 内存构建平铺层级，得到当前目录展示节点 visibleIds
  const { visibleIdsByParentId } = buildFlattenedCollectionList(
    permissionItems,
    readableIds,
    parentId ?? null
  );
  const visibleIds = visibleIdsByParentId.get(parentId ?? '') ?? [];

  if (visibleIds.length === 0) {
    return ListCollectionV2ResponseSchema.parse({ list: [], total: 0 });
  }

  // 阶段二：对当前目录可见 ID 在 DB 直接做搜索/标签/类型过滤 + 排序 + skip/limit 分页。
  // searchText 仍限定当前 parentId 作用域（不可读节点已在可读集合阶段剔除）。
  // 注意：不能额外加 parentId 条件——flatten 会把不可读中间 Folder 下的可读文件提升到
  // 最近可读祖先展示，其真实 parentId 可能指向不可见 Folder，加条件会漏掉这些节点。
  const match: Record<string, unknown> = {
    _id: { $in: visibleIds.map((id) => new Types.ObjectId(id)) }
  };
  if (selectFolder) match.type = DatasetCollectionTypeEnum.folder;
  if (filterTags.length) match.tags = { $in: filterTags };
  if (searchText) match.name = { $regex: replaceRegChars(searchText), $options: 'i' };

  const total = await MongoDatasetCollection.countDocuments(match, { ...readFromSecondary });
  if (total === 0) {
    return ListCollectionV2ResponseSchema.parse({ list: [], total: 0 });
  }

  const pageCollections = await MongoDatasetCollection.find(match, undefined, {
    ...readFromSecondary
  })
    .select(selectField)
    .sort({ updateTime: -1 })
    .skip(offset)
    .limit(pageSize)
    .lean();

  return buildListResponse(pageCollections, total);
}
export default NextAPI(handler);
