import { AppFolderTypeList, AppTypeEnum } from '@fastgpt/global/core/app/constants';
import { DatasetCollectionTypeEnum, DatasetTypeEnum } from '@fastgpt/global/core/dataset/constants';
import {
  ManageRoleVal,
  OwnerRoleVal,
  PerResourceTypeEnum,
  ReadRoleVal,
  WriteRoleVal
} from '@fastgpt/global/support/permission/constant';
import { Types } from '@fastgpt/service/common/mongo';
import { mongoSessionRun } from '@fastgpt/service/common/mongo/sessionRun';
import { MongoApp } from '@fastgpt/service/core/app/schema';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { MongoDatasetCollection } from '@fastgpt/service/core/dataset/collection/schema';
import { createResourceDefaultCollaborators } from '@fastgpt/service/support/permission/controller';
import {
  syncChildrenPermission,
  syncCollaborators
} from '@fastgpt/service/support/permission/inheritPermission';
import { syncDatasetCollectionFolders } from '@fastgpt/service/support/permission/collection/folderSync';
import { MongoResourcePermission } from '@fastgpt/service/support/permission/schema';
import { getFakeUsers } from '@test/datas/users';
import type { parseHeaderCertRet } from '@test/mocks/request';
import { describe, it, expect } from 'vitest';

describe.sequential('syncChildrenPermission', () => {
  const createApp = async ({
    user,
    name,
    type,
    parentId
  }: {
    user: parseHeaderCertRet;
    name: string;
    type: AppTypeEnum;
    parentId?: string;
  }) =>
    mongoSessionRun(async (session) => {
      const app = await MongoApp.create({
        teamId: user.teamId,
        tmbId: user.tmbId,
        ...(parentId ? { parentId } : {}),
        name,
        type,
        inheritPermission: true
      });
      if (type === 'folder') {
        await createResourceDefaultCollaborators({
          resource: app,
          resourceType: PerResourceTypeEnum.app,
          session,
          tmbId: String(user.tmbId)
        });
      }
      return app;
    });

  it('sync: add/update/delete clbs', async () => {
    const users = await getFakeUsers(5);
    const f1 = await createApp({
      user: users.owner,
      name: 'f1',
      type: AppTypeEnum.folder
    });
    const f2 = await createApp({
      user: users.owner,
      name: 'f2',
      type: AppTypeEnum.folder,
      parentId: String(f1._id)
    });
    expect(
      await MongoResourcePermission.countDocuments({
        resourceType: 'app'
      })
    ).eq(2);
    const clbs = [
      {
        tmbId: String(users.owner.tmbId),
        permission: OwnerRoleVal
      },
      {
        tmbId: String(users.members[0].tmbId),
        permission: ReadRoleVal
      },
      {
        tmbId: users.members[1].tmbId,
        permission: ReadRoleVal
      }
    ];

    await mongoSessionRun(async (session) => {
      await syncChildrenPermission({
        collaborators: clbs,
        folderTypeList: AppFolderTypeList,
        resource: f1,
        resourceModel: MongoApp,
        resourceType: PerResourceTypeEnum.app,
        session
      });
      await MongoResourcePermission.insertOne({
        resourceId: f1._id,
        resourceType: PerResourceTypeEnum.app,
        permission: ReadRoleVal,
        tmbId: users.members[0].tmbId,
        teamId: users.members[0].teamId,
        session
      });
      await MongoResourcePermission.insertOne({
        resourceId: f1._id,
        resourceType: PerResourceTypeEnum.app,
        permission: ReadRoleVal,
        tmbId: users.members[1].tmbId,
        teamId: users.members[1].teamId,
        session
      });
    });

    expect(
      await MongoResourcePermission.countDocuments({
        resourceType: 'app'
      })
    ).eq(6);

    const f3 = await createApp({
      name: 'f3',
      user: users.owner,
      type: AppTypeEnum.folder,
      parentId: String(f2._id)
    });

    await mongoSessionRun(async (session) => {
      await syncChildrenPermission({
        collaborators: clbs,
        folderTypeList: AppFolderTypeList,
        resource: f3,
        resourceModel: MongoApp,
        resourceType: PerResourceTypeEnum.app,
        session
      });
    });

    expect(
      await MongoResourcePermission.countDocuments({
        resourceType: 'app'
      })
    ).eq(9);

    const a1 = await createApp({
      name: 'a1',
      user: users.owner,
      type: AppTypeEnum.simple,
      parentId: String(f3._id)
    });

    await mongoSessionRun(async (session) => {
      await syncChildrenPermission({
        collaborators: clbs,
        folderTypeList: AppFolderTypeList,
        resource: a1,
        resourceModel: MongoApp,
        resourceType: PerResourceTypeEnum.app,
        session
      });
    });

    expect(
      await MongoResourcePermission.countDocuments({
        resourceType: 'app'
      })
    ).eq(9);

    // update
    await mongoSessionRun(async (session) => {
      const clbs = [
        {
          tmbId: String(users.owner.tmbId),
          permission: OwnerRoleVal
        },
        {
          tmbId: String(users.members[0].tmbId),
          permission: ReadRoleVal
        },
        {
          tmbId: String(users.members[1].tmbId),
          permission: ManageRoleVal
        }
      ];
      await syncChildrenPermission({
        collaborators: clbs,
        folderTypeList: AppFolderTypeList,
        resource: f1,
        resourceModel: MongoApp,
        resourceType: PerResourceTypeEnum.app,
        session
      });

      await MongoResourcePermission.updateOne(
        {
          resourceType: PerResourceTypeEnum.app,
          resourceId: String(f1._id),
          tmbId: String(users.members[1].tmbId)
        },
        {
          permission: ManageRoleVal
        }
      );
    });

    // console.log(await MongoResourcePermission.find({ resourceType: 'app' }));

    expect(
      await MongoResourcePermission.countDocuments({
        resourceType: 'app'
      })
    ).eq(9);

    // delete
    await mongoSessionRun(async (session) => {
      const clbs = [
        {
          tmbId: String(users.owner.tmbId),
          permission: OwnerRoleVal
        },
        {
          tmbId: String(users.members[0].tmbId),
          permission: ReadRoleVal
        }
      ];
      await syncChildrenPermission({
        collaborators: clbs,
        folderTypeList: AppFolderTypeList,
        resource: f1,
        resourceModel: MongoApp,
        resourceType: PerResourceTypeEnum.app,
        session
      });

      await MongoResourcePermission.deleteOne(
        {
          resourceType: PerResourceTypeEnum.app,
          resourceId: String(f1._id),
          tmbId: String(users.members[1].tmbId),
          team: String(users.members[1].teamId)
        },
        { session }
      );
    });

    expect(
      await MongoResourcePermission.countDocuments({
        resourceType: 'app'
      })
    ).eq(8);
  });
});

/* =====================================================================
 * sync primitives gap coverage (design doc )
 * - syncCollaborators maps the parent owner to manage (value assertion);
 * - syncChildrenPermission upgrades a child folder collaborator with bitwise OR;
 * - Collection Folder snapshot sync propagates removals and upgrades to children.
 * ===================================================================== */
describe.sequential('syncCollaborators parent-owner downgrade ', () => {
  it('maps the parent owner to manage and keeps the child own owner', async () => {
    const users = await getFakeUsers(2);
    const teamId = users.owner.teamId;
    const parentOwner = String(users.members[0].tmbId); // different owner from the child
    const childOwner = String(users.owner.tmbId);
    const readMember = String(users.members[1].tmbId);
    const datasetId = new Types.ObjectId().toString();

    // child dataset owns its own owner record only
    await MongoResourcePermission.create({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: datasetId,
      tmbId: childOwner,
      permission: OwnerRoleVal
    });

    const parentClbs = [
      { tmbId: parentOwner, permission: OwnerRoleVal },
      { tmbId: readMember, permission: ReadRoleVal }
    ];
    await mongoSessionRun(async (session) => {
      await syncCollaborators({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: datasetId,
        collaborators: parentClbs,
        session
      });
    });

    const clbs = await MongoResourcePermission.find({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: datasetId
    }).lean();
    const byId = new Map(clbs.map((c) => [String(c.tmbId ?? c.groupId ?? c.orgId), c.permission]));
    expect(byId.get(childOwner)).toBe(OwnerRoleVal); // own owner preserved
    expect(byId.get(parentOwner)).toBe(ManageRoleVal); // parent owner downgraded
    expect(byId.get(readMember)).toBe(ReadRoleVal);
  });
});

describe.sequential('syncChildrenPermission bitwise-OR upgrade ', () => {
  it('upgrades a child folder collaborator permission with bitwise OR', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const ownerTmb = String(users.owner.tmbId);
    const memberTmb = String(users.members[0].tmbId);

    const f1 = await MongoDataset.create({
      teamId,
      tmbId: ownerTmb,
      name: `f1-${Date.now()}`,
      type: DatasetTypeEnum.folder,
      inheritPermission: true
    });
    const f2 = await MongoDataset.create({
      teamId,
      tmbId: ownerTmb,
      name: `f2-${Date.now()}`,
      type: DatasetTypeEnum.folder,
      parentId: String(f1._id),
      inheritPermission: true
    });

    await MongoResourcePermission.insertMany([
      {
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: String(f1._id),
        tmbId: ownerTmb,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: String(f1._id),
        tmbId: memberTmb,
        permission: ReadRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: String(f2._id),
        tmbId: ownerTmb,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: String(f2._id),
        tmbId: memberTmb,
        permission: ReadRoleVal
      }
    ]);

    // baseline: sync read (idempotent)
    await mongoSessionRun(async (session) => {
      await syncChildrenPermission({
        resource: f1,
        resourceModel: MongoDataset,
        folderTypeList: [DatasetTypeEnum.folder],
        resourceType: PerResourceTypeEnum.dataset,
        session,
        collaborators: [
          { tmbId: ownerTmb, permission: OwnerRoleVal },
          { tmbId: memberTmb, permission: ReadRoleVal }
        ]
      });
    });

    // upgrade parent to write -> child ORs with its existing read (0b100 | 0b010 = 0b110)
    await mongoSessionRun(async (session) => {
      await syncChildrenPermission({
        resource: f1,
        resourceModel: MongoDataset,
        folderTypeList: [DatasetTypeEnum.folder],
        resourceType: PerResourceTypeEnum.dataset,
        session,
        collaborators: [
          { tmbId: ownerTmb, permission: OwnerRoleVal },
          { tmbId: memberTmb, permission: WriteRoleVal }
        ]
      });
    });

    const f2Clbs = await MongoResourcePermission.find({
      resourceType: PerResourceTypeEnum.dataset,
      teamId,
      resourceId: String(f2._id)
    }).lean();
    const byId = new Map(
      f2Clbs.map((c) => [String(c.tmbId ?? c.groupId ?? c.orgId), c.permission])
    );
    expect(byId.get(memberTmb)).toBe(ReadRoleVal | WriteRoleVal);
    expect(byId.get(ownerTmb)).toBe(OwnerRoleVal);
  });
});

describe.sequential('Collection Folder snapshot sync ', () => {
  const createFolder = async ({
    teamId,
    datasetId,
    tmbId,
    parentId
  }: {
    teamId: string;
    datasetId: string;
    tmbId: string;
    parentId?: string;
  }) =>
    MongoDatasetCollection.create({
      teamId,
      tmbId,
      datasetId,
      parentId: parentId ?? null,
      type: DatasetCollectionTypeEnum.folder,
      name: `cf-${Date.now()}-${Math.random()}`,
      inheritPermission: true
    });

  it('deletes a removed parent collaborator from the child folder snapshot', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const datasetId = new Types.ObjectId().toString();
    const ownerTmb = String(users.owner.tmbId);
    const memberTmb = String(users.members[0].tmbId);

    const cf1 = await createFolder({ teamId, datasetId, tmbId: ownerTmb });
    const cf2 = await createFolder({
      teamId,
      datasetId,
      tmbId: ownerTmb,
      parentId: String(cf1._id)
    });

    // seed both snapshots with member1 read
    await MongoResourcePermission.insertMany([
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(cf1._id),
        tmbId: ownerTmb,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(cf1._id),
        tmbId: memberTmb,
        permission: ReadRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(cf2._id),
        tmbId: ownerTmb,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(cf2._id),
        tmbId: memberTmb,
        permission: ReadRoleVal
      }
    ]);

    // parent collaborators no longer include member1 -> root snapshot drops member1;
    // 全快照模型：从旧有效 clbs 拆出自身 clbs 后与新有效合并，根/子 folder 的 member1
    // 均为继承贡献，被一并剔除。
    await mongoSessionRun(async (session) => {
      await syncDatasetCollectionFolders({
        teamId,
        datasetId,
        oldRootClbs: [
          { tmbId: ownerTmb, permission: OwnerRoleVal },
          { tmbId: memberTmb, permission: ReadRoleVal }
        ],
        rootClbs: [{ tmbId: ownerTmb, permission: OwnerRoleVal }],
        session
      });
    });

    const snapshotOf = async (resourceId: string) => {
      const clbs = await MongoResourcePermission.find({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId
      }).lean();
      return new Map(clbs.map((c) => [String(c.tmbId ?? c.groupId ?? c.orgId), c.permission]));
    };

    const cf1Map = await snapshotOf(String(cf1._id));
    const cf2Map = await snapshotOf(String(cf2._id));
    // 根 folder：member1 已不在新有效 clbs 且与旧父级一致 → 剔除
    expect(cf1Map.has(memberTmb)).toBe(false);
    expect(cf1Map.get(ownerTmb)).toBe(OwnerRoleVal);
    // 子 folder：父级新快照同样不含 member1 → 剔除
    expect(cf2Map.has(memberTmb)).toBe(false);
    expect(cf2Map.get(ownerTmb)).toBe(OwnerRoleVal);
  });

  it('upgrades a child folder snapshot when the parent permission is upgraded', async () => {
    const users = await getFakeUsers(1);
    const teamId = users.owner.teamId;
    const datasetId = new Types.ObjectId().toString();
    const ownerTmb = String(users.owner.tmbId);
    const memberTmb = String(users.members[0].tmbId);

    const cf1 = await createFolder({ teamId, datasetId, tmbId: ownerTmb });
    const cf2 = await createFolder({
      teamId,
      datasetId,
      tmbId: ownerTmb,
      parentId: String(cf1._id)
    });

    await MongoResourcePermission.insertMany([
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(cf1._id),
        tmbId: ownerTmb,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(cf1._id),
        tmbId: memberTmb,
        permission: ReadRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(cf2._id),
        tmbId: ownerTmb,
        permission: OwnerRoleVal
      },
      {
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId: String(cf2._id),
        tmbId: memberTmb,
        permission: ReadRoleVal
      }
    ]);

    // parent upgraded member1 read -> write; 全快照模型：根/子 folder 的 member1
    // 从旧有效 clbs 拆出（非自身配置）后，与新父级 write 合并 → 精确 write（非 sumPer 叠加）
    await mongoSessionRun(async (session) => {
      await syncDatasetCollectionFolders({
        teamId,
        datasetId,
        oldRootClbs: [
          { tmbId: ownerTmb, permission: OwnerRoleVal },
          { tmbId: memberTmb, permission: ReadRoleVal }
        ],
        rootClbs: [
          { tmbId: ownerTmb, permission: OwnerRoleVal },
          { tmbId: memberTmb, permission: WriteRoleVal }
        ],
        session
      });
    });

    const snapshotOf = async (resourceId: string) => {
      const clbs = await MongoResourcePermission.find({
        resourceType: PerResourceTypeEnum.collection,
        teamId,
        resourceId
      }).lean();
      return new Map(clbs.map((c) => [String(c.tmbId ?? c.groupId ?? c.orgId), c.permission]));
    };

    const cf1Map = await snapshotOf(String(cf1._id));
    const cf2Map = await snapshotOf(String(cf2._id));
    // member1 为继承贡献，新快照精确为 write
    expect(cf1Map.get(memberTmb)).toBe(WriteRoleVal);
    expect(cf2Map.get(memberTmb)).toBe(WriteRoleVal);
    expect(cf1Map.get(ownerTmb)).toBe(OwnerRoleVal);
    expect(cf2Map.get(ownerTmb)).toBe(OwnerRoleVal);
  });
});
