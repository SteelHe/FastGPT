import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import {
  createOrGetCollectionTags,
  getCollectionUpdateTime
} from '@fastgpt/service/core/dataset/collection/utils';
import {
  authDataset,
  authDatasetCollection
} from '@fastgpt/service/support/permission/dataset/auth';
import { NextAPI } from '@/service/middleware/entry';
import { WritePermissionVal } from '@fastgpt/global/support/permission/constant';
import { CommonErrEnum } from '@fastgpt/global/common/error/code/common';
import { type ApiRequestProps } from '@fastgpt/next/type';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { type ClientSession } from '@fastgpt/service/common/mongo';
import { type CollectionWithDatasetType } from '@fastgpt/global/core/dataset/type';
import { mongoSessionRun } from '@fastgpt/service/common/mongo/sessionRun';
import { addAuditLog } from '@fastgpt/service/support/user/audit/util';
import { AuditEventEnum } from '@fastgpt/global/support/user/audit/constants';
import { getI18nDatasetType } from '@fastgpt/service/support/user/audit/util';
import { UpdateDatasetCollectionBodySchema } from '@fastgpt/global/openapi/core/dataset/collection/api';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { checkMoveFolderDepth } from '@fastgpt/service/common/parentFolder/depth';
import { moveCollectionPermission } from '@fastgpt/service/support/permission/collection/move';

// Set folder collection children forbid status
const updateFolderChildrenForbid = async ({
  collection,
  forbid,
  session
}: {
  collection: CollectionWithDatasetType;
  forbid: boolean;
  session: ClientSession;
}) => {
  // 从 collection 作为 parent 进行递归查找，找到它所有 forbid 与它相同的 child
  const find = async (parentId: string): Promise<string[]> => {
    const children = await MongoDatasetCollection.find(
      {
        teamId: collection.teamId,
        datasetId: collection.datasetId,
        parentId
      },
      '_id',
      { session }
    );

    const idList = children.map((item) => String(item._id));

    const IdChildren = (await Promise.all(idList.map(find))).flat();

    return [...idList, ...IdChildren];
  };

  const allChildrenIdList = await find(collection._id);

  await MongoDatasetCollection.updateMany(
    {
      _id: { $in: allChildrenIdList }
    },
    {
      $set: {
        forbid
      }
    },
    {
      session
    }
  );
};

async function handler(req: ApiRequestProps) {
  const {
    datasetId,
    externalFileId,
    id: parsedCollectionId,
    parentId,
    name,
    tags,
    forbid,
    createTime,
    inheritPermission
  } = parseApiInput({ req, bodySchema: UpdateDatasetCollectionBodySchema }).body;
  let id = parsedCollectionId;

  // 通过 externalFileId 查找 collection：先鉴权 dataset，再查询
  if (datasetId && externalFileId) {
    await authDataset({
      req,
      authToken: true,
      authApiKey: true,
      datasetId,
      per: WritePermissionVal
    });

    const collection = await MongoDatasetCollection.findOne({ datasetId, externalFileId }, '_id');
    if (!collection) {
      return Promise.reject(CommonErrEnum.fileNotFound);
    }
    id = collection._id;
  }

  if (!id) {
    return Promise.reject(CommonErrEnum.missingParams);
  }

  // 凭证校验
  const { collection, teamId, tmbId } = await authDatasetCollection({
    req,
    authToken: true,
    authApiKey: true,
    collectionId: id,
    per: WritePermissionVal
  });

  // Move collection: parentId provided . Validate depth / cycle before transaction.
  const isMove = parentId !== undefined;
  if (isMove) {
    await checkMoveFolderDepth({
      resourceId: id,
      targetParentId: parentId,
      teamId: collection.teamId,
      model: MongoDatasetCollection,
      isFolderType: (type) => type === DatasetCollectionTypeEnum.folder
    });
  }

  await mongoSessionRun(async (session) => {
    const collectionTags = await createOrGetCollectionTags({
      tags,
      teamId,
      datasetId: collection.datasetId,
      session
    });

    if (isMove) {
      // Move：inheritPermission 默认 true 时继承新父级 clbs 并同步继承态子 Folder 快照；
      // 显式 false 时保持独立配置，仅更新 parentId。
      await moveCollectionPermission({
        collection: {
          _id: String(collection._id),
          type: collection.type,
          teamId: String(collection.teamId),
          parentId: collection.parentId ? String(collection.parentId) : null,
          datasetId: String(collection.datasetId),
          tmbId: String(collection.tmbId),
          inheritPermission: collection.inheritPermission
        },
        targetParentId: parentId,
        inheritPermission: inheritPermission !== false,
        session
      });
    }

    await MongoDatasetCollection.updateOne(
      {
        _id: id
      },
      {
        $set: {
          // parentId 在 move 分支由 moveCollectionPermission 更新，避免重复写入
          ...(!isMove && parentId !== undefined && { parentId: parentId || null }),
          ...(name && { name, updateTime: getCollectionUpdateTime({ name }) }),
          ...(collectionTags !== undefined && { tags: collectionTags }),
          ...(forbid !== undefined && { forbid }),
          ...(createTime !== undefined && { createTime }),
          ...(!isMove && inheritPermission !== undefined && { inheritPermission })
        }
      },
      {
        session
      }
    );

    // Folder update forbid
    if (collection.type === DatasetCollectionTypeEnum.folder && forbid !== undefined) {
      await updateFolderChildrenForbid({
        collection,
        forbid,
        session
      });
    }
  });

  (async () => {
    addAuditLog({
      tmbId,
      teamId,
      event: AuditEventEnum.UPDATE_COLLECTION,
      params: {
        collectionName: collection.name,
        datasetName: collection.dataset?.name || '',
        datasetType: getI18nDatasetType(collection.dataset?.type || '')
      }
    });
  })();
}

export default NextAPI(handler);
