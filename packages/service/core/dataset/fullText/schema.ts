import { defineIndex, connectionMongo, getMongoModel } from '../../../common/mongo';
const { Schema } = connectionMongo;

export const FullTextMigrationLogCollectionName = 'full_text_migration_logs';

export type FullTextMigrationStatus = 'running' | 'done' | 'failed';

export type FullTextMigrationLogSchemaType = {
  migrationId: string;
  oldEngine: 'mongo' | 'milvus';
  newEngine: 'mongo' | 'milvus';
  status: FullTextMigrationStatus;
  cursor: string;
  totalCount: number;
  processedCount: number;
  skippedCount: number;
  failedCount: number;
  error?: string;
  updatedAt: Date;
  createdAt: Date;
};

const FullTextMigrationLogSchema = new Schema({
  migrationId: {
    type: String,
    required: true
  },
  oldEngine: {
    type: String,
    required: true,
    enum: ['mongo', 'milvus']
  },
  newEngine: {
    type: String,
    required: true,
    enum: ['mongo', 'milvus']
  },
  status: {
    type: String,
    enum: ['running', 'done', 'failed'],
    default: 'running'
  },
  cursor: {
    type: String,
    default: ''
  },
  totalCount: {
    type: Number,
    default: 0
  },
  processedCount: {
    type: Number,
    default: 0
  },
  skippedCount: {
    type: Number,
    default: 0
  },
  failedCount: {
    type: Number,
    default: 0
  },
  error: String,
  updatedAt: {
    type: Date,
    default: () => new Date()
  },
  createdAt: {
    type: Date,
    default: () => new Date()
  }
});

defineIndex(FullTextMigrationLogSchema, {
  key: { migrationId: 1 },
  options: { unique: true }
});
defineIndex(FullTextMigrationLogSchema, { key: { status: 1, updatedAt: 1 } });

export const MongoFullTextMigrationLog = getMongoModel<FullTextMigrationLogSchemaType>(
  FullTextMigrationLogCollectionName,
  FullTextMigrationLogSchema
);

export const FullTextMigrationFailedCollectionName = 'full_text_migration_failed';

export type FullTextMigrationFailedRowSchemaType = {
  migrationId: string;
  dataId: string;
  error: string;
  createdAt: Date;
};

const FullTextMigrationFailedSchema = new Schema({
  migrationId: {
    type: String,
    required: true
  },
  dataId: {
    type: String,
    required: true
  },
  error: String,
  createdAt: {
    type: Date,
    default: () => new Date()
  }
});

defineIndex(FullTextMigrationFailedSchema, {
  key: { migrationId: 1, dataId: 1 },
  options: { unique: true }
});

export const MongoFullTextMigrationFailed = getMongoModel<FullTextMigrationFailedRowSchemaType>(
  FullTextMigrationFailedCollectionName,
  FullTextMigrationFailedSchema
);
