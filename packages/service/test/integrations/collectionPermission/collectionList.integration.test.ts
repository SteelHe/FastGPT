import { describe, expect, it } from 'vitest';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { DatasetErrEnum } from '@fastgpt/global/common/error/code/dataset';
import {
  OwnerRoleVal,
  PerResourceTypeEnum,
  ReadPermissionVal,
  ReadRoleVal
} from '@fastgpt/global/support/permission/constant';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { authDatasetCollection } from '@fastgpt/service/support/permission/dataset/auth';
import { getReadableCollectionIds } from '@fastgpt/service/support/permission/collection/readableCollection';
import { buildFlattenedCollectionList } from '@fastgpt/service/core/dataset/collection/list/flatten';
import { filterDatasetsByTmbId } from '@fastgpt/service/core/dataset/utils';
import { replaceRegChars } from '@fastgpt/global/common/string/tools';
import { parseParentIdInMongo } from '@fastgpt/global/common/parentFolder/utils';
import { getFakeUsers } from '@test/datas/users';
import { createCollection, createDataset } from './helpers';

/**
 * 集成场景（跨能力链路，真实 MongoDB）：
 * - 场景 6：文件列表过滤（C1 可读 / C2 不可读）→ list 仅返回 C1
 * - 场景 7：文件夹穿透（F 不可见、F 下 C 可读）→ C 平铺展示，不暴露 F 完整路径
 * - 场景 8：知识库门槛（无 Dataset read、有 C read）→ detail/list/search 全部拒绝/不展示
 * - 场景 9：当前路径搜索（A 下 D1、B 下 D2，searchKey+parentId=A）→ 仅返回 D1
 */
const TIMEOUT = 60_000;

describe('scenario 6: file list filtered by collection permission', () => {
  it(
    'list only returns the readable collection (C1) and drops the unreadable one (C2)',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const ownerTmb = String(users.owner.tmbId);
      const m1 = String(users.members[0].tmbId);

      const dataset = await createDataset({ teamId, tmbId: ownerTmb, name: 'D1' });
      const datasetId = String(dataset._id);
      const c1 = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId,
        name: 'c1',
        inheritPermission: false
      });
      const c2 = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId,
        name: 'c2',
        inheritPermission: false
      });

      // dataset read gate passes; only c1 is readable at the collection level
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: datasetId,
        tmbId: m1,
        permission: ReadRoleVal
      });
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(c1._id),
        tmbId: m1,
        permission: ReadRoleVal
      });

      const collections = [
        {
          _id: String(c1._id),
          tmbId: ownerTmb,
          parentId: null,
          inheritPermission: false,
          type: DatasetCollectionTypeEnum.file
        },
        {
          _id: String(c2._id),
          tmbId: ownerTmb,
          parentId: null,
          inheritPermission: false,
          type: DatasetCollectionTypeEnum.file
        }
      ];

      const readableIds = await getReadableCollectionIds({
        collections,
        tmbId: m1,
        teamId,
        groupIds: [],
        orgIds: [],
        datasetPermission: ReadRoleVal
      });

      expect(readableIds).toEqual([String(c1._id)]);

      const { visibleIdsByParentId, total } = buildFlattenedCollectionList(
        collections,
        readableIds,
        null
      );
      expect(visibleIdsByParentId.get('')).toEqual([String(c1._id)]);
      expect(total).toBe(1);
    },
    TIMEOUT
  );
});

describe('scenario 7: folder penetration flattens a readable child under an unreadable folder', () => {
  it(
    'C under unreadable F is shown at the dataset root; F is not exposed',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const ownerTmb = String(users.owner.tmbId);
      const m1 = String(users.members[0].tmbId);

      const dataset = await createDataset({ teamId, tmbId: ownerTmb, name: 'D1' });
      const datasetId = String(dataset._id);
      const f = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId,
        type: DatasetCollectionTypeEnum.folder,
        name: 'hidden-F'
      });
      const c = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId,
        type: DatasetCollectionTypeEnum.file,
        parentId: String(f._id),
        name: 'c',
        inheritPermission: false
      });

      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: datasetId,
        tmbId: m1,
        permission: ReadRoleVal
      });
      // c has its own read record; F has none -> F not readable
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(c._id),
        tmbId: m1,
        permission: ReadRoleVal
      });

      const collections = [
        {
          _id: String(f._id),
          tmbId: ownerTmb,
          parentId: null,
          inheritPermission: true,
          type: DatasetCollectionTypeEnum.folder
        },
        {
          _id: String(c._id),
          tmbId: ownerTmb,
          parentId: String(f._id),
          inheritPermission: false,
          type: DatasetCollectionTypeEnum.file
        }
      ];

      const readableIds = await getReadableCollectionIds({
        collections,
        tmbId: m1,
        teamId,
        groupIds: [],
        orgIds: [],
        datasetPermission: ReadRoleVal
      });
      expect(readableIds).toEqual([String(c._id)]);

      const { visibleIdsByParentId } = buildFlattenedCollectionList(collections, readableIds, null);
      // C flattened to the dataset root; F is not present anywhere
      expect(visibleIdsByParentId.get('')).toEqual([String(c._id)]);
      const allVisible = Array.from(visibleIdsByParentId.values()).flat();
      expect(allVisible).not.toContain(String(f._id));

      // the real parentId in DB is unchanged (flattening is virtual, no path leak)
      const realCDoc = await MongoDatasetCollection.findById(c._id).lean();
      expect(String(realCDoc?.parentId)).toBe(String(f._id));
    },
    TIMEOUT
  );
});

describe('scenario 8: knowledge base gate — collection permission cannot bypass dataset read', () => {
  it(
    'detail auth rejects and list/search resolve to empty when the user has no dataset read',
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const ownerTmb = String(users.owner.tmbId);
      const m1 = String(users.members[0].tmbId);

      const dataset = await createDataset({
        teamId,
        tmbId: ownerTmb,
        name: 'D1',
        inheritPermission: false
      });
      const datasetId = String(dataset._id);
      const c1 = await createCollection({
        teamId,
        tmbId: ownerTmb,
        datasetId,
        name: 'c1',
        inheritPermission: false
      });

      // only collection read, no dataset read
      await MongoResourcePermission.create({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(c1._id),
        tmbId: m1,
        permission: ReadRoleVal
      });

      // detail / single-collection auth: rejected at the dataset gate
      await expect(
        authDatasetCollection({
          req: { auth: users.members[0] } as any,
          authToken: true,
          collectionId: String(c1._id),
          per: ReadPermissionVal
        })
      ).rejects.toBe(DatasetErrEnum.unAuthDataset);

      // NOTE: the shared batch resolver getReadableCollectionIds does NOT itself apply the
      // dataset gate (listV2/authDatasetCollection gate upstream). So a
      // non-inherited collection with an own read record still resolves as "collection readable";
      // the dataset is hidden by the caller's authDataset gate, verified above.

      // search / RAG 路径：Dataset read 门槛由**调用方预过滤**（`filterDatasetsByTmbId` /
      // `authDataset`）在传入 `resolveReadableCollectionIds` 前排除无 read 的 Dataset。
      // `resolveReadableCollectionIds` 信任调用方传入的 datasetIds，不再重复鉴权——此处单独调用
      // 会返回 c1（c1 有自身 collection read 记录）。真正的知识库门槛在上游：
      const filteredDatasets = await filterDatasetsByTmbId({ datasetIds: [datasetId], tmbId: m1 });
      expect(filteredDatasets).toEqual([]); // 无 dataset read → dataset 被预过滤排除
    },
    TIMEOUT
  );
});

describe('scenario 9: current-path scoped search on the dataset list', () => {
  it(
    "searchKey='test' with parentId=A returns only D1 (under A), not D2 (under B)",
    async () => {
      const users = await getFakeUsers(1);
      const teamId = users.owner.teamId;
      const ownerTmb = String(users.owner.tmbId);

      const a = await createDataset({ teamId, tmbId: ownerTmb, name: 'A' });
      const b = await createDataset({ teamId, tmbId: ownerTmb, name: 'B' });
      const d1 = await createDataset({
        teamId,
        tmbId: ownerTmb,
        name: 'test-A',
        parentId: String(a._id)
      });
      const d2 = await createDataset({
        teamId,
        tmbId: ownerTmb,
        name: 'test-B',
        parentId: String(b._id)
      });
      const d3 = await createDataset({
        teamId,
        tmbId: ownerTmb,
        name: 'other',
        parentId: String(a._id)
      });

      // dataset/list search query shape: { teamId, ...parseParentIdInMongo(parentId), deleteTime: null, ...searchMatch }
      const searchKey = 'test';
      const searchMatch = {
        $or: [
          { name: { $regex: new RegExp(`${replaceRegChars(searchKey)}`, 'i') } },
          { intro: { $regex: new RegExp(`${replaceRegChars(searchKey)}`, 'i') } }
        ]
      };
      const scopedQuery = {
        teamId,
        ...parseParentIdInMongo(String(a._id)),
        deleteTime: null,
        ...searchMatch
      };
      const hits = await MongoDataset.find(scopedQuery).lean();
      const hitIds = hits.map((h) => String(h._id));

      // only D1 under A matches; D2 under B is out of scope, D3 does not match the key
      expect(hitIds).toEqual([String(d1._id)]);

      // contrast: without the parentId scope, D2 would also match (proving the scope matters)
      const globalQuery = { teamId, deleteTime: null, ...searchMatch };
      const globalHits = await MongoDataset.find(globalQuery).lean();
      expect(globalHits.map((h) => String(h._id)).sort()).toEqual(
        [String(d1._id), String(d2._id)].sort()
      );
    },
    TIMEOUT
  );
});
