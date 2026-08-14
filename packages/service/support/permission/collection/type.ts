import type { DatasetCollectionSchemaType } from '@fastgpt/global/core/dataset/type';

/**
 * The minimal fields of a `dataset_collections` document that are required to
 * resolve collection-level permissions.
 */
export type CollectionPermissionItemType = Pick<
  DatasetCollectionSchemaType,
  '_id' | 'tmbId' | 'parentId' | 'inheritPermission' | 'type'
>;
