import { Types } from '@fastgpt/service/common/mongo';
import { DatasetTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';
import { NextAPI } from '@/service/middleware/entry';
import { DatasetPermission } from '@fastgpt/global/support/permission/dataset/controller';
import {
  PerResourceTypeEnum,
  ReadPermissionVal
} from '@fastgpt/global/support/permission/constant';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { authDataset } from '@fastgpt/service/support/permission/dataset/auth';
import { replaceRegChars } from '@fastgpt/global/common/string/tools';
import { getGroupsByTmbId } from '@fastgpt/service/support/permission/memberGroup/controllers';
import { getOrgIdSetWithParentByTmbId } from '@fastgpt/service/support/permission/org/controllers';
import { addSourceMember } from '@fastgpt/service/support/user/utils';
import { getEmbeddingModel } from '@fastgpt/service/core/ai/model';
import { isPrivateResourceByCollaborators, sumPer } from '@fastgpt/global/support/permission/utils';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { buildFlattenedCollectionList } from '@fastgpt/service/core/dataset/collection/list/flatten';
import {
  GetDatasetListBodySchema,
  type GetDatasetListResponse
} from '@fastgpt/global/openapi/core/dataset/api';

async function handler(req: ApiRequestProps): Promise<GetDatasetListResponse> {
  const { parentId, type, searchKey } = parseApiInput({
    req,
    bodySchema: GetDatasetListBodySchema
  }).body;

  // Auth user permission
  const [{ tmbId, teamId, permission: teamPer }] = await Promise.all([
    authUserPer({
      req,
      authToken: true,
      authApiKey: true,
      per: ReadPermissionVal
    }),
    ...(parentId
      ? [
          authDataset({
            req,
            authToken: true,
            authApiKey: true,
            per: ReadPermissionVal,
            datasetId: parentId
          })
        ]
      : [])
  ]);

  // Get team all app permissions
  const [roleList, myGroupMap, myOrgSet] = await Promise.all([
    MongoResourcePermission.find({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: {
        $exists: true
      }
    }).lean(),
    getGroupsByTmbId({
      tmbId,
      teamId
    }).then((item) => {
      const map = new Map<string, 1>();
      item.forEach((item) => {
        map.set(String(item._id), 1);
      });
      return map;
    }),
    getOrgIdSetWithParentByTmbId({
      teamId,
      tmbId
    })
  ]);
  const roleListMap = new Map<string, (typeof roleList)[number][]>();
  roleList.forEach((item) => {
    const resourceId = String(item.resourceId);
    const list = roleListMap.get(resourceId) ?? [];
    list.push(item);
    roleListMap.set(resourceId, list);
  });
  const myRoles = roleList.filter(
    (item) =>
      String(item.tmbId) === String(tmbId) ||
      myGroupMap.has(String(item.groupId)) ||
      myOrgSet.has(String(item.orgId))
  );

  /**
   * 解析单个 Dataset 的有效权限（含继承），供可读集合计算与最终格式化复用。
   * - 继承态非 folder：有效 = 父级有效 + 自身（父 owner 透传降级由 DatasetPermission 语义处理）；
   * - 其余：有效 = 自身 clbs 解析。
   */
  const computePer = (dataset: {
    _id: unknown;
    parentId?: unknown;
    tmbId: unknown;
    type: unknown;
    inheritPermission: unknown;
  }) => {
    const getPer = (datasetId: string) => {
      const tmbRole = myRoles.find(
        (item) => String(item.resourceId) === datasetId && !!item.tmbId
      )?.permission;
      const groupAndOrgRole = sumPer(
        ...myRoles
          .filter(
            (item) => String(item.resourceId) === datasetId && (!!item.groupId || !!item.orgId)
          )
          .map((item) => item.permission)
      );
      return new DatasetPermission({
        role: tmbRole ?? groupAndOrgRole,
        isOwner: String(dataset.tmbId) === String(tmbId) || teamPer.isOwner
      });
    };
    // inherit
    if (dataset.inheritPermission && dataset.parentId && dataset.type !== DatasetTypeEnum.folder) {
      const resourceClbs = roleListMap.get(String(dataset._id)) ?? [];
      const parentClbs = roleListMap.get(String(dataset.parentId)) ?? [];

      return {
        Per: getPer(String(dataset.parentId)).addRole(getPer(String(dataset._id)).role),
        privateDataset: isPrivateResourceByCollaborators({
          resourceClbs,
          parentClbs,
          inheritPermission: true
        })
      };
    }
    const resourceClbs = roleListMap.get(String(dataset._id)) ?? [];

    return {
      Per: getPer(String(dataset._id)),
      privateDataset: isPrivateResourceByCollaborators({
        resourceClbs
      })
    };
  };

  // 候选：团队全部未删除 Dataset 的最小字段。平铺需完整层级（不可按 parentId 截断），
  // 否则无法发现无权限中间文件夹下用户有权限的 Dataset。
  const candidateDatasets = await MongoDataset.find(
    {
      teamId,
      deleteTime: null
    },
    '_id parentId tmbId type inheritPermission'
  ).lean();

  // 可读集合 R：有效权限 >= read 的 Dataset ID
  const readableIds = candidateDatasets
    .filter((dataset) => computePer(dataset).Per.hasReadPer)
    .map((dataset) => String(dataset._id));

  // 平铺：虚拟展示父级 -> 当前目录应展示的 Dataset ID。
  // 无权限中间文件夹下的可读 Dataset 提升到最近可读祖先展示，隐藏完整路径。
  const { visibleIdsByParentId } = buildFlattenedCollectionList(
    candidateDatasets,
    readableIds,
    parentId ?? null
  );
  const visibleIds = visibleIdsByParentId.get(parentId ?? '') ?? [];

  if (visibleIds.length === 0) return [];

  const searchMatch = searchKey
    ? {
        $or: [
          { name: { $regex: new RegExp(`${replaceRegChars(searchKey)}`, 'i') } },
          { intro: { $regex: new RegExp(`${replaceRegChars(searchKey)}`, 'i') } }
        ]
      }
    : {};

  // 对可见 ID 查询完整字段 + 类型/搜索过滤 + 排序。
  // 搜索仍限定当前可见范围（平铺结果），不允许删除范围做全局搜索再截断；
  // 不可加 parentId 条件——flatten 会把无权限中间 Folder 下的可读 Dataset 提升展示，
  // 其真实 parentId 可能指向不可见 Folder。
  const myDatasets = await MongoDataset.find({
    _id: { $in: visibleIds.map((id) => new Types.ObjectId(id)) },
    deleteTime: null,
    ...(type ? (Array.isArray(type) ? { type: { $in: type } } : { type }) : {}),
    ...searchMatch
  })
    .sort({
      updateTime: -1
    })
    .lean();

  const formatDatasets = myDatasets.map((dataset) => {
    const { Per, privateDataset } = computePer(dataset);

    return {
      _id: dataset._id,
      avatar: dataset.avatar,
      name: dataset.name,
      intro: dataset.intro,
      type: dataset.type,
      vectorModel: getEmbeddingModel(dataset.vectorModel),
      inheritPermission: dataset.inheritPermission,
      tmbId: dataset.tmbId,
      updateTime: dataset.updateTime,
      permission: Per,
      private: privateDataset
    };
  });

  return addSourceMember({
    list: formatDatasets
  });
}

export default NextAPI(handler);
