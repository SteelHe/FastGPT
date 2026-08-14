import {
  ManageRoleVal,
  NullRoleVal,
  OwnerRoleVal,
  PerResourceTypeEnum
} from '@fastgpt/global/support/permission/constant';
import type { PermissionValueType } from '@fastgpt/global/support/permission/type';
import { sumPer } from '@fastgpt/global/support/permission/utils';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { getTmbPermission } from '../controller';
import type { CollectionPermissionItemType } from './type';

/**
 * Resolve the effective permission of a single Collection for a team member
 * (single-resource rule used by auth / create / update / collaborator ops).
 *
 * ```
 * resolveCollectionPermission(collection, tmbId):
 *   # 1. 父级有效权限
 *   # folder 资源使用已同步的权限快照，不在鉴权时动态向上递归
 *   if inheritPermission == true 且 type != folder:
 *       parentEffective = parentId 非空
 *           ? getTmbPermission(父 Collection Folder 快照)
 *           : datasetPermission   // 根级 Collection，父级为所属 Dataset
 *   else:
 *       parentEffective = 0
 *   # 2. 父级 owner 位封顶为 manage（不透传 owner）
 *   parentContribution = parentEffective == OwnerRoleVal ? ManageRoleVal : parentEffective
 *   # 3. 自身 clbs
 *   myPer = getTmbPermission(collection)
 *   # 4. 合并
 *   return sumPer(parentContribution, myPer)
 * ```
 *
 * `groupIds` / `orgIds` are part of the stable interface contract so batch
 * callers can pass pre-computed member scopes; the current single-resource
 * path resolves them internally via `getTmbPermission`.
 */
export async function resolveCollectionPermission({
  collection,
  tmbId,
  teamId,
  groupIds,
  orgIds,
  datasetPermission
}: {
  collection: CollectionPermissionItemType;
  tmbId: string;
  teamId: string;
  groupIds: string[];
  orgIds: string[];
  /** 调用方已解析的 Dataset 有效角色（role 位掩码），用于根级继承态 Collection。 */
  datasetPermission: PermissionValueType;
}): Promise<PermissionValueType> {
  const isFolder = collection.type === DatasetCollectionTypeEnum.folder;

  // 1. 父级有效权限
  let parentEffective = NullRoleVal;
  if (collection.inheritPermission !== false && !isFolder) {
    if (collection.parentId) {
      // 父级是 Collection Folder：读取其已同步权限快照（folder 自身 clbs 即完整有效权限）
      const parentPer = await getTmbPermission({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        tmbId,
        resourceId: String(collection.parentId)
      });
      parentEffective = parentPer ?? NullRoleVal;
    } else {
      // 根级 Collection：父级为所属 Dataset 的有效角色
      parentEffective = datasetPermission ?? NullRoleVal;
    }
  }

  // 2. 父级 owner 位封顶为 manage（不透传 owner）
  const parentContribution = parentEffective === OwnerRoleVal ? ManageRoleVal : parentEffective;

  // 3. 自身 clbs
  const myPer =
    (await getTmbPermission({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      tmbId,
      resourceId: String(collection._id)
    })) ?? NullRoleVal;

  // 4. 合并
  return sumPer(parentContribution, myPer) ?? NullRoleVal;
}
