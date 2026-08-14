import { describe, expect, it } from 'vitest';
import { Types } from '@fastgpt/service/common/mongo';
import { DatasetCollectionTypeEnum } from '@fastgpt/global/core/dataset/constants';
import {
  ManageRoleVal,
  NullRoleVal,
  OwnerRoleVal,
  PerResourceTypeEnum,
  ReadPermissionVal,
  ReadRoleVal,
  WritePermissionVal,
  WriteRoleVal
} from '@fastgpt/global/support/permission/constant';
import { Permission } from '@fastgpt/global/support/permission/controller';
import { sanitizeCollaboratorPermissions } from '@fastgpt/global/support/permission/utils';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { MongoMemberGroupModel } from '@fastgpt/service/support/permission/memberGroup/memberGroupSchema';
import { MongoGroupMemberModel } from '@fastgpt/service/support/permission/memberGroup/groupMemberSchema';
import { MongoOrgModel } from '@fastgpt/service/support/permission/org/orgSchema';
import { MongoOrgMemberModel } from '@fastgpt/service/support/permission/org/orgMemberSchema';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { resolveCollectionPermission } from '@fastgpt/service/support/permission/collection/resolvePermission';
import { getReadableCollectionIds } from '@fastgpt/service/support/permission/collection/readableCollection';
import { getFakeUsers } from '@test/datas/users';

const oid = () => new Types.ObjectId().toString();

describe('sanitizeCollaboratorPermissions ', () => {
  it('merges same-id collaborators with bitwise OR and keeps owner unchanged', () => {
    const tmbId = oid();
    const groupId = oid();
    const result = sanitizeCollaboratorPermissions([
      { tmbId, permission: 0b100 },
      { tmbId, permission: 0b010 }, // same id -> 0b110 -> lowest set bit 0b010
      { groupId, permission: OwnerRoleVal },
      { groupId, permission: 0b001 } // owner stays OwnerRoleVal
    ]);

    const tmb = result.find((clb) => clb.tmbId === tmbId)!;
    const group = result.find((clb) => clb.groupId === groupId)!;
    expect(result).toHaveLength(2);
    expect(tmb.permission).toBe(0b010); // 0b110 -> 0b010
    expect(group.permission).toBe(OwnerRoleVal); // owner unchanged
  });

  it('normalizes non-owner low-3 bits to the lowest set bit and keeps high bits', () => {
    const cases: Array<[number, number]> = [
      [0b011, 0b001], // manage|write -> manage
      [0b110, 0b010], // write|read -> write
      [0b111, 0b001], // all -> manage
      [0b100, 0b100], // read stays
      [0b1000 | 0b110, 0b1000 | 0b010], // high bits kept, low3 normalized
      [0, 0]
    ];
    for (const [input, expected] of cases) {
      const [result] = sanitizeCollaboratorPermissions([{ tmbId: oid(), permission: input }]);
      expect(result.permission).toBe(expected);
    }
  });
});

describe('resolveCollectionPermission ', () => {
  it('inherited non-folder collection merges parent Collection Folder snapshot permission', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const folderId = oid();
    const collectionId = oid();

    await MongoResourcePermission.insertMany([
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: folderId,
        tmbId: users.owner.tmbId,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: folderId,
        tmbId: users.members[0].tmbId,
        permission: ReadRoleVal
      }
    ]);

    const per = await resolveCollectionPermission({
      collection: {
        _id: collectionId,
        tmbId: users.owner.tmbId,
        parentId: folderId,
        inheritPermission: true,
        type: DatasetCollectionTypeEnum.file
      },
      tmbId: users.members[0].tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: NullRoleVal
    });

    expect(per).toBe(ReadRoleVal);
  });

  it('non-inherited collection ignores parent permission', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const folderId = oid();
    const collectionId = oid();

    // parent folder gives read to member1, but collection is non-inherited with no own record
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: folderId,
      tmbId: users.members[0].tmbId,
      permission: ReadRoleVal
    });

    const per = await resolveCollectionPermission({
      collection: {
        _id: collectionId,
        tmbId: users.owner.tmbId,
        parentId: folderId,
        inheritPermission: false,
        type: DatasetCollectionTypeEnum.file
      },
      tmbId: users.members[0].tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: ReadRoleVal
    });

    expect(per).toBe(NullRoleVal);
  });

  it('caps parent owner to manage (owner is not passed through)', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const folderId = oid();
    const collectionId = oid();

    // member1 is the parent folder owner; member1 has no record on the child collection
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: folderId,
      tmbId: users.members[0].tmbId,
      permission: OwnerRoleVal
    });

    const per = await resolveCollectionPermission({
      collection: {
        _id: collectionId,
        tmbId: users.owner.tmbId,
        parentId: folderId,
        inheritPermission: true,
        type: DatasetCollectionTypeEnum.file
      },
      tmbId: users.members[0].tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: NullRoleVal
    });

    expect(per).toBe(ManageRoleVal);
  });

  it('root-level inherited collection relies on datasetPermission', async () => {
    const users = await getFakeUsers(1);
    const collectionId = oid();

    const withDataset = await resolveCollectionPermission({
      collection: {
        _id: collectionId,
        tmbId: users.owner.tmbId,
        parentId: null,
        inheritPermission: true,
        type: DatasetCollectionTypeEnum.file
      },
      tmbId: users.members[0].tmbId,
      teamId: users.owner.teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: WriteRoleVal // write implies read
    });
    expect(withDataset).toBe(WriteRoleVal);

    const withoutDataset = await resolveCollectionPermission({
      collection: {
        _id: collectionId,
        tmbId: users.owner.tmbId,
        parentId: null,
        inheritPermission: true,
        type: DatasetCollectionTypeEnum.file
      },
      tmbId: users.members[0].tmbId,
      teamId: users.owner.teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: NullRoleVal
    });
    expect(withoutDataset).toBe(NullRoleVal);
  });

  it('merges group permission into the collection own permission', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const collectionId = oid();

    const group = await MongoMemberGroupModel.create({ teamId, name: 'g' });
    await MongoGroupMemberModel.create({
      groupId: group._id,
      tmbId: users.members[0].tmbId,
      role: 'member'
    });
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: collectionId,
      groupId: String(group._id),
      permission: ReadRoleVal
    });

    const per = await resolveCollectionPermission({
      collection: {
        _id: collectionId,
        tmbId: users.owner.tmbId,
        parentId: null,
        inheritPermission: false,
        type: DatasetCollectionTypeEnum.file
      },
      tmbId: users.members[0].tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: NullRoleVal
    });

    expect(per).toBe(ReadRoleVal);
  });

  it('merges org permission into the collection own permission (group/org 叠加)', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const collectionId = oid();

    const org = await MongoOrgModel.create({
      teamId,
      name: 'org',
      pathId: 'org-root',
      path: ''
    });
    await MongoOrgMemberModel.create({
      teamId,
      orgId: org._id,
      tmbId: users.members[0].tmbId
    });
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: collectionId,
      orgId: String(org._id),
      permission: WriteRoleVal
    });

    const per = await resolveCollectionPermission({
      collection: {
        _id: collectionId,
        tmbId: users.owner.tmbId,
        parentId: null,
        inheritPermission: false,
        type: DatasetCollectionTypeEnum.file
      },
      tmbId: users.members[0].tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: NullRoleVal
    });

    // write role value (0b010); a single record is not OR-ed with read
    expect(per).toBe(WriteRoleVal);
    const p = new Permission({ role: per });
    expect(p.checkPer(ReadPermissionVal)).toBe(true); // write implies read
    expect(p.checkPer(WritePermissionVal)).toBe(true);
  });

  it('overlays group and org permissions with bitwise OR (group/org 叠加)', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const collectionId = oid();

    const group = await MongoMemberGroupModel.create({ teamId, name: 'g' });
    await MongoGroupMemberModel.create({
      groupId: group._id,
      tmbId: users.members[0].tmbId,
      role: 'member'
    });
    const org = await MongoOrgModel.create({
      teamId,
      name: 'org',
      pathId: 'org-root',
      path: ''
    });
    await MongoOrgMemberModel.create({
      teamId,
      orgId: org._id,
      tmbId: users.members[0].tmbId
    });

    // group -> read, org -> write : merged = read | write
    await MongoResourcePermission.insertMany([
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: collectionId,
        groupId: String(group._id),
        permission: ReadRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: collectionId,
        orgId: String(org._id),
        permission: WriteRoleVal
      }
    ]);

    const per = await resolveCollectionPermission({
      collection: {
        _id: collectionId,
        tmbId: users.owner.tmbId,
        parentId: null,
        inheritPermission: false,
        type: DatasetCollectionTypeEnum.file
      },
      tmbId: users.members[0].tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: NullRoleVal
    });

    expect(per).toBe(ReadRoleVal | WriteRoleVal);
    // the merged role grants both read and write
    const p = new Permission({ role: per });
    expect(p.checkPer(ReadPermissionVal)).toBe(true);
    expect(p.checkPer(WritePermissionVal)).toBe(true);
  });
});

describe('getReadableCollectionIds ', () => {
  it('returns owner self-readable and inherited child via parent folder snapshot', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const folderId = oid();
    const childId = oid();
    const ownId = oid();

    await MongoResourcePermission.insertMany([
      // folder snapshot: owner + member1 read
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: folderId,
        tmbId: users.owner.tmbId,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: folderId,
        tmbId: users.members[0].tmbId,
        permission: ReadRoleVal
      },
      // member1 owns ownId directly
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: ownId,
        tmbId: users.members[0].tmbId,
        permission: OwnerRoleVal
      }
    ]);

    const collections = [
      {
        _id: folderId,
        tmbId: users.owner.tmbId,
        parentId: null,
        inheritPermission: true,
        type: DatasetCollectionTypeEnum.folder
      },
      {
        _id: childId,
        tmbId: users.owner.tmbId,
        parentId: folderId,
        inheritPermission: true,
        type: DatasetCollectionTypeEnum.file
      },
      {
        _id: ownId,
        tmbId: users.members[0].tmbId,
        parentId: null,
        inheritPermission: true,
        type: DatasetCollectionTypeEnum.file
      }
    ] as any;

    const readable = await getReadableCollectionIds({
      collections,
      tmbId: users.members[0].tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: NullRoleVal
    });

    expect(readable.sort()).toEqual([folderId, childId, ownId].sort());
  });

  it('root-level inherited collection readability depends on datasetPermission', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const rootId = oid();

    const collections = [
      {
        _id: rootId,
        tmbId: users.owner.tmbId,
        parentId: null,
        inheritPermission: true,
        type: DatasetCollectionTypeEnum.file
      }
    ] as any;

    const withRead = await getReadableCollectionIds({
      collections,
      tmbId: users.members[0].tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: ReadRoleVal
    });
    expect(withRead).toEqual([rootId]);

    const withoutRead = await getReadableCollectionIds({
      collections,
      tmbId: users.members[0].tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: NullRoleVal
    });
    expect(withoutRead).toEqual([]);
  });

  it('non-inherited folder without own record is not readable via parent', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const parentFolderId = oid();
    const privateFolderId = oid();

    // parent folder readable by member1; privateFolder (inheritPermission=false) has no record
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.collection,
      teamId,
      resourceId: parentFolderId,
      tmbId: users.members[0].tmbId,
      permission: ReadRoleVal
    });

    const collections = [
      {
        _id: parentFolderId,
        tmbId: users.owner.tmbId,
        parentId: null,
        inheritPermission: true,
        type: DatasetCollectionTypeEnum.folder
      },
      {
        _id: privateFolderId,
        tmbId: users.owner.tmbId,
        parentId: parentFolderId,
        inheritPermission: false,
        type: DatasetCollectionTypeEnum.folder
      }
    ] as any;

    const readable = await getReadableCollectionIds({
      collections,
      tmbId: users.members[0].tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: ReadRoleVal
    });

    expect(readable).toEqual([parentFolderId]);
  });

  it('short-circuits to all-readable when hasSetCollectionPermissions=false and dataset has read ', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const c1 = oid();
    const c2 = oid();

    // 无任何 Collection 权限记录（纯继承），仅依赖 Dataset 短路标记
    const collections = [
      {
        _id: c1,
        tmbId: users.owner.tmbId,
        parentId: null,
        inheritPermission: true,
        type: DatasetCollectionTypeEnum.file
      },
      {
        _id: c2,
        tmbId: users.members[0].tmbId,
        parentId: null,
        inheritPermission: true,
        type: DatasetCollectionTypeEnum.file
      }
    ] as any;

    // 普通成员 + Dataset read → 全部可读（无需任何 collection 权限记录）
    const withFlagAndRead = await getReadableCollectionIds({
      collections,
      tmbId: users.members[0].tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: ReadRoleVal,
      hasSetCollectionPermissions: false
    });
    expect(withFlagAndRead.sort()).toEqual([c1, c2].sort());

    // 普通成员 + 无 Dataset read → 空
    const withFlagNoRead = await getReadableCollectionIds({
      collections,
      tmbId: users.members[0].tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: NullRoleVal,
      hasSetCollectionPermissions: false
    });
    expect(withFlagNoRead).toEqual([]);

    // 未传 flag（默认 undefined=未知）→ 走完整解析：
    // 对根级继承 collection，完整解析同样基于 Dataset read 判可读（rootInheritedReadable），结果一致；
    // 对非继承（独立）collection，完整解析尊重独立配置（无自身记录则不可读）——undefined 不做短路是安全回退。
    const withoutFlag = await getReadableCollectionIds({
      collections,
      tmbId: users.members[0].tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: ReadRoleVal
    });
    expect(withoutFlag.sort()).toEqual([c1, c2].sort());

    const independentId = oid();
    const withoutFlagIndependent = await getReadableCollectionIds({
      collections: [
        {
          _id: independentId,
          tmbId: users.owner.tmbId,
          parentId: null,
          inheritPermission: false, // 非继承（独立配置），无自身记录
          type: DatasetCollectionTypeEnum.file
        }
      ] as any,
      tmbId: users.members[0].tmbId,
      teamId,
      groupIds: [],
      orgIds: [],
      datasetPermission: ReadRoleVal
    });
    expect(withoutFlagIndependent).toEqual([]);
  });
});
