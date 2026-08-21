import { NextAPI } from '@/service/middleware/entry';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { authCert } from '@fastgpt/service/support/permission/auth/common';
import {
  runFullTextMigration,
  type FullTextMigrateResult
} from '@fastgpt/service/core/dataset/fullText/migration';

export type Query = {
  /** 旧引擎:mongo | milvus */
  oldEngine: 'mongo' | 'milvus';
  /** oldEngine=milvus 时必填:旧 milvus 地址 */
  oldMilvusAddress?: string;
  oldMilvusToken?: string;
  /** 每批条数,默认 500 */
  batchSize?: string;
  /** dryRun=true | 1:只统计不写入 */
  dryRun?: string;
  /** removeOld=true | 1:迁移校验通过后删除旧引擎索引 */
  removeOld?: string;
  /** 断点续跑:沿用已有 migrationId */
  resumeMigrationId?: string;
};

/**
 * 全文检索引擎迁移脚本(设计 §9)
 *
 * 将 mongo($text) 或旧 milvus 的全文索引数据搬迁到当前 FULL_TEXT_ENGINE 指向的新引擎,
 * 数据来源始终是 dataset_data_texts(mongo) / modeldata_text(milvus) 的 dataId 序列,
 * 目标写入通过 textStore 门面按目标引擎/粒度归一化。
 *
 * 示例:
 *   GET /api/admin/initFullTextMigrate?oldEngine=milvus&oldMilvusAddress=http://x:19530&batchSize=500&dryRun=1
 *   GET /api/admin/initFullTextMigrate?oldEngine=milvus&oldMilvusAddress=http://x:19530&removeOld=1
 *   GET /api/admin/initFullTextMigrate?oldEngine=milvus&oldMilvusAddress=http://x:19530&resumeMigrationId=<uuid>
 */
async function handler(req: ApiRequestProps<unknown, Query>): Promise<FullTextMigrateResult> {
  await authCert({ req, authRoot: true });

  const {
    oldEngine,
    oldMilvusAddress,
    oldMilvusToken,
    batchSize,
    dryRun,
    removeOld,
    resumeMigrationId
  } = req.query;

  return runFullTextMigration({
    oldEngine,
    oldMilvusAddress,
    oldMilvusToken,
    batchSize: batchSize ? Number(batchSize) : undefined,
    dryRun: dryRun === 'true' || dryRun === '1',
    removeOld: removeOld === 'true' || removeOld === '1',
    resumeMigrationId
  });
}

export default NextAPI(handler);
