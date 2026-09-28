import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { pool, transaction } from './db.js';
import { downloadInstagram, friendlyDownloadError } from './downloader.js';

const concurrency = Math.max(1, Math.min(8, Number(process.env.DOWNLOAD_CONCURRENCY || 2)));
const pending = [];
const queued = new Set();
let active = 0;

export const batchEvents = new EventEmitter();
batchEvents.setMaxListeners(200);

export function publishBatch(batchId) {
  batchEvents.emit(batchId);
}

export function enqueueJobs(jobIds) {
  for (const jobId of jobIds) {
    if (queued.has(jobId)) continue;
    queued.add(jobId);
    pending.push(jobId);
  }
  drain();
}

async function updateProgress(jobId, batchId, progress) {
  await pool.execute(
    "UPDATE download_jobs SET progress = GREATEST(progress, ?) WHERE id = ? AND status = 'running'",
    [Math.max(1, Math.min(99, Math.round(progress))), jobId],
  );
  publishBatch(batchId);
}

async function refreshBatch(batchId) {
  const [rows] = await pool.execute(
    `SELECT
      COUNT(*) AS total_count,
      SUM(status IN ('success', 'failed')) AS completed_count,
      SUM(status = 'success') AS success_count,
      SUM(status = 'failed') AS failed_count,
      SUM(status = 'running') AS running_count
    FROM download_jobs WHERE batch_id = ?`,
    [batchId],
  );
  const summary = rows[0];
  const total = Number(summary.total_count || 0);
  const completed = Number(summary.completed_count || 0);
  const succeeded = Number(summary.success_count || 0);
  const failed = Number(summary.failed_count || 0);
  const running = Number(summary.running_count || 0);
  let status = running || completed < total ? 'running' : 'completed';
  if (completed === total && failed === total) status = 'failed';
  else if (completed === total && failed > 0) status = 'partial';

  await pool.execute(
    `UPDATE download_batches
      SET status = ?, total_count = ?, completed_count = ?, success_count = ?, failed_count = ?
      WHERE id = ?`,
    [status, total, completed, succeeded, failed, batchId],
  );
  publishBatch(batchId);
}

async function completeJob(job, results) {
  await transaction(async (connection) => {
    await connection.execute('DELETE FROM download_results WHERE job_id = ?', [job.id]);
    for (const result of results) {
      await connection.execute(
        `INSERT INTO download_results
          (id, job_id, media_type, file_name, file_path, mime_type, quality, byte_size)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          job.id,
          result.mediaType,
          result.fileName,
          result.filePath,
          result.mimeType,
          result.quality,
          result.byteSize,
        ],
      );
    }
    await connection.execute(
      `UPDATE download_jobs
        SET status = 'success', progress = 100, error_code = NULL, error_message = NULL, finished_at = NOW(3)
        WHERE id = ?`,
      [job.id],
    );
    await connection.execute(
      `INSERT INTO history
        (id, user_id, guest_id, job_id, source_url, content_type, status, quality, searched_keywords)
        VALUES (?, ?, ?, ?, ?, ?, 'success', 'original', ?)
        ON DUPLICATE KEY UPDATE status = 'success', quality = 'original', created_at = NOW(3)`,
      [crypto.randomUUID(), job.user_id, job.guest_id, job.id, job.source_url, job.content_type, job.shortcode],
    );
  });
}

async function failJob(job, error) {
  const friendly = friendlyDownloadError(error);
  await transaction(async (connection) => {
    await connection.execute(
      `UPDATE download_jobs
        SET status = 'failed', progress = 100, error_code = ?, error_message = ?, finished_at = NOW(3)
        WHERE id = ?`,
      [friendly.code, friendly.message, job.id],
    );
    await connection.execute(
      `INSERT INTO history
        (id, user_id, guest_id, job_id, source_url, content_type, status, quality, searched_keywords)
        VALUES (?, ?, ?, ?, ?, ?, 'failed', NULL, ?)
        ON DUPLICATE KEY UPDATE status = 'failed', quality = NULL, created_at = NOW(3)`,
      [crypto.randomUUID(), job.user_id, job.guest_id, job.id, job.source_url, job.content_type, job.shortcode],
    );
  });
}

async function runJob(jobId) {
  const [rows] = await pool.execute('SELECT * FROM download_jobs WHERE id = ?', [jobId]);
  const job = rows[0];
  if (!job || job.status !== 'pending') return;

  await pool.execute(
    "UPDATE download_jobs SET status = 'running', progress = 5, started_at = NOW(3), finished_at = NULL WHERE id = ?",
    [job.id],
  );
  await pool.execute("UPDATE download_batches SET status = 'running' WHERE id = ?", [job.batch_id]);
  publishBatch(job.batch_id);

  let lastProgress = 5;
  try {
    const results = await downloadInstagram({
      id: job.id,
      sourceUrl: job.source_url,
      shortcode: job.shortcode,
      contentType: job.content_type,
      onProgress(progress) {
        const rounded = Math.round(progress);
        if (rounded <= lastProgress) return;
        lastProgress = rounded;
        void updateProgress(job.id, job.batch_id, rounded).catch(console.error);
      },
    });
    await completeJob(job, results);
  } catch (error) {
    console.error(`Unduhan ${job.id} gagal:`, error.message);
    await failJob(job, error);
  } finally {
    await refreshBatch(job.batch_id);
  }
}

function drain() {
  while (active < concurrency && pending.length) {
    const jobId = pending.shift();
    active += 1;
    void runJob(jobId)
      .catch((error) => console.error(`Worker ${jobId} gagal:`, error))
      .finally(() => {
        queued.delete(jobId);
        active -= 1;
        drain();
      });
  }
}

export async function recoverQueue() {
  await pool.execute("UPDATE download_jobs SET status = 'pending', progress = 0 WHERE status = 'running'");
  const [rows] = await pool.execute("SELECT id FROM download_jobs WHERE status = 'pending' ORDER BY created_at ASC");
  enqueueJobs(rows.map((row) => row.id));
}
