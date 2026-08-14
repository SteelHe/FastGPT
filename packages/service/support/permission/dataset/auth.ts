import { type PermissionValueType } from '@fastgpt/global/support/permission/type';
import { getTmbPermission } from '../controller';
import {
  type CollectionWithDatasetType,
  type DatasetDataItemType,
  type DatasetSchemaType
} from '@fastgpt/global/core/dataset/type';
import { getTmbInfoByTmbId } from '../../user/team/controller';
import { MongoDataset } from '../../../core/dataset/schema';
import {
  ManageRoleVal,
  NullPermissionVal,
  NullRoleVal,
  OwnerRoleVal,
  PerResourceTypeEnum,
  ReadPermissionVal
} from '@fastgpt/global/support/permission/constant';
import { DatasetErrEnum } from '@fastgpt/global/common/error/code/dataset';
import { DatasetPermission } from '@fastgpt/global/support/permission/dataset/controller';
import { CollectionPermission } from '@fastgpt/global/support/permission/collection/controller';
import { resolveCollectionPermission } from '../collection/resolvePermission';
import { getCollectionWithDataset } from '../../../core/dataset/controller';
import { MongoDatasetData } from '../../../core/dataset/data/schema';
import { type AuthModeType, type AuthResponseType } from '../type';
import { DatasetTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { type ParentIdType } from '@fastgpt/global/common/parentFolder/type';
import { i18nT } from '@fastgpt/global/common/i18n/utils';
import { parseHeaderCert } from '../auth/common';
import { sumPer } from '@fastgpt/global/support/permission/utils';
import { getS3DatasetSource } from '../../../common/s3/sources/dataset';
import { isS3ObjectKey } from '../../../common/s3/utils';

export const authDatasetByTmbId = async ({
  tmbId,
  datasetId,
  per,
  isRoot = false
}: {
  tmbId: string;
  datasetId: string;
  per: PermissionValueType;
  isRoot?: boolean;
}): Promise<{
  dataset: DatasetSchemaType & {
    permission: DatasetPermission;
  };
}> => {
  const dataset = await (async () => {
    const [{ teamId, permission: tmbPer }, dataset] = await Promise.all([
      getTmbInfoByTmbId({ tmbId }),
      MongoDataset.findOne({ _id: datasetId }).lean()
    ]);

    if (!dataset) {
      return Promise.reject(DatasetErrEnum.unExist);
    }

    if (isRoot) {
      return {
        ...dataset,
        permission: new DatasetPermission({
          isOwner: true
        })
      };
    }

    if (String(dataset.teamId) !== teamId) {
      return Promise.reject(DatasetErrEnum.unAuthDataset);
    }

    const isOwner = tmbPer.isOwner || String(dataset.tmbId) === String(tmbId);
    const isGetParentClb =
      dataset.inheritPermission && dataset.type !== DatasetTypeEnum.folder && !!dataset.parentId;

    const [folderPer = NullRoleVal, myPer = NullRoleVal] = await Promise.all([
      isGetParentClb
        ? getTmbPermission({
            teamId,
            tmbId,
            resourceId: dataset.parentId!,
            resourceType: PerResourceTypeEnum.dataset
          })
        : NullRoleVal,
      getTmbPermission({
        teamId,
        tmbId,
        resourceId: datasetId,
        resourceType: PerResourceTypeEnum.dataset
      })
    ]);

    const Per = new DatasetPermission({ role: sumPer(folderPer, myPer), isOwner });

    if (!Per.checkPer(per)) {
      return Promise.reject(DatasetErrEnum.unAuthDataset);
    }

    return {
      ...dataset,
      permission: Per
    };
  })();

  return { dataset };
};

export const authDataset = async ({
  datasetId,
  per,
  ...props
}: AuthModeType & {
  datasetId: ParentIdType;
  per: PermissionValueType;
}): Promise<
  AuthResponseType & {
    dataset: DatasetSchemaType & {
      permission: DatasetPermission;
    };
  }
> => {
  const result = await parseHeaderCert(props);
  const { tmbId } = result;

  if (!datasetId) {
    return Promise.reject(DatasetErrEnum.unExist);
  }

  const { dataset } = await authDatasetByTmbId({
    tmbId,
    datasetId,
    per,
    isRoot: result.isRoot
  });

  return {
    ...result,
    permission: dataset.permission,
    dataset
  };
};

// 先校验 Dataset read 门槛，再按 Collection 维度解析有效权限并校验 per。
export async function authDatasetCollection({
  collectionId,
  per = NullPermissionVal,
  ...props
}: AuthModeType & {
  collectionId: string;
  isRoot?: boolean;
}): Promise<
  AuthResponseType<CollectionPermission> & {
    collection: CollectionWithDatasetType;
  }
> {
  const { teamId, tmbId, userId, isRoot: isRootFromHeader } = await parseHeaderCert(props);
  const collection = await getCollectionWithDataset(collectionId);

  if (!collection) {
    return Promise.reject(DatasetErrEnum.unExist);
  }

  // 1. Dataset read 门槛：Collection 权限不能绕过 Dataset 权限
  const { dataset } = await authDatasetByTmbId({
    tmbId,
    datasetId: collection.datasetId,
    per: ReadPermissionVal,
    isRoot: isRootFromHeader
  });

  // collection 与 dataset 必须属于同一团队；否则说明对象归属已经损坏，不能继续按 datasetId 授权。
  if (String(collection.teamId) !== String(dataset.teamId)) {
    return Promise.reject(DatasetErrEnum.unAuthDataset);
  }

  // 系统 root 用户：与 Dataset 级 isRoot 语义一致，跳过 Collection 级权限解析。
  if (isRootFromHeader) {
    return {
      userId,
      teamId,
      tmbId,
      collection,
      permission: new CollectionPermission({ isOwner: true }),
      isRoot: isRootFromHeader
    };
  }

  // 2. 团队 owner/admin 旁路（短路语义，Error-1 修复）：
  //    Dataset read 门槛已通过。团队 owner/admin 对该 Dataset 下所有 Collection 视为可读/管理，
  //    与 listV2 短路保持一致，避免「列表可见但点进去无权限」。
  //    该旁路不改变「仅 collection 权限不能绕过 Dataset read」门槛：必须先通过上面第 1 步。
  const tmbInfo = await getTmbInfoByTmbId({ tmbId });
  const isTeamOwnerOrAdmin =
    String(tmbInfo.teamId) === String(teamId) &&
    (tmbInfo.permission.isOwner || tmbInfo.permission.hasManagePer);

  // 3. 短路：Dataset 显式 `hasSetCollectionPermissions=false`（纯继承）→
  //    Collection 有效权限直接等于 Dataset 有效权限（父 owner 不透传，cap 为 manage）。
  //    对普通成员：`dataset.permission.role` 即其 Dataset 有效角色（不可能是 owner），
  //    与 `resolveCollectionPermission`（父级贡献 + 自身 owner 记录，纯继承时仅 owner 记录）
  //    结果完全一致；collection owner（创建者）额外获得 owner。
  //    仅 Collection 权限仍不能绕过上面第 1 步的 Dataset read 门槛。
  //    注意：仅**显式 false** 触发短路；旧数据字段缺失（undefined）视为未知，走完整解析，
  //    避免对已存在的非继承态 Collection 错误放行（正确性优先，迁移后统一为显式 false）。
  const flagSetCollectionPermissions = dataset.hasSetCollectionPermissions;

  // 4. Collection 维度解析：自身 clbs + 父级贡献（folder 快照 / 根级 Dataset），
  //    父级 owner 至多映射为 manage。
  let role: PermissionValueType;
  if (isTeamOwnerOrAdmin) {
    role = ManageRoleVal;
  } else if (flagSetCollectionPermissions === false) {
    const isCollectionOwner = String(collection.tmbId) === String(tmbId);
    const datasetRole = dataset.permission.role;
    role =
      datasetRole === OwnerRoleVal ? ManageRoleVal : isCollectionOwner ? OwnerRoleVal : datasetRole;
  } else {
    role = await resolveCollectionPermission({
      collection,
      tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: dataset.permission.role
    });
  }

  const isOwner = String(collection.tmbId) === String(tmbId);

  const permission = new CollectionPermission({
    role,
    isOwner
  });

  if (!permission.checkPer(per)) {
    return Promise.reject(DatasetErrEnum.unAuthDatasetCollection);
  }

  return {
    userId,
    teamId,
    tmbId,
    collection,
    permission,
    isRoot: isRootFromHeader
  };
}

/*
  DatasetData permission is inherited from collection.
*/
export async function authDatasetData({
  dataId,
  ...props
}: AuthModeType & {
  dataId: string;
}) {
  // get mongo dataset.data
  const datasetData = await MongoDatasetData.findById(dataId);

  if (!datasetData) {
    return Promise.reject(i18nT('common:core.dataset.error.Data not found'));
  }

  const result = await authDatasetCollection({
    ...props,
    collectionId: datasetData.collectionId
  });

  const data: DatasetDataItemType = {
    id: String(datasetData._id),
    teamId: datasetData.teamId,
    updateTime: datasetData.updateTime,
    q: datasetData.q,
    a: datasetData.a,
    imageId: datasetData.imageId,
    imagePreivewUrl:
      datasetData.imageId && isS3ObjectKey(datasetData.imageId, 'dataset')
        ? (
            await getS3DatasetSource().createGetDatasetFileURL({
              key: datasetData.imageId,
              expiredHours: 1,
              external: true
            })
          ).url
        : undefined,
    chunkIndex: datasetData.chunkIndex,
    indexes: datasetData.indexes,
    datasetId: String(datasetData.datasetId),
    collectionId: String(datasetData.collectionId),
    metadata: datasetData.metadata,
    sourceName: result.collection.name || '',
    sourceId: result.collection?.fileId || result.collection?.rawLink,
    isOwner: String(datasetData.tmbId) === String(result.tmbId)
    // permission: result.permission
  };

  return {
    ...result,
    datasetData: data,
    collection: result.collection
  };
}
