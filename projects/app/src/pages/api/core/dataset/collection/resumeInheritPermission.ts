import type { ApiRequestProps } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { authDatasetCollection } from '@fastgpt/service/support/permission/dataset/auth';
import { resumeCollectionInheritPermission } from '@fastgpt/service/support/permission/collection/collaborator';
import { ManagePermissionVal } from '@fastgpt/global/support/permission/constant';
import {
  ResumeCollectionInheritPermissionBodySchema,
  type ResumeCollectionInheritPermissionBodyType
} from '@fastgpt/global/openapi/core/dataset/collection/api';

/**
 * 恢复 Collection 继承权限。
 * Route: POST /api/core/dataset/collection/resumeInheritPermission
 * Auth: Collection manage
 * - 非 folder：置 inheritPermission=true，不写快照（后续动态合并）。
 * - folder：读取父级（Dataset 有效权限或父 Collection Folder 快照）clbs，
 *   owner→manage 映射 + 自身 owner 重建快照，同步继承态子 folder，置 inheritPermission=true。
 * - 非继承态子 Collection / Collection Folder 不被覆盖。
 */

async function handler(req: ApiRequestProps<ResumeCollectionInheritPermissionBodyType>) {
  const { collectionId } = ResumeCollectionInheritPermissionBodySchema.parse(req.body);

  const { teamId, collection } = await authDatasetCollection({
    req,
    authToken: true,
    collectionId,
    per: ManagePermissionVal
  });

  await resumeCollectionInheritPermission({ collection, teamId });
}

export default NextAPI(handler);
