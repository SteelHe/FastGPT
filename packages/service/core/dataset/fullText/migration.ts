import { randomUUID } from 'node:crypto';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import type { DatasetDataSchemaType } from '@fastgpt/global/core/dataset/type';
import { getErrText } from '@fastgpt/global/common/error/utils';
import { Types } from '../../../common/mongo';
import { getLogger, LogCategories } from '../../../common/logger';
import {
  DatasetVectorTextTableName,
  FULL_TEXT_WRITE_BATCH_SIZE
} from '../../../common/vectorDB/constants';
import { MongoDatasetDataText } from '../data/dataTextSchema';
import { MongoDatasetData } from '../data/schema';
import { getFullTextEngine, getFullTextStore } from '../data/textStore';
import type { FullTextStore, FullTextWriteProps } from '../data/textStore';
import {
  MongoFullTextMigrationFailed,
  MongoFullTextMigrationLog,
  type FullTextMigrationStatus
} from './schema';

const logger = getLogger(LogCategories.MODULE.DATASET.DATA);
const MAX_BATCH_SIZE = 2000;

export type FullTextMigrateQuery = {
  /** 旧引擎:mongo | milvus */
  oldEngine: 'mongo' | 'milvus';
  /** oldEngine=milvus 时的旧 milvus 连接 */
  oldMilvusAddress?: string;
  oldMilvusToken?: string;
  /** 每批搬运条数,默认 500 */
  batchSize?: number;
  /** dryRun 只统计不写入 */
  dryRun?: boolean;
  /** 迁移校验通过后删除旧引擎索引 */
  removeOld?: boolean;
  /** 断点续跑:沿用已有 migrationId */
  resumeMigrationId?: string;
};

export type FullTextMigrateResult = {
  message: string;
  migrationId?: string;
  status: FullTextMigrationStatus | 'dry-run';
  oldEngine: 'mongo' | 'milvus';
  newEngine: 'mongo' | 'milvus';
  sourceCount: number;
  targetCount?: number;
  processedCount: number;
  skippedCount: number;
  failedCount: number;
  durationMs: number;
  error?: string;
};

type SourceBatch = { dataIds: string[]; cursor: string };

/* ==================== 源读取 ==================== */

const createMilvusClient = async (address: string, token?: string): Promise<MilvusClient> => {
  const client = new MilvusClient({ address, token });
  await client.connectPromise;
  return client;
};

const countMilvusTextRows = async (client: MilvusClient): Promise<number> => {
  const res = await client.query({
    collection_name: DatasetVectorTextTableName,
    output_fields: ['count(*)']
  });
  return Number(res.data?.[0]?.['count(*)'] ?? 0);
};

const getTargetMilvusClient = async (targetStore: FullTextStore): Promise<MilvusClient> => {
  return (targetStore as unknown as { getClient: () => Promise<MilvusClient> }).getClient();
};

/**
 * mongo 源:遍历 dataset_data_texts(每 dataId 一行),按 _id 递增分页。
 * ObjectId 随插入递增,_id > cursor 即为稳定的断点光标。
 */
const readMongoTextBatch = async (cursor: string, batchSize: number): Promise<SourceBatch> => {
  const rows = await MongoDatasetDataText.find(
    cursor ? { _id: { $gt: new Types.ObjectId(cursor) } } : {},
    { _id: 1, dataId: 1 }
  )
    .sort({ _id: 1 })
    .limit(batchSize)
    .lean();

  return {
    dataIds: Array.from(new Set(rows.map((r) => String(r.dataId)).filter(Boolean))),
    cursor: rows.length > 0 ? String(rows[rows.length - 1]._id) : ''
  };
};

/**
 * milvus 源:遍历 modeldata_text,按 dataId(ObjectId 字符串,字典序 = 插入序)递增分页。
 * Trie 索引按 dataId 有序扫描;同 dataId 的 index 粒度多行在批内去重(按数据搬运,非按行)。
 * cursor 取批内最大 dataId,保证下批严格排除已处理数据。
 */
const readMilvusTextBatch = async (
  client: MilvusClient,
  cursor: string,
  batchSize: number
): Promise<SourceBatch> => {
  const res = await client.query({
    collection_name: DatasetVectorTextTableName,
    output_fields: ['id', 'dataId'],
    filter: cursor ? `(dataId > "${cursor}")` : '',
    limit: batchSize
  });

  const rows = (res.data ?? []) as { id?: string; dataId?: string }[];
  const dataIds = Array.from(
    new Set(rows.map((r) => String(r.dataId ?? r.id ?? '')).filter(Boolean))
  );
  const maxDataId = rows.reduce((max, r) => {
    const id = String(r.dataId ?? r.id ?? '');
    return id > max ? id : max;
  }, '');

  return { dataIds, cursor: maxDataId };
};

/* ==================== 归一化 + 写入 ==================== */

const buildItem = (data: DatasetDataSchemaType): FullTextWriteProps => ({
  teamId: String(data.teamId),
  datasetId: String(data.datasetId),
  collectionId: String(data.collectionId),
  dataId: String(data._id),
  text: `${data.q ?? ''}\n${data.a ?? ''}`.trim(),
  indexes: (data.indexes ?? []).map((index) => ({
    vectorId: String(index.dataId),
    text: index.text ?? ''
  }))
});

/**
 * 按 dataId 批量搬运到目标 store。
 * 源数据统一归一化为 { dataId, text, indexes },由目标 store 按目标引擎/粒度写入(mongo: jieba+bulkWrite;milvus: data upsert / index delete+insert)。
 * 目标 write 为批量接口(内部再按 50 分片),这里以 FULL_TEXT_WRITE_BATCH_SIZE 为失败粒度:
 * 一批失败 → 批内整片重试一次(设计 §9.3)→ 仍失败整片收集,断点续跑时逐条自愈。
 */
const processBatch = async (
  targetStore: FullTextStore,
  dataIds: string[],
  retryOnFailure = true
): Promise<{ processed: number; skipped: number; failed: { dataId: string; error: string }[] }> => {
  const validIds = dataIds.filter((id) => Types.ObjectId.isValid(id));
  let skipped = dataIds.length - validIds.length;

  const dataRows = (await MongoDatasetData.find(
    { _id: { $in: validIds.map((id) => new Types.ObjectId(id)) } },
    { teamId: 1, datasetId: 1, collectionId: 1, q: 1, a: 1, indexes: 1 }
  ).lean()) as DatasetDataSchemaType[];
  const dataMap = new Map(dataRows.map((d) => [String(d._id), d]));

  // valid 但 dataset_data 已不存在(孤儿)的行跳过
  const items = validIds
    .map((dataId) => dataMap.get(dataId))
    .filter((d): d is DatasetDataSchemaType => !!d)
    .map(buildItem);
  skipped += validIds.length - items.length;

  let processed = 0;
  const failed: { dataId: string; error: string }[] = [];

  for (let i = 0; i < items.length; i += FULL_TEXT_WRITE_BATCH_SIZE) {
    const chunk = items.slice(i, i + FULL_TEXT_WRITE_BATCH_SIZE);
    try {
      await targetStore.write(chunk);
      processed += chunk.length;
    } catch (err) {
      if (!retryOnFailure) {
        failed.push(...chunk.map((item) => ({ dataId: item.dataId, error: getErrText(err) })));
        continue;
      }
      // 批次内统一重试一次(设计 §9.3)
      try {
        await targetStore.write(chunk);
        processed += chunk.length;
      } catch (retryErr) {
        failed.push(...chunk.map((item) => ({ dataId: item.dataId, error: getErrText(retryErr) })));
      }
    }
  }

  return { processed, skipped, failed };
};

/* ==================== 编排 ==================== */

export const runFullTextMigration = async (
  query: FullTextMigrateQuery
): Promise<FullTextMigrateResult> => {
  const startTime = Date.now();
  const oldEngine = query.oldEngine;
  const newEngine = getFullTextEngine();
  const batchSize = Math.max(1, Math.min(query.batchSize || 500, MAX_BATCH_SIZE));
  const dryRun = !!query.dryRun;
  const removeOld = !!query.removeOld;

  // 1. 校验
  if (oldEngine !== 'mongo' && oldEngine !== 'milvus') {
    throw new Error(`Invalid oldEngine: ${oldEngine}`);
  }
  if (oldEngine === newEngine) {
    throw new Error(`oldEngine(${oldEngine}) and newEngine(${newEngine}) must be different`);
  }
  if (oldEngine === 'milvus' && !query.oldMilvusAddress) {
    throw new Error('oldMilvusAddress is required when oldEngine=milvus');
  }

  // 2. 目标引擎能力探测(建集合/加载,engine=mongo 为 no-op)
  const targetStore = getFullTextStore();
  await targetStore.init();

  // 3. 旧 milvus client + 源集合存在性
  let oldMilvusClient: MilvusClient | undefined;
  if (oldEngine === 'milvus') {
    oldMilvusClient = await createMilvusClient(query.oldMilvusAddress!, query.oldMilvusToken);
    const { value: hasCollection } = await oldMilvusClient.hasCollection({
      collection_name: DatasetVectorTextTableName
    });
    if (!hasCollection) {
      throw new Error(`Old milvus full-text collection ${DatasetVectorTextTableName} not found`);
    }
  }

  // 4. 断点续跑:校验已有日志并恢复 cursor(不创建)
  let migrationId = query.resumeMigrationId;
  let cursor = '';
  if (migrationId) {
    const log = await MongoFullTextMigrationLog.findOne({ migrationId }).lean();
    if (!log) throw new Error(`Migration log not found: ${migrationId}`);
    if (log.status === 'done') throw new Error(`Migration ${migrationId} already done`);
    if (log.oldEngine !== oldEngine || log.newEngine !== newEngine) {
      throw new Error(
        `Migration log engine mismatch: expected ${log.oldEngine}->${log.newEngine}, got ${oldEngine}->${newEngine}`
      );
    }
    cursor = log.cursor || '';
  }

  // 5. 源行数(用于进度与计数校验)
  // mongo 源在续跑时只统计 cursor 之后的剩余行,processed+skipped 应与之一致;
  // milvus 源按行计数(index 粒度含重复行),仅作信息展示。
  const sourceCount =
    oldEngine === 'mongo'
      ? await MongoDatasetDataText.countDocuments(
          cursor ? { _id: { $gt: new Types.ObjectId(cursor) } } : {}
        )
      : oldMilvusClient
        ? await countMilvusTextRows(oldMilvusClient)
        : 0;

  // 6. dry-run:只统计,不建日志不写入
  if (dryRun) {
    return {
      message: `Dry run: ${sourceCount} source rows, ~${Math.max(1, Math.ceil(sourceCount / batchSize))} batches (batchSize=${batchSize})`,
      migrationId,
      status: 'dry-run',
      oldEngine,
      newEngine,
      sourceCount,
      processedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      durationMs: Date.now() - startTime
    };
  }

  // 7. 新建迁移日志(非 dry-run)
  if (!migrationId) {
    migrationId = randomUUID();
    await MongoFullTextMigrationLog.create({
      migrationId,
      oldEngine,
      newEngine,
      status: 'running',
      cursor: '',
      totalCount: sourceCount,
      processedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      updatedAt: new Date(),
      createdAt: new Date()
    });
  }

  // 8. 分批搬运 + 进度持久化
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  while (true) {
    const batch =
      oldEngine === 'mongo'
        ? await readMongoTextBatch(cursor, batchSize)
        : await readMilvusTextBatch(oldMilvusClient!, cursor, batchSize);

    if (batch.dataIds.length === 0) break;

    const result = await processBatch(targetStore, batch.dataIds);
    processed += result.processed;
    skipped += result.skipped;
    failed += result.failed.length;

    if (result.failed.length > 0) {
      await MongoFullTextMigrationFailed.bulkWrite(
        result.failed.map((item) => ({
          updateOne: {
            filter: { migrationId, dataId: item.dataId },
            update: {
              $set: { migrationId, dataId: item.dataId, error: item.error, createdAt: new Date() }
            },
            upsert: true
          }
        })),
        { ordered: false }
      );
    }

    cursor = batch.cursor;
    await MongoFullTextMigrationLog.updateOne(
      { migrationId },
      {
        $set: {
          status: 'running',
          cursor,
          processedCount: processed,
          skippedCount: skipped,
          failedCount: failed,
          updatedAt: new Date()
        }
      }
    );

    logger.info(
      `[initFullTextMigrate] batch done, processed ${processed}/${sourceCount}, failed ${failed}, cursor ${cursor}`
    );
  }

  // 9. 补齐已记录失败行(断点续跑时从 full_text_migration_failed 重试)
  const pendingFailed = await MongoFullTextMigrationFailed.find({ migrationId }).lean();
  for (const row of pendingFailed) {
    if (!Types.ObjectId.isValid(row.dataId)) continue;
    const data = await MongoDatasetData.findById(row.dataId).lean();
    if (!data) {
      await MongoFullTextMigrationFailed.deleteOne({ migrationId, dataId: row.dataId });
      skipped++;
      continue;
    }
    try {
      await targetStore.write([buildItem(data)]);
      await MongoFullTextMigrationFailed.deleteOne({ migrationId, dataId: row.dataId });
      failed = Math.max(0, failed - 1);
      processed++;
    } catch (err) {
      logger.warn(`[initFullTextMigrate] retry failed for dataId ${row.dataId}`, {
        error: getErrText(err)
      });
    }
  }

  // 10. 计数 + removeOld + 收尾
  // 计数校验(§9.3):mongo 源每 dataId 一行,processed+skipped 必须等于 sourceCount,
  // 不等说明有源行未迁移(数据丢失信号),此时禁止 removeOld 兜底可重跑;
  // milvus 源按行计数(index 粒度含重复行),行数与 data 数天然不等,不参与硬校验。
  const countMismatch = oldEngine === 'mongo' && processed + skipped !== sourceCount;
  const targetCount =
    newEngine === 'mongo'
      ? await MongoDatasetDataText.countDocuments({})
      : await countMilvusTextRows(await getTargetMilvusClient(targetStore));

  const status: FullTextMigrationStatus = failed === 0 && !countMismatch ? 'done' : 'failed';

  if (status === 'done' && !countMismatch && removeOld) {
    if (oldEngine === 'mongo') {
      await MongoDatasetDataText.deleteMany({});
      logger.info('[initFullTextMigrate] removed old mongo full-text indexes');
    } else if (oldMilvusClient) {
      await oldMilvusClient.dropCollection({ collection_name: DatasetVectorTextTableName });
      logger.info('[initFullTextMigrate] dropped old milvus full-text collection');
    }
  }

  await MongoFullTextMigrationLog.updateOne(
    { migrationId },
    {
      $set: {
        status,
        cursor,
        processedCount: processed,
        skippedCount: skipped,
        failedCount: failed,
        updatedAt: new Date()
      }
    }
  );

  const message =
    status === 'done'
      ? `Migration done: ${processed} migrated, ${skipped} skipped(orphans/invalid), ${failed} failed. source=${sourceCount}, target=${targetCount}.${removeOld ? ' Old engine indexes removed.' : ''}`
      : countMismatch
        ? `Migration finished with count mismatch: processed+skipped(${processed + skipped}) != source(${sourceCount}). Re-run to cover any missed rows.`
        : `Migration finished with ${failed} failed rows. Run again with resumeMigrationId=${migrationId} to retry.`;

  return {
    message,
    migrationId,
    status,
    oldEngine,
    newEngine,
    sourceCount,
    targetCount,
    processedCount: processed,
    skippedCount: skipped,
    failedCount: failed,
    durationMs: Date.now() - startTime,
    ...(status === 'failed'
      ? {
          error: countMismatch
            ? `count mismatch: processed+skipped(${processed + skipped}) != source(${sourceCount})`
            : `${failed} rows failed, resume with resumeMigrationId to retry`
        }
      : {})
  };
};
