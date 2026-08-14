import { Types } from '@fastgpt/service/common/mongo';
import { DatasetCollectionTypeEnum, DatasetTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';

export const oid = () => new Types.ObjectId().toString();

export const createDataset = async ({
  teamId,
  tmbId,
  name,
  type = DatasetTypeEnum.dataset,
  parentId,
  inheritPermission = true
}: {
  teamId: string;
  tmbId: string;
  name: string;
  type?: DatasetTypeEnum;
  parentId?: string;
  inheritPermission?: boolean;
}) =>
  MongoDataset.create({
    teamId,
    tmbId,
    name,
    type,
    ...(parentId ? { parentId } : {}),
    inheritPermission
  });

export const createCollection = async ({
  teamId,
  tmbId,
  datasetId,
  parentId,
  type = DatasetCollectionTypeEnum.file,
  inheritPermission = true,
  name
}: {
  teamId: string;
  tmbId: string;
  datasetId: string;
  parentId?: string;
  type?: DatasetCollectionTypeEnum;
  inheritPermission?: boolean;
  name?: string;
}) => {
  const collection = await MongoDatasetCollection.create({
    teamId,
    tmbId,
    datasetId,
    parentId: parentId ?? null,
    type,
    name: name ?? `col-${Date.now()}-${Math.random()}`,
    inheritPermission
  });
  // 镜像生产语义（createCollectionPermission）：独立态 → 所属 Dataset 标记已配置 Collection 权限
  if (inheritPermission === false) {
    await MongoDataset.updateOne(
      { _id: datasetId, hasSetCollectionPermissions: { $ne: true } },
      { $set: { hasSetCollectionPermissions: true } }
    );
  }
  return collection;
};

export const addDatasetClb = ({
  teamId,
  resourceId,
  tmbId,
  permission
}: {
  teamId: string;
  resourceId: string;
  tmbId: string;
  permission: number;
}) =>
  MongoResourcePermission.create({
    resourceType: PerResourceTypeEnum.dataset,
    teamId,
    resourceId,
    tmbId,
    permission
  });

export const addCollectionClb = async ({
  teamId,
  resourceId,
  tmbId,
  permission
}: {
  teamId: string;
  resourceId: string;
  tmbId: string;
  permission: number;
}) => {
  const result = await MongoResourcePermission.create({
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId,
    tmbId,
    permission
  });
  // 镜像生产语义（collection 协作者更新，走通用 updateResourceCollaborators）：配置 collection 协作者 → 所属 Dataset 标记已配置
  const collection = await MongoDatasetCollection.findById(resourceId, 'datasetId').lean();
  if (collection?.datasetId) {
    await MongoDataset.updateOne(
      { _id: collection.datasetId, hasSetCollectionPermissions: { $ne: true } },
      { $set: { hasSetCollectionPermissions: true } }
    );
  }
  return result;
};

/** resourceId -> { collaboratorId -> permission } of its resource_permissions. */
export const snapshotMap = async (teamId: string, resourceId: string) => {
  const clbs = await MongoResourcePermission.find({
    resourceType: PerResourceTypeEnum.collection,
    teamId,
    resourceId
  }).lean();
  return new Map(
    clbs.map((clb) => [String(clb.tmbId ?? clb.groupId ?? clb.orgId), clb.permission])
  );
};

export const datasetSnapshotMap = async (teamId: string, resourceId: string) => {
  const clbs = await MongoResourcePermission.find({
    resourceType: PerResourceTypeEnum.dataset,
    teamId,
    resourceId
  }).lean();
  return new Map(
    clbs.map((clb) => [String(clb.tmbId ?? clb.groupId ?? clb.orgId), clb.permission])
  );
};
