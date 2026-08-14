import { defineIndex, getMongoModel, Schema } from '../../common/mongo';
import {
  ChunkSettingModeEnum,
  ChunkTriggerConfigTypeEnum,
  DataChunkSplitModeEnum,
  DatasetCollectionDataProcessModeEnum,
  DatasetTypeEnum,
  DatasetTypeMap,
  ParagraphChunkAIModeEnum
} from '@fastgpt/global/core/dataset/constants';
import {
  TeamCollectionName,
  TeamMemberCollectionName
} from '@fastgpt/global/support/user/team/constant';
import { userCollectionName } from '../../support/user/schema';
import type { DatasetSchemaType } from '@fastgpt/global/core/dataset/type';

export const DatasetCollectionName = 'datasets';

export const ChunkSettings = {
  trainingType: {
    type: String,
    enum: Object.values(DatasetCollectionDataProcessModeEnum)
  },

  chunkTriggerType: {
    type: String,
    enum: Object.values(ChunkTriggerConfigTypeEnum)
  },
  chunkTriggerMinSize: Number,

  dataEnhanceCollectionName: Boolean,

  imageIndex: Boolean,
  autoIndexes: Boolean,
  indexPrefixTitle: Boolean,

  chunkSettingMode: {
    type: String,
    enum: Object.values(ChunkSettingModeEnum)
  },
  chunkSplitMode: {
    type: String,
    enum: Object.values(DataChunkSplitModeEnum)
  },
  paragraphChunkAIMode: {
    type: String,
    enum: Object.values(ParagraphChunkAIModeEnum)
  },
  paragraphChunkDeep: Number,
  paragraphChunkMinSize: Number,
  chunkSize: Number,
  chunkSplitter: String,

  indexSize: Number,
  qaPrompt: String
};

const DatasetSchema = new Schema({
  parentId: {
    type: Schema.Types.ObjectId,
    ref: DatasetCollectionName,
    default: null
  },
  userId: {
    //abandon
    type: Schema.Types.ObjectId,
    ref: userCollectionName
  },
  teamId: {
    type: Schema.Types.ObjectId,
    ref: TeamCollectionName,
    required: true
  },
  tmbId: {
    type: Schema.Types.ObjectId,
    ref: TeamMemberCollectionName,
    required: true
  },
  type: {
    type: String,
    enum: Object.keys(DatasetTypeMap),
    required: true,
    default: DatasetTypeEnum.dataset
  },
  avatar: {
    type: String,
    default: '/icon/logo.svg'
  },
  name: {
    type: String,
    required: true
  },
  updateTime: {
    type: Date,
    default: () => new Date()
  },
  vectorModel: {
    type: String,
    required: true,
    default: 'text-embedding-3-small'
  },
  agentModel: {
    type: String,
    required: true,
    default: 'gpt-4o-mini'
  },
  vlmModel: String,
  intro: {
    type: String,
    default: ''
  },
  websiteConfig: {
    type: {
      url: {
        type: String,
        required: true
      },
      selector: {
        type: String,
        default: 'body'
      }
    }
  },
  chunkSettings: {
    type: ChunkSettings
  },
  inheritPermission: {
    type: Boolean,
    default: true
  },
  /** 该 Dataset 下是否配置过 Collection 级权限（独立/自定义）。
   *  - false（默认）：所有 Collection 均为纯继承，collection 级鉴权可短路为 Dataset 级鉴权；
   *  - true：至少一个 Collection 配置了独立权限（非继承 / 追加协作者 / 独立 move），需完整 Collection 解析。
   * 单向置位（只增不减）：stale `true` 仅损失短路优化，不损失正确性。 */
  hasSetCollectionPermissions: {
    type: Boolean,
    default: false
  },

  apiDatasetServer: Object,

  // 软删除标记字段
  deleteTime: {
    type: Date,
    default: null // null表示未删除，有值表示删除时间
  },

  autoSync: Boolean,
  /** @deprecated */
  externalReadUrl: String,
  /** @deprecated */
  defaultPermission: Number,
  /** @deprecated */
  apiServer: Object,
  /** @deprecated */
  feishuServer: Object,
  /** @deprecated */
  yuqueServer: Object
});

defineIndex(DatasetSchema, { key: { teamId: 1 } });
defineIndex(DatasetSchema, { key: { type: 1 } }); // Admin count
defineIndex(DatasetSchema, { key: { deleteTime: 1 } }); // 添加软删除字段索引

export const MongoDataset = getMongoModel<DatasetSchemaType>(DatasetCollectionName, DatasetSchema);
