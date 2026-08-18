import type { ApiRequestProps } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { authDataset } from '@fastgpt/service/support/permission/dataset/auth';
import {
  ManagePermissionVal,
  PerResourceTypeEnum
} from '@fastgpt/global/support/permission/constant';
import { resumeInheritPermission } from '@fastgpt/service/support/permission/inheritPermission';
import { MongoDataset } from '@fastgpt/service/core/dataset/schema';
import { DatasetTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { mongoSessionRun } from '@fastgpt/service/common/mongo/sessionRun';
import { getResourceOwnedClbs } from '@fastgpt/service/support/permission/controller';
import { syncDatasetCollectionFolders } from '@fastgpt/service/support/permission/collection/folderSync';
import { mergeCollaboratorList } from '@fastgpt/global/support/permission/utils';
import {
  ResumeDatasetInheritPermissionBodySchema,
  type ResumeDatasetInheritPermissionBody
} from '@fastgpt/global/openapi/core/dataset/api';

async function handler(req: ApiRequestProps<ResumeDatasetInheritPermissionBody>) {
  const { datasetId } = ResumeDatasetInheritPermissionBodySchema.parse(req.body);
  const { dataset, teamId } = await authDataset({
    datasetId,
    req,
    authToken: true,
    per: ManagePermissionVal
  });

  if (dataset.parentId) {
    await mongoSessionRun(async (session) => {
      // 旧有效 clbs = 恢复前（独立态）自身 clbs；新有效 clbs = merge(父级, 自身 clbs)
      const oldRootClbs = await getResourceOwnedClbs({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: datasetId,
        session
      });
      const parentClbs = await getResourceOwnedClbs({
        resourceType: PerResourceTypeEnum.dataset,
        teamId,
        resourceId: String(dataset.parentId),
        session
      });
      const rootClbs = mergeCollaboratorList({ parentClbs, childClbs: oldRootClbs });

      await resumeInheritPermission({
        resource: dataset,
        folderTypeList: [DatasetTypeEnum.folder],
        resourceType: PerResourceTypeEnum.dataset,
        resourceModel: MongoDataset,
        session
      });

      // 恢复继承后，将 Dataset 的新有效 clbs 同步到其下所有继承态 Collection 快照
      await syncDatasetCollectionFolders({
        teamId,
        datasetId,
        oldRootClbs,
        rootClbs,
        session
      });
    });
  } else {
    await MongoDataset.updateOne(
      {
        _id: datasetId
      },
      {
        inheritPermission: true
      }
    );
  }
}
export default NextAPI(handler);
