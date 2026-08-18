/**
 * 平铺结果：
 * - `visibleIdsByParentId`：展示父级（虚拟 parentId，`null` 用空字符串 `''` 表示 Dataset 根目录）
 *   -> 该展示父级下应展示的 Collection ID 数组。
 * - `total`：入参 `targetParentId` 对应的展示节点数（`visibleIdsByParentId.get(targetParentId)?.length`）。
 */
export type FlattenResult = {
  visibleIdsByParentId: Map<string, string[]>;
  total: number;
};

/** 平铺函数所需的节点最小字段：仅读取 `_id` 与 `parentId`，Dataset 与 Collection 均可复用。 */
export type FlattenItemType = {
  _id: unknown;
  /** schema 中为可选字段，函数内通过 truthiness 归一化（缺省视为根）。 */
  parentId?: unknown;
};

type FlattenNode = {
  id: string;
  parentId: string | null;
  readable: boolean;
  children: FlattenNode[];
};

/** Dataset 根目录在 `visibleIdsByParentId` 中的 key（真实 ObjectId 不可能为空字符串）。 */
const ROOT_KEY = '';

/**
 * 内存构建平铺层级（自顶向下一次遍历、O(N)）：
 * - 输入为当前范围内的**全部**节点（含不可读节点）与已解析的可读 ID 集合 R；
 * - 维护“最近可读祖先” `nearestVisible`，初始为根（null）；
 * - 可读节点：展示父级 = `nearestVisible`，随后以自身作为其子节点的 `nearestVisible`；
 * - 不可读节点：不参与展示，其下可读子孙提升到当前的 `nearestVisible`，跳过无权限中间 Folder；
 * - 每个节点只被访问一次，不随目录深度退化为 O(N × D)，也无需向上逐级回溯。
 *
 * 返回结果不暴露不可见父级的路径/名称；`_id` 映射基于 `String()` 归一化。
 */
export function buildFlattenedCollectionList(
  collections: FlattenItemType[],
  readableIds: string[],
  targetParentId: string | null
): FlattenResult {
  const readableSet = new Set(readableIds.map(String));

  // 1. 建立 _id -> node 映射
  const nodeMap = new Map<string, FlattenNode>();
  for (const item of collections) {
    const node: FlattenNode = {
      id: String(item._id),
      parentId: item.parentId ? String(item.parentId) : null,
      readable: readableSet.has(String(item._id)),
      children: []
    };
    nodeMap.set(node.id, node);
  }

  // 2. 建立 parentId -> children 映射；parentId 不在候选集（孤儿）或为空的节点挂到根
  const rootNodes: FlattenNode[] = [];
  for (const item of collections) {
    const node = nodeMap.get(String(item._id))!;
    const parentId = item.parentId ? String(item.parentId) : null;
    if (parentId && nodeMap.has(parentId)) {
      nodeMap.get(parentId)!.children.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  // 3. 自顶向下一次遍历，传播 nearestVisible
  const visibleIdsByParentId = new Map<string, string[]>();
  const stack: Array<{ node: FlattenNode; nearestVisible: string | null }> = rootNodes.map(
    (node) => ({
      node,
      nearestVisible: null
    })
  );

  while (stack.length) {
    const { node, nearestVisible } = stack.pop()!;
    if (node.readable) {
      const key = nearestVisible ?? ROOT_KEY;
      const list = visibleIdsByParentId.get(key) ?? [];
      list.push(node.id);
      visibleIdsByParentId.set(key, list);
      // 可读节点自身成为其子节点的最近可读祖先
      for (const child of node.children) {
        stack.push({ node: child, nearestVisible: node.id });
      }
    } else {
      // 不可读节点跳过，但继续向下遍历其子节点，nearestVisible 不变
      for (const child of node.children) {
        stack.push({ node: child, nearestVisible });
      }
    }
  }

  const targetKey = targetParentId ?? ROOT_KEY;
  return {
    visibleIdsByParentId,
    total: visibleIdsByParentId.get(targetKey)?.length ?? 0
  };
}
