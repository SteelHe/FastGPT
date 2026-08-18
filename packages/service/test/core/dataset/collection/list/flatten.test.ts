import { describe, expect, it } from 'vitest';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import type { CollectionPermissionItemType } from '@fastgpt/service/support/permission/collection/auth';
import { buildFlattenedCollectionList } from '@fastgpt/service/core/dataset/collection/list/flatten';

/** 构建一个最小权限字段的 Collection 节点。 */
const c = (
  id: string,
  parentId: string | null = null,
  type: DatasetCollectionTypeEnum = DatasetCollectionTypeEnum.file
): CollectionPermissionItemType => ({
  _id: id,
  tmbId: `tmb-${id}`,
  parentId,
  inheritPermission: true,
  type
});

const ids = (map: Map<string, string[]>, key: string | null) =>
  [...(map.get(key ?? '') ?? [])].sort();
const expectIds = (map: Map<string, string[]>, key: string | null, expected: string[]) => {
  expect(ids(map, key)).toEqual([...expected].sort());
};

describe('buildFlattenedCollectionList ', () => {
  it('LF-001 root list: readable C1 kept, unreadable C2 dropped, total = filtered count', () => {
    const collections = [c('C1'), c('C2')];
    const result = buildFlattenedCollectionList(collections, ['C1'], null);
    expect(result.total).toBe(1);
    expectIds(result.visibleIdsByParentId, null, ['C1']);
  });

  it('LF-002 unreadable Folder F with readable child C: C flattened to root, F not exposed', () => {
    const collections = [c('F', null, DatasetCollectionTypeEnum.folder), c('C', 'F')];
    const result = buildFlattenedCollectionList(collections, ['C'], null);
    expect(result.total).toBe(1);
    expectIds(result.visibleIdsByParentId, null, ['C']);
    // F 不可读，不作为任何展示父级出现，也不出现在任何列表中
    expect(result.visibleIdsByParentId.has('F')).toBe(false);
  });

  it('LF-003 / example: children of a readable Folder belong to that Folder, not root', () => {
    // Folder A（无权限）含 C1、C2；Folder B（有权限）含 C3；根下有 C4
    const collections = [
      c('A', null, DatasetCollectionTypeEnum.folder),
      c('C1', 'A'),
      c('C2', 'A'),
      c('B', null, DatasetCollectionTypeEnum.folder),
      c('C3', 'B'),
      c('C4')
    ];
    // 可读集合 R = { Folder B, C1, C2, C3, C4 }
    const readable = ['B', 'C1', 'C2', 'C3', 'C4'];
    const rootResult = buildFlattenedCollectionList(collections, readable, null);
    expect(rootResult.total).toBe(4);
    expectIds(rootResult.visibleIdsByParentId, null, ['B', 'C1', 'C2', 'C4']);
    // C3 属于 Folder B 的下级，不计入根目录
    expect(ids(rootResult.visibleIdsByParentId, null)).not.toContain('C3');
    // A 不可读，不作为展示父级
    expect(rootResult.visibleIdsByParentId.has('A')).toBe(false);

    // 进入 Folder B：total = 仅 B 的直接展示节点（C3）
    const bResult = buildFlattenedCollectionList(collections, readable, 'B');
    expect(bResult.total).toBe(1);
    expectIds(bResult.visibleIdsByParentId, 'B', ['C3']);
  });

  it('deeply nested unreadable folders: readable descendant promoted to nearest visible (root)', () => {
    const collections = [
      c('A', null, DatasetCollectionTypeEnum.folder),
      c('A1', 'A', DatasetCollectionTypeEnum.folder),
      c('C', 'A1')
    ];
    const result = buildFlattenedCollectionList(collections, ['C'], null);
    expect(result.total).toBe(1);
    expectIds(result.visibleIdsByParentId, null, ['C']);
  });

  it('readable Folder under unreadable Folder: Folder shown at root, its child under the Folder', () => {
    const collections = [
      c('A', null, DatasetCollectionTypeEnum.folder),
      c('B', 'A', DatasetCollectionTypeEnum.folder),
      c('C', 'B')
    ];
    const readable = ['B', 'C'];
    const rootResult = buildFlattenedCollectionList(collections, readable, null);
    expect(rootResult.total).toBe(1);
    expectIds(rootResult.visibleIdsByParentId, null, ['B']);
    expectIds(rootResult.visibleIdsByParentId, 'B', ['C']);
  });

  it('targetParentId = unreadable Folder: nothing displayed there (empty list)', () => {
    const collections = [c('A', null, DatasetCollectionTypeEnum.folder), c('C', 'A')];
    const result = buildFlattenedCollectionList(collections, ['C'], 'A');
    expect(result.total).toBe(0);
    expect(result.visibleIdsByParentId.has('A')).toBe(false);
  });

  it('empty input returns total 0 and no display parents', () => {
    const result = buildFlattenedCollectionList([], [], null);
    expect(result.total).toBe(0);
    expect(result.visibleIdsByParentId.size).toBe(0);
  });

  it('all collections readable keeps the natural hierarchy', () => {
    const collections = [c('B', null, DatasetCollectionTypeEnum.folder), c('C', 'B'), c('D')];
    const result = buildFlattenedCollectionList(collections, ['B', 'C', 'D'], null);
    expect(result.total).toBe(2); // B, D
    expectIds(result.visibleIdsByParentId, null, ['B', 'D']);
    expectIds(result.visibleIdsByParentId, 'B', ['C']);
  });

  it('orphan nodes (parentId not in candidate set) are treated as root', () => {
    const collections = [c('C', 'MISSING_PARENT'), c('D')];
    const result = buildFlattenedCollectionList(collections, ['C', 'D'], null);
    expect(result.total).toBe(2);
    expectIds(result.visibleIdsByParentId, null, ['C', 'D']);
  });

  it('multiple readable children of an unreadable Folder are all flattened to root', () => {
    const collections = [
      c('A', null, DatasetCollectionTypeEnum.folder),
      c('C1', 'A'),
      c('C2', 'A'),
      c('C3', 'A')
    ];
    const result = buildFlattenedCollectionList(collections, ['C1', 'C2', 'C3'], null);
    expect(result.total).toBe(3);
    expectIds(result.visibleIdsByParentId, null, ['C1', 'C2', 'C3']);
    expect(result.visibleIdsByParentId.has('A')).toBe(false);
  });

  it('unreadable root sibling Folder does not affect other folders (isolation)', () => {
    const collections = [
      c('A', null, DatasetCollectionTypeEnum.folder),
      c('AC', 'A'),
      c('B', null, DatasetCollectionTypeEnum.folder),
      c('BC', 'B')
    ];
    // A 不可读（AC 可读被平铺到根），B 可读（BC 挂在 B 下）
    const readable = ['AC', 'B', 'BC'];
    const rootResult = buildFlattenedCollectionList(collections, readable, null);
    expect(rootResult.total).toBe(2); // AC, B
    expectIds(rootResult.visibleIdsByParentId, null, ['AC', 'B']);
    expectIds(rootResult.visibleIdsByParentId, 'B', ['BC']);
  });
});
