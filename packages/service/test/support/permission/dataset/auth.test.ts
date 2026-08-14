import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatasetErrEnum } from '@fastgpt/global/common/error/code/dataset';
import {
  ManagePermissionVal,
  ManageRoleVal,
  OwnerRoleVal,
  OwnerPermissionVal,
  ReadPermissionVal,
  ReadRoleVal,
  WritePermissionVal
} from '@fastgpt/global/support/permission/constant';

const {
  mockParseHeaderCert,
  mockGetCollectionWithDataset,
  mockFindDataset,
  mockGetTmbInfoByTmbId,
  mockGetTmbPermission,
  mockIsObjectExists
} = vi.hoisted(() => ({
  mockParseHeaderCert: vi.fn(),
  mockGetCollectionWithDataset: vi.fn(),
  mockFindDataset: vi.fn(),
  mockGetTmbInfoByTmbId: vi.fn(),
  mockGetTmbPermission: vi.fn(),
  mockIsObjectExists: vi.fn()
}));

vi.mock('@fastgpt/service/support/permission/auth/common', () => ({
  parseHeaderCert: mockParseHeaderCert
}));

vi.mock('@fastgpt/service/core/dataset/controller', () => ({
  getCollectionWithDataset: mockGetCollectionWithDataset
}));

vi.mock('@fastgpt/service/core/dataset/schema', () => ({
  MongoDataset: {
    findOne: mockFindDataset
  }
}));

vi.mock('@fastgpt/service/support/user/team/controller', () => ({
  getTmbInfoByTmbId: mockGetTmbInfoByTmbId
}));

vi.mock('@fastgpt/service/support/permission/controller', () => ({
  getTmbPermission: mockGetTmbPermission
}));

vi.mock('@fastgpt/service/core/dataset/data/schema', () => ({
  MongoDatasetData: {
    findById: vi.fn()
  }
}));

vi.mock('@fastgpt/service/common/s3/sources/dataset', () => ({
  getS3DatasetSource: () => ({
    isObjectExists: mockIsObjectExists
  })
}));

import { authDatasetCollection } from '@fastgpt/service/support/permission/dataset/auth';
import { authCollectionFile } from '@fastgpt/service/support/permission/auth/file';

const datasetId = '507f1f77bcf86cd799439011';
const collectionId = '507f1f77bcf86cd799439012';
const parentFolderId = '507f1f77bcf86cd799439099';

const mockDatasetQuery = (dataset: Record<string, any>) => {
  mockFindDataset.mockReturnValue({
    lean: vi.fn().mockResolvedValue(dataset)
  });
};

const mockCollectionQuery = (collection: Record<string, any>) => {
  mockGetCollectionWithDataset.mockResolvedValue(collection);
};

describe('authDatasetCollection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseHeaderCert.mockResolvedValue({
      teamId: 'team-a',
      tmbId: 'tmb-a',
      userId: 'user-a',
      isRoot: false
    });
    mockGetTmbInfoByTmbId.mockResolvedValue({
      teamId: 'team-a',
      permission: { isOwner: true }
    });
    mockGetTmbPermission.mockResolvedValue(0);
    mockIsObjectExists.mockResolvedValue(true);
    mockDatasetQuery({
      _id: datasetId,
      teamId: 'team-a',
      tmbId: 'tmb-a',
      inheritPermission: false
    });
  });

  it('rejects a collection whose team does not match its dataset team', async () => {
    mockGetCollectionWithDataset.mockResolvedValue({
      _id: collectionId,
      teamId: 'team-b',
      datasetId
    });

    await expect(
      authDatasetCollection({
        req: {} as any,
        authToken: true,
        collectionId,
        per: ReadPermissionVal
      })
    ).rejects.toBe(DatasetErrEnum.unAuthDataset);
  });

  it('allows a collection whose team matches its dataset team', async () => {
    mockGetCollectionWithDataset.mockResolvedValue({
      _id: collectionId,
      teamId: 'team-a',
      datasetId
    });

    const result = await authDatasetCollection({
      req: {} as any,
      authToken: true,
      collectionId,
      per: ReadPermissionVal
    });

    expect(result.collection._id).toBe(collectionId);
  });

  it('rejects when the user has collection read but no dataset read (knowledge base gate)', async () => {
    mockGetTmbInfoByTmbId.mockResolvedValue({
      teamId: 'team-a',
      permission: { isOwner: false }
    });
    mockGetTmbPermission.mockImplementation(async ({ resourceId }: any) => {
      if (String(resourceId) === datasetId) return 0; // no dataset read
      return ReadRoleVal; // has collection read only
    });
    mockDatasetQuery({
      _id: datasetId,
      teamId: 'team-a',
      tmbId: 'tmb-other',
      inheritPermission: false
    });
    mockCollectionQuery({
      _id: collectionId,
      teamId: 'team-a',
      datasetId,
      tmbId: 'tmb-a',
      type: 'file',
      parentId: null,
      inheritPermission: true
    });

    await expect(
      authDatasetCollection({
        req: {} as any,
        authToken: true,
        collectionId,
        per: ReadPermissionVal
      })
    ).rejects.toBe(DatasetErrEnum.unAuthDataset);
  });

  it('allows the owner to access their own collection via OwnerRoleVal record', async () => {
    mockGetTmbInfoByTmbId.mockResolvedValue({
      teamId: 'team-a',
      permission: { isOwner: true }
    });
    mockGetTmbPermission.mockImplementation(async ({ resourceId }: any) => {
      if (String(resourceId) === collectionId) return OwnerRoleVal;
      return ReadRoleVal; // dataset read
    });
    mockDatasetQuery({
      _id: datasetId,
      teamId: 'team-a',
      tmbId: 'tmb-a',
      inheritPermission: false
    });
    mockCollectionQuery({
      _id: collectionId,
      teamId: 'team-a',
      datasetId,
      tmbId: 'tmb-a',
      type: 'file',
      parentId: null,
      inheritPermission: true
    });

    const result = await authDatasetCollection({
      req: {} as any,
      authToken: true,
      collectionId,
      per: ManagePermissionVal
    });

    expect(result.permission.isOwner).toBe(true);
    expect(result.permission.checkPer(ReadPermissionVal)).toBe(true);
  });

  it('allows an inherited collection that is readable via its parent folder snapshot', async () => {
    mockGetTmbInfoByTmbId.mockResolvedValue({
      teamId: 'team-a',
      permission: { isOwner: false }
    });
    mockGetTmbPermission.mockImplementation(async ({ resourceId }: any) => {
      if (String(resourceId) === datasetId) return ReadRoleVal; // dataset read
      if (String(resourceId) === parentFolderId) return ReadRoleVal; // parent folder snapshot
      return 0; // no own collection record
    });
    mockDatasetQuery({
      _id: datasetId,
      teamId: 'team-a',
      tmbId: 'tmb-other',
      inheritPermission: false
    });
    mockCollectionQuery({
      _id: collectionId,
      teamId: 'team-a',
      datasetId,
      tmbId: 'tmb-other',
      type: 'file',
      parentId: parentFolderId,
      inheritPermission: true
    });

    const result = await authDatasetCollection({
      req: {} as any,
      authToken: true,
      collectionId,
      per: ReadPermissionVal
    });

    expect(result.collection._id).toBe(collectionId);
  });

  it('caps parent owner to manage at the auth level (owner not passed through)', async () => {
    mockGetTmbInfoByTmbId.mockResolvedValue({
      teamId: 'team-a',
      permission: { isOwner: false }
    });
    mockGetTmbPermission.mockImplementation(async ({ resourceId }: any) => {
      if (String(resourceId) === datasetId) return ReadRoleVal; // dataset read
      if (String(resourceId) === parentFolderId) return OwnerRoleVal; // user owns parent folder
      return 0;
    });
    mockDatasetQuery({
      _id: datasetId,
      teamId: 'team-a',
      tmbId: 'tmb-other',
      inheritPermission: false
    });
    mockCollectionQuery({
      _id: collectionId,
      teamId: 'team-a',
      datasetId,
      tmbId: 'tmb-other',
      type: 'file',
      parentId: parentFolderId,
      inheritPermission: true
    });

    const result = await authDatasetCollection({
      req: {} as any,
      authToken: true,
      collectionId,
      per: ManagePermissionVal
    });

    expect(result.permission.isOwner).toBe(false);
    expect(result.permission.role).toBe(ManageRoleVal);
  });

  it('rejects when the collection permission is below the requested per (dataset read passes, only collection read)', async () => {
    mockGetTmbInfoByTmbId.mockResolvedValue({
      teamId: 'team-a',
      permission: { isOwner: false }
    });
    mockGetTmbPermission.mockImplementation(async ({ resourceId }: any) => {
      if (String(resourceId) === datasetId) return ReadRoleVal; // dataset read passes the gate
      return ReadRoleVal; // collection read only (below manage)
    });
    mockDatasetQuery({
      _id: datasetId,
      teamId: 'team-a',
      tmbId: 'tmb-other',
      inheritPermission: false
    });
    mockCollectionQuery({
      _id: collectionId,
      teamId: 'team-a',
      datasetId,
      tmbId: 'tmb-other',
      type: 'file',
      parentId: null,
      inheritPermission: false
    });

    // requesting manage while the user only has collection read -> unAuthDatasetCollection
    await expect(
      authDatasetCollection({
        req: {} as any,
        authToken: true,
        collectionId,
        per: ManagePermissionVal
      })
    ).rejects.toBe(DatasetErrEnum.unAuthDatasetCollection);
  });

  it('rejects when only collection write is missing (read passes but write requested)', async () => {
    mockGetTmbInfoByTmbId.mockResolvedValue({
      teamId: 'team-a',
      permission: { isOwner: false }
    });
    mockGetTmbPermission.mockImplementation(async ({ resourceId }: any) => {
      if (String(resourceId) === datasetId) return ReadRoleVal; // dataset read passes
      return ReadRoleVal; // collection read only
    });
    mockDatasetQuery({
      _id: datasetId,
      teamId: 'team-a',
      tmbId: 'tmb-other',
      inheritPermission: false
    });
    mockCollectionQuery({
      _id: collectionId,
      teamId: 'team-a',
      datasetId,
      tmbId: 'tmb-other',
      type: 'file',
      parentId: null,
      inheritPermission: true
    });

    await expect(
      authDatasetCollection({
        req: {} as any,
        authToken: true,
        collectionId,
        per: WritePermissionVal
      })
    ).rejects.toBe(DatasetErrEnum.unAuthDatasetCollection);
  });

  it('lets a team owner read/manage a non-inherited collection created by another member (Error-1 bypass)', async () => {
    // team owner -> dataset read gate passes via isOwner, and the collection-level
    // check must NOT be denied even though there is no own collection clb record
    // and the user is not the collection owner (consistency).
    mockGetTmbInfoByTmbId.mockResolvedValue({
      teamId: 'team-a',
      permission: { isOwner: true, hasManagePer: false }
    });
    mockGetTmbPermission.mockResolvedValue(0); // no dataset clb, no collection clb
    mockDatasetQuery({
      _id: datasetId,
      teamId: 'team-a',
      tmbId: 'tmb-other',
      inheritPermission: false
    });
    mockCollectionQuery({
      _id: collectionId,
      teamId: 'team-a',
      datasetId,
      tmbId: 'tmb-other',
      type: 'file',
      parentId: null,
      inheritPermission: false
    });

    // read passes
    const readResult = await authDatasetCollection({
      req: {} as any,
      authToken: true,
      collectionId,
      per: ReadPermissionVal
    });
    expect(readResult.collection._id).toBe(collectionId);
    expect(readResult.permission.checkPer(ReadPermissionVal)).toBe(true);

    // manage passes (manage-role bypass, no false owner flag for a non-owner collection)
    const manageResult = await authDatasetCollection({
      req: {} as any,
      authToken: true,
      collectionId,
      per: ManagePermissionVal
    });
    expect(manageResult.permission.checkPer(ManagePermissionVal)).toBe(true);
    expect(manageResult.permission.isOwner).toBe(false);
  });

  it('lets a team admin (manage on team) manage a non-inherited collection created by another member', async () => {
    mockGetTmbInfoByTmbId.mockResolvedValue({
      teamId: 'team-a',
      permission: { isOwner: false, hasManagePer: true }
    });
    mockGetTmbPermission.mockImplementation(async ({ resourceId }: any) => {
      if (String(resourceId) === datasetId) return ReadRoleVal; // dataset read via clb
      return 0; // no own collection record
    });
    mockDatasetQuery({
      _id: datasetId,
      teamId: 'team-a',
      tmbId: 'tmb-other',
      inheritPermission: false
    });
    mockCollectionQuery({
      _id: collectionId,
      teamId: 'team-a',
      datasetId,
      tmbId: 'tmb-other',
      type: 'file',
      parentId: null,
      inheritPermission: false
    });

    const result = await authDatasetCollection({
      req: {} as any,
      authToken: true,
      collectionId,
      per: ManagePermissionVal
    });
    expect(result.permission.checkPer(ManagePermissionVal)).toBe(true);
    expect(result.permission.isOwner).toBe(false);
  });

  it('still rejects a regular member with no collection permission even when the dataset read passes (no bypass)', async () => {
    mockGetTmbInfoByTmbId.mockResolvedValue({
      teamId: 'team-a',
      permission: { isOwner: false, hasManagePer: false }
    });
    mockGetTmbPermission.mockImplementation(async ({ resourceId }: any) => {
      if (String(resourceId) === datasetId) return ReadRoleVal; // dataset read passes
      return 0; // no own collection record
    });
    mockDatasetQuery({
      _id: datasetId,
      teamId: 'team-a',
      tmbId: 'tmb-other',
      inheritPermission: false
    });
    mockCollectionQuery({
      _id: collectionId,
      teamId: 'team-a',
      datasetId,
      tmbId: 'tmb-other',
      type: 'file',
      parentId: null,
      inheritPermission: false
    });

    await expect(
      authDatasetCollection({
        req: {} as any,
        authToken: true,
        collectionId,
        per: ReadPermissionVal
      })
    ).rejects.toBe(DatasetErrEnum.unAuthDatasetCollection);
  });

  it('short-circuits to dataset permission when hasSetCollectionPermissions=false ', async () => {
    // 普通成员：非团队 owner/admin
    mockGetTmbInfoByTmbId.mockResolvedValue({
      teamId: 'team-a',
      permission: { isOwner: false, hasManagePer: false }
    });
    // Dataset read 通过；collection 无任何自身记录（纯继承）
    mockGetTmbPermission.mockImplementation(async ({ resourceId }: any) => {
      if (String(resourceId) === datasetId) return ReadRoleVal;
      return 0;
    });
    mockDatasetQuery({
      _id: datasetId,
      teamId: 'team-a',
      tmbId: 'tmb-other',
      inheritPermission: false,
      hasSetCollectionPermissions: false // 短路标记：纯继承，无 Collection 自定义权限
    });
    mockCollectionQuery({
      _id: collectionId,
      teamId: 'team-a',
      datasetId,
      tmbId: 'tmb-other',
      type: 'file',
      parentId: null,
      inheritPermission: true
    });

    const result = await authDatasetCollection({
      req: {} as any,
      authToken: true,
      collectionId,
      per: ReadPermissionVal
    });

    // 短路后有效权限 = Dataset 有效权限（read）；非 collection owner 不提升为 owner
    expect(result.permission.role).toBe(ReadRoleVal);
    expect(result.permission.isOwner).toBe(false);
  });

  it('lets a system root user bypass the collection-level check (isRoot)', async () => {
    mockParseHeaderCert.mockResolvedValue({
      teamId: 'team-a',
      tmbId: 'tmb-a',
      userId: 'user-a',
      isRoot: true
    });
    // even with zero dataset/collection records, root should pass any permission
    mockGetTmbPermission.mockResolvedValue(0);
    mockDatasetQuery({
      _id: datasetId,
      teamId: 'team-a',
      tmbId: 'tmb-other',
      inheritPermission: false
    });
    mockCollectionQuery({
      _id: collectionId,
      teamId: 'team-a',
      datasetId,
      tmbId: 'tmb-other',
      type: 'file',
      parentId: parentFolderId,
      inheritPermission: true
    });

    const result = await authDatasetCollection({
      req: {} as any,
      authRoot: true,
      collectionId,
      per: OwnerPermissionVal
    });

    expect(result.permission.isOwner).toBe(true);
  });
});

describe('authCollectionFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseHeaderCert.mockResolvedValue({
      teamId: 'team-a',
      tmbId: 'tmb-a',
      userId: 'user-a',
      isRoot: false
    });
    mockGetTmbInfoByTmbId.mockResolvedValue({
      teamId: 'team-a',
      permission: { isOwner: true }
    });
    mockGetTmbPermission.mockResolvedValue(0);
    mockIsObjectExists.mockResolvedValue(true);
  });

  it('authorizes a dataset file through the dataset id embedded in the key', async () => {
    mockDatasetQuery({
      _id: datasetId,
      teamId: 'team-a',
      tmbId: 'tmb-a',
      inheritPermission: false
    });

    const result = await authCollectionFile({
      req: {} as any,
      authToken: true,
      fileId: `dataset/${datasetId}/demo.pdf`,
      per: OwnerPermissionVal
    });

    expect(result.teamId).toBe('team-a');
    expect(mockIsObjectExists).toHaveBeenCalledWith(`dataset/${datasetId}/demo.pdf`);
  });

  it('rejects a dataset file key that belongs to another team', async () => {
    mockDatasetQuery({
      _id: datasetId,
      teamId: 'team-b',
      tmbId: 'tmb-b',
      inheritPermission: false
    });

    await expect(
      authCollectionFile({
        req: {} as any,
        authToken: true,
        fileId: `dataset/${datasetId}/secret.pdf`,
        per: OwnerPermissionVal
      })
    ).rejects.toBe(DatasetErrEnum.unAuthDataset);

    expect(mockIsObjectExists).not.toHaveBeenCalled();
  });
});
