import { NextAPI } from '@/service/middleware/entry';
import { authCert } from '@fastgpt/service/support/permission/auth/common';
import { migrateCollectionPermissions } from '@fastgpt/service/core/dataset/collection/migrateCollectionPermission';
import { getLogger, LogCategories } from '@fastgpt/service/common/logger';
import { type NextApiRequest, type NextApiResponse } from 'next';

const logger = getLogger(LogCategories.MODULE.DATASET.COLLECTION);

/**
 * One-time admin task: migrate legacy (Dataset-level) Collection permissions to the
 * Collection-level permission model. Follows the existing migration
 * convention of the `initv4143` / `initv4144` admin endpoints:
 * - restricted to the system root account (`authRoot: true`);
 * - idempotent and resume-safe via `permissionMigrationVersion` on
 *   `dataset_collections` (missing / behind-version Collections are re-processed);
 * - each Dataset is committed in its own transaction; failed Datasets are reported
 *   and do not block the others.
 *
 * Body (optional):
 *   { batchSize?: number; datasetIds?: string[] }
 */
async function handler(req: NextApiRequest, _res: NextApiResponse) {
  await authCert({ req, authRoot: true });

  const body = (req.body ?? {}) as { batchSize?: number; datasetIds?: string[] };
  const batchSize = typeof body.batchSize === 'number' ? body.batchSize : undefined;
  const datasetIds = Array.isArray(body.datasetIds) ? body.datasetIds : undefined;

  logger.info('Starting collection permission migration', { batchSize, datasetIds });

  const result = await migrateCollectionPermissions({ batchSize, datasetIds });

  logger.info('Collection permission migration finished', {
    migratedDatasets: result.migratedDatasets,
    failedCount: result.failed.length
  });

  return result;
}

export default NextAPI(handler);
