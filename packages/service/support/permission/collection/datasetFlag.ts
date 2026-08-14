import { MongoDataset } from '../../../core/dataset/schema';
import type { ClientSession } from '../../../common/mongo';

/**
 * Mark a Dataset as "has configured Collection-level permissions"。
 *
 * 语义：`datasets.hasSetCollectionPermissions = true` 表示该 Dataset 下至少一个 Collection
 * 配置了独立/自定义权限（非继承 / 追加协作者 / 独立 move）。collection 级鉴权短路依赖
 * `false`（纯继承，可直接复用 Dataset 有效权限），因此**任何**产生 Collection 自定义权限的
 * 写操作都必须调用本函数，保证短路前提成立。
 *
 * 单向置位（只增不减）：不提供置回 `false` 的路径。stale `true` 只损失短路优化、不损失
 * 正确性（完整 Collection 解析仍正确）；`false` 时的短路则依赖"无任何自定义"这一前提，
 * 因此置 `true` 必须保守覆盖所有自定义路径。
 */
export const markDatasetCollectionPermissionsSet = ({
  datasetId,
  session
}: {
  datasetId: string;
  session?: ClientSession;
}) => {
  return MongoDataset.updateOne(
    { _id: datasetId, hasSetCollectionPermissions: { $ne: true } },
    { $set: { hasSetCollectionPermissions: true } },
    ...(session ? [{ session }] : [])
  );
};
