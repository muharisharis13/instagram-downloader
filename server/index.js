import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { connectWithRetry, migrate, pool, transaction } from './db.js';
import {
  HttpError,
  assertContentType,
  hashPassword,
  hashToken,
  normalizeIdentity,
  parseCookies,
  parseInstagramInput,
  randomToken,
  validatePassword,
  verifyPassword,
} from './core.js';
import { createArchive, isManagedDownloadPath } from './downloader.js';
import { batchEvents, enqueueJobs, recoverQueue } from './queue.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const appOrigin = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin : null;
const secureCookies = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === '1'
  : appOrigin
    ? appOrigin.startsWith('https://')
    : isProduction;
const sessionCookie = 'unduhgram_session';
const guestCookie = 'unduhgram_guest';
const terminalStatuses = new Set(['completed', 'partial', 'failed']);
const dummyPasswordHash = await hashPassword(randomToken());

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_request, response, next) => {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  };
  if (secureCookies) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  response.set(headers);
  next();
});
app.use(express.json({ limit: '256kb' }));

const asyncRoute = (handler) => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    path: '/',
    maxAge,
  };
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, email: user.email, phone: user.phone, createdAt: user.created_at };
}

function requireUser(request) {
  if (!request.user) throw new HttpError(401, 'Masuk diperlukan untuk fitur ini.', 'AUTH_REQUIRED');
  return request.user;
}

function ownerCondition(request, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  if (request.user) return { sql: `${prefix}user_id = ?`, values: [request.user.id] };
  return { sql: `${prefix}user_id IS NULL AND ${prefix}guest_id = ?`, values: [request.guestId] };
}

function rateLimit({ windowMs, max }) {
  const attempts = new Map();
  return (request, _response, next) => {
    const key = `${request.ip}:${request.path}`;
    const now = Date.now();
    const current = attempts.get(key);
    if (!current || current.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    current.count += 1;
    if (current.count > max) {
      next(new HttpError(429, 'Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.', 'RATE_LIMITED'));
      return;
    }
    next();
  };
}

app.use('/api', (request, response, next) => {
  response.set('Cache-Control', 'no-store');
  const cookies = parseCookies(request.headers.cookie);
  let guestToken = cookies[guestCookie];
  if (!guestToken || !/^[a-zA-Z0-9_-]{30,100}$/.test(guestToken)) {
    guestToken = randomToken(24);
    response.cookie(guestCookie, guestToken, cookieOptions(365 * 24 * 60 * 60 * 1000));
  }
  request.guestToken = guestToken;
  request.guestId = hashToken(guestToken);
  next();
});

app.use('/api', (request, _response, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    next();
    return;
  }
  const origin = request.get('origin');
  if (!origin) {
    next();
    return;
  }
  const hostOrigin = `${request.protocol}://${request.get('host')}`;
  if (origin !== appOrigin && origin !== hostOrigin) {
    next(new HttpError(403, 'Permintaan lintas situs ditolak.', 'INVALID_ORIGIN'));
    return;
  }
  next();
});

app.use(
  '/api',
  asyncRoute(async (request, response, next) => {
    const token = parseCookies(request.headers.cookie)[sessionCookie];
    if (!token) {
      next();
      return;
    }
    const [rows] = await pool.execute(
      `SELECT u.*, s.id AS session_id
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > NOW(3)`,
      [hashToken(token)],
    );
    request.user = rows[0] || null;
    if (!request.user) response.clearCookie(sessionCookie, cookieOptions(0));
    next();
  }),
);

async function claimGuestData(userId, guestId) {
  await transaction(async (connection) => {
    for (const table of ['download_batches', 'download_jobs', 'history']) {
      await connection.execute(`UPDATE ${table} SET user_id = ?, guest_id = NULL WHERE user_id IS NULL AND guest_id = ?`, [
        userId,
        guestId,
      ]);
    }
  });
}

async function createSession(userId, request, response) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await pool.execute('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', [
    hashToken(token),
    userId,
    expiresAt,
  ]);
  response.cookie(sessionCookie, token, cookieOptions(30 * 24 * 60 * 60 * 1000));
  await claimGuestData(userId, request.guestId);
}

async function preferredContentType(request) {
  if (!request.user) return 'both';
  const [rows] = await pool.execute('SELECT default_content_type FROM user_preferences WHERE user_id = ?', [request.user.id]);
  return rows[0]?.default_content_type || 'both';
}

async function createBatch(request, parsedLinks, requestedContentType) {
  const contentType = assertContentType(requestedContentType || (await preferredContentType(request)));
  const batchId = crypto.randomUUID();
  const jobs = parsedLinks.map((link) => ({ id: crypto.randomUUID(), ...link }));
  await transaction(async (connection) => {
    await connection.execute(
      `INSERT INTO download_batches
        (id, user_id, guest_id, content_type, total_count)
        VALUES (?, ?, ?, ?, ?)`,
      [batchId, request.user?.id || null, request.user ? null : request.guestId, contentType, jobs.length],
    );
    for (const job of jobs) {
      await connection.execute(
        `INSERT INTO download_jobs
          (id, batch_id, user_id, guest_id, source_url, shortcode, content_type)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          job.id,
          batchId,
          request.user?.id || null,
          request.user ? null : request.guestId,
          job.url,
          job.shortcode,
          contentType,
        ],
      );
    }
  });
  enqueueJobs(jobs.map((job) => job.id));
  return { batchId, contentType, jobIds: jobs.map((job) => job.id) };
}

async function findOwnedBatch(request, batchId) {
  const owner = ownerCondition(request);
  const [rows] = await pool.execute(`SELECT * FROM download_batches WHERE id = ? AND ${owner.sql}`, [batchId, ...owner.values]);
  if (!rows[0]) throw new HttpError(404, 'Proses unduhan tidak ditemukan.', 'BATCH_NOT_FOUND');
  return rows[0];
}

async function batchSnapshot(request, batchId) {
  const batch = await findOwnedBatch(request, batchId);
  const [jobs] = await pool.execute(
    `SELECT id, source_url, shortcode, content_type, status, progress, error_code, error_message,
            created_at, started_at, finished_at
     FROM download_jobs WHERE batch_id = ? ORDER BY created_at ASC`,
    [batchId],
  );
  const [results] = await pool.execute(
    `SELECT r.id, r.job_id, r.media_type, r.file_name, r.mime_type, r.quality, r.byte_size, r.created_at
     FROM download_results r JOIN download_jobs j ON j.id = r.job_id
     WHERE j.batch_id = ? ORDER BY r.created_at ASC`,
    [batchId],
  );
  const resultMap = new Map();
  for (const result of results) {
    const list = resultMap.get(result.job_id) || [];
    list.push({
      id: result.id,
      mediaType: result.media_type,
      fileName: result.file_name,
      mimeType: result.mime_type,
      quality: result.quality,
      byteSize: Number(result.byte_size),
      createdAt: result.created_at,
      fileUrl: `/api/results/${result.id}/file`,
    });
    resultMap.set(result.job_id, list);
  }
  const progress = jobs.length ? Math.round(jobs.reduce((sum, job) => sum + Number(job.progress), 0) / jobs.length) : 0;
  return {
    id: batch.id,
    contentType: batch.content_type,
    status: batch.status,
    progress,
    totalCount: Number(batch.total_count),
    completedCount: Number(batch.completed_count),
    successCount: Number(batch.success_count),
    failedCount: Number(batch.failed_count),
    createdAt: batch.created_at,
    updatedAt: batch.updated_at,
    done: terminalStatuses.has(batch.status),
    archiveUrl: `/api/downloads/${batch.id}/archive`,
    jobs: jobs.map((job) => ({
      id: job.id,
      sourceUrl: job.source_url,
      shortcode: job.shortcode,
      contentType: job.content_type,
      status: job.status,
      progress: Number(job.progress),
      errorCode: job.error_code,
      errorMessage: job.error_message,
      createdAt: job.created_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      results: resultMap.get(job.id) || [],
    })),
  };
}

app.get('/api/health', asyncRoute(async (_request, response) => {
  await pool.query('SELECT 1');
  response.json({ ok: true });
}));

app.post('/api/links/validate', (request, response) => {
  const parsed = parseInstagramInput(request.body?.text ?? request.body?.links ?? '');
  response.json(parsed);
});

app.get('/api/auth/session', (request, response) => {
  response.json({ user: publicUser(request.user) });
});

app.post(
  '/api/auth/register',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }),
  asyncRoute(async (request, response) => {
    const identity = normalizeIdentity(request.body);
    if (!identity.email && !identity.phone) {
      throw new HttpError(400, 'Masukkan email atau nomor telepon yang valid.', 'INVALID_IDENTITY');
    }
    const passwordHash = await hashPassword(request.body?.password);
    const userId = crypto.randomUUID();
    try {
      await transaction(async (connection) => {
        await connection.execute('INSERT INTO users (id, email, phone, password_hash) VALUES (?, ?, ?, ?)', [
          userId,
          identity.email,
          identity.phone,
          passwordHash,
        ]);
        await connection.execute('INSERT INTO user_preferences (user_id) VALUES (?)', [userId]);
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        throw new HttpError(409, 'Email atau nomor telepon sudah digunakan.', 'IDENTITY_EXISTS');
      }
      throw error;
    }
    await createSession(userId, request, response);
    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    response.status(201).json({ user: publicUser(rows[0]) });
  }),
);

app.post(
  '/api/auth/login',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 12 }),
  asyncRoute(async (request, response) => {
    const identity = normalizeIdentity(request.body);
    const password = String(request.body?.password || '');
    const [rows] = identity.email
      ? await pool.execute('SELECT * FROM users WHERE email = ?', [identity.email])
      : identity.phone
        ? await pool.execute('SELECT * FROM users WHERE phone = ?', [identity.phone])
        : [[]];
    const user = rows[0];
    const validPassword = await verifyPassword(password, user?.password_hash || dummyPasswordHash);
    if (!user || !validPassword) {
      throw new HttpError(401, 'Email/nomor telepon atau sandi salah.', 'INVALID_CREDENTIALS');
    }
    await createSession(user.id, request, response);
    response.json({ user: publicUser(user) });
  }),
);

app.post(
  '/api/auth/logout',
  asyncRoute(async (request, response) => {
    const token = parseCookies(request.headers.cookie)[sessionCookie];
    if (token) await pool.execute('DELETE FROM sessions WHERE id = ?', [hashToken(token)]);
    response.clearCookie(sessionCookie, cookieOptions(0));
    response.status(204).end();
  }),
);

app.post(
  '/api/auth/forgot-password',
  rateLimit({ windowMs: 30 * 60 * 1000, max: 6 }),
  asyncRoute(async (request, response) => {
    const identity = normalizeIdentity(request.body);
    let user;
    if (identity.email) {
      const [rows] = await pool.execute('SELECT id FROM users WHERE email = ?', [identity.email]);
      user = rows[0];
    } else if (identity.phone) {
      const [rows] = await pool.execute('SELECT id FROM users WHERE phone = ?', [identity.phone]);
      user = rows[0];
    }

    let debugResetToken;
    if (user) {
      const token = randomToken();
      await pool.execute('DELETE FROM password_resets WHERE user_id = ? OR expires_at <= NOW(3)', [user.id]);
      await pool.execute(
        'INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(3), INTERVAL 30 MINUTE))',
        [hashToken(token), user.id],
      );
      if (!isProduction) debugResetToken = token;
      else console.info(`Token reset dibuat untuk pengguna ${user.id}; hubungkan provider email/SMS untuk pengiriman.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    response.json({
      message: 'Jika akun terdaftar, petunjuk atur ulang sandi sudah dikirim.',
      ...(debugResetToken ? { debugResetToken } : {}),
    });
  }),
);

app.post(
  '/api/auth/reset-password',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }),
  asyncRoute(async (request, response) => {
    const token = String(request.body?.token || '');
    if (token.length < 30 || token.length > 200) throw new HttpError(400, 'Kode reset tidak valid.', 'INVALID_RESET_TOKEN');
    const passwordHash = await hashPassword(request.body?.password);
    const [rows] = await pool.execute(
      `SELECT * FROM password_resets
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW(3)`,
      [hashToken(token)],
    );
    const reset = rows[0];
    if (!reset) throw new HttpError(400, 'Kode reset tidak valid atau sudah kedaluwarsa.', 'INVALID_RESET_TOKEN');
    await transaction(async (connection) => {
      await connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, reset.user_id]);
      await connection.execute('UPDATE password_resets SET used_at = NOW(3) WHERE token_hash = ?', [reset.token_hash]);
      await connection.execute('DELETE FROM sessions WHERE user_id = ?', [reset.user_id]);
    });
    response.json({ message: 'Sandi berhasil diubah. Silakan masuk kembali.' });
  }),
);

app.get(
  '/api/preferences',
  asyncRoute(async (request, response) => {
    const user = requireUser(request);
    const [rows] = await pool.execute('SELECT * FROM user_preferences WHERE user_id = ?', [user.id]);
    const preference = rows[0] || { default_content_type: 'both', default_quality: 'best' };
    response.json({
      defaultContentType: preference.default_content_type,
      defaultQuality: preference.default_quality,
      updatedAt: preference.updated_at || null,
    });
  }),
);

app.put(
  '/api/preferences',
  asyncRoute(async (request, response) => {
    const user = requireUser(request);
    const contentType = assertContentType(request.body?.defaultContentType);
    const quality = request.body?.defaultQuality === 'best' ? 'best' : 'best';
    await pool.execute(
      `INSERT INTO user_preferences (user_id, default_content_type, default_quality)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE default_content_type = VALUES(default_content_type),
                               default_quality = VALUES(default_quality), updated_at = NOW(3)`,
      [user.id, contentType, quality],
    );
    response.json({ defaultContentType: contentType, defaultQuality: quality, message: 'Preferensi berhasil disimpan.' });
  }),
);

app.post(
  '/api/downloads',
  rateLimit({ windowMs: 60 * 1000, max: 20 }),
  asyncRoute(async (request, response) => {
    const parsed = parseInstagramInput(request.body?.links ?? request.body?.text ?? '');
    if (!parsed.valid.length) throw new HttpError(400, 'Belum ada link Instagram valid untuk diunduh.', 'NO_VALID_LINKS');
    if (parsed.valid.length > 25) throw new HttpError(400, 'Maksimal 25 link dalam satu proses.', 'TOO_MANY_LINKS');
    const created = await createBatch(request, parsed.valid, request.body?.contentType);
    response.status(202).json({ ...created, invalid: parsed.invalid });
  }),
);

app.get(
  '/api/downloads/:batchId',
  asyncRoute(async (request, response) => {
    response.json(await batchSnapshot(request, request.params.batchId));
  }),
);

app.get(
  '/api/downloads/:batchId/events',
  asyncRoute(async (request, response) => {
    await findOwnedBatch(request, request.params.batchId);
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();

    let closed = false;
    const sendSnapshot = async () => {
      if (closed) return;
      try {
        const snapshot = await batchSnapshot(request, request.params.batchId);
        response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      } catch (error) {
        response.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      }
    };
    const listener = () => void sendSnapshot();
    batchEvents.on(request.params.batchId, listener);
    await sendSnapshot();
    const heartbeat = setInterval(() => response.write(': tetap-terhubung\n\n'), 20000);
    request.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      batchEvents.off(request.params.batchId, listener);
    });
  }),
);

app.post(
  '/api/downloads/:batchId/retry',
  asyncRoute(async (request, response) => {
    await findOwnedBatch(request, request.params.batchId);
    const [rows] = await pool.execute("SELECT id FROM download_jobs WHERE batch_id = ? AND status = 'failed'", [
      request.params.batchId,
    ]);
    if (!rows.length) throw new HttpError(409, 'Tidak ada unduhan gagal untuk diulangi.', 'NOTHING_TO_RETRY');
    await pool.execute(
      `UPDATE download_jobs
       SET status = 'pending', progress = 0, error_code = NULL, error_message = NULL, started_at = NULL, finished_at = NULL
       WHERE batch_id = ? AND status = 'failed'`,
      [request.params.batchId],
    );
    await pool.execute("UPDATE download_batches SET status = 'running' WHERE id = ?", [request.params.batchId]);
    enqueueJobs(rows.map((row) => row.id));
    response.status(202).json({ message: `${rows.length} unduhan gagal sedang diulangi.` });
  }),
);

app.get(
  '/api/downloads/:batchId/results',
  asyncRoute(async (request, response) => {
    const snapshot = await batchSnapshot(request, request.params.batchId);
    response.json({ results: snapshot.jobs.flatMap((job) => job.results), failedCount: snapshot.failedCount });
  }),
);

app.get(
  '/api/downloads/:batchId/archive',
  asyncRoute(async (request, response) => {
    const batch = await findOwnedBatch(request, request.params.batchId);
    const [rows] = await pool.execute(
      `SELECT r.file_path
       FROM download_results r JOIN download_jobs j ON j.id = r.job_id
       WHERE j.batch_id = ? AND j.status = 'success'`,
      [batch.id],
    );
    const available = [];
    let missing = 0;
    for (const row of rows) {
      if (!isManagedDownloadPath(row.file_path)) {
        missing += 1;
        continue;
      }
      try {
        await fs.access(row.file_path);
        available.push(row.file_path);
      } catch {
        missing += 1;
      }
    }
    if (!available.length) throw new HttpError(409, 'Belum ada hasil berhasil untuk disimpan.', 'NO_RESULTS');
    const archivePath = await createArchive(batch.id, available);
    if (missing || Number(batch.failed_count)) {
      response.set('X-Download-Warnings', `${missing + Number(batch.failed_count)} item tidak masuk arsip`);
    }
    response.download(archivePath, `unduhgram_${batch.id.slice(0, 8)}.zip`);
  }),
);

app.get(
  '/api/results/:resultId/file',
  asyncRoute(async (request, response) => {
    const owner = ownerCondition(request, 'b');
    const [rows] = await pool.execute(
      `SELECT r.file_path, r.file_name, r.mime_type
       FROM download_results r
       JOIN download_jobs j ON j.id = r.job_id
       JOIN download_batches b ON b.id = j.batch_id
       WHERE r.id = ? AND ${owner.sql}`,
      [request.params.resultId, ...owner.values],
    );
    const result = rows[0];
    if (!result || !isManagedDownloadPath(result.file_path)) {
      throw new HttpError(404, 'File hasil tidak ditemukan.', 'RESULT_NOT_FOUND');
    }
    await fs.access(result.file_path);
    response.sendFile(path.resolve(result.file_path), {
      headers: {
        'Content-Type': result.mime_type,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(result.file_name)}`,
        'Cache-Control': 'private, max-age=3600',
      },
    });
  }),
);

app.get(
  '/api/history',
  asyncRoute(async (request, response) => {
    const owner = ownerCondition(request, 'h');
    const query = String(request.query.q || '').trim().slice(0, 100);
    const searchSql = query ? 'AND (h.source_url LIKE ? OR h.searched_keywords LIKE ?)' : '';
    const searchValues = query ? [`%${query}%`, `%${query}%`] : [];
    const [rows] = await pool.execute(
      `SELECT h.id, h.job_id, h.source_url, h.content_type, h.status, h.quality, h.created_at,
              j.error_message,
              (SELECT COUNT(*) FROM download_results r WHERE r.job_id = h.job_id) AS result_count
       FROM history h JOIN download_jobs j ON j.id = h.job_id
       WHERE ${owner.sql} ${searchSql}
       ORDER BY h.created_at DESC LIMIT 100`,
      [...owner.values, ...searchValues],
    );
    response.json({
      items: rows.map((row) => ({
        id: row.id,
        jobId: row.job_id,
        sourceUrl: row.source_url,
        contentType: row.content_type,
        status: row.status,
        quality: row.quality,
        errorMessage: row.error_message,
        resultCount: Number(row.result_count),
        createdAt: row.created_at,
      })),
    });
  }),
);

app.post(
  '/api/history/:historyId/redownload',
  asyncRoute(async (request, response) => {
    const owner = ownerCondition(request, 'h');
    const [rows] = await pool.execute(
      `SELECT h.source_url, h.content_type, j.shortcode
       FROM history h JOIN download_jobs j ON j.id = h.job_id
       WHERE h.id = ? AND ${owner.sql}`,
      [request.params.historyId, ...owner.values],
    );
    const history = rows[0];
    if (!history) throw new HttpError(404, 'Riwayat tidak ditemukan.', 'HISTORY_NOT_FOUND');
    const created = await createBatch(
      request,
      [{ url: history.source_url, shortcode: history.shortcode }],
      history.content_type,
    );
    response.status(202).json({ ...created, message: 'Unduhan ulang dimulai.' });
  }),
);

const faqs = [
  {
    id: 'invalid-link',
    question: 'Mengapa link ditandai tidak valid?',
    answer: 'Gunakan link postingan, Reel, atau video dari instagram.com. Link profil dan Story tidak didukung.',
  },
  {
    id: 'private-post',
    question: 'Bisakah postingan privat diunduh?',
    answer: 'Mode tanpa cookies hanya mengambil konten publik. Postingan privat tidak didukung.',
  },
  {
    id: 'missing-media',
    question: 'Mengapa hasil foto atau video kosong?',
    answer: 'Jenis media pilihan mungkin tidak tersedia pada postingan. Pilih Foto + Video lalu coba ulangi.',
  },
  {
    id: 'rate-limit',
    question: 'Mengapa Instagram membatasi permintaan?',
    answer: 'Akses langsung dari IP server dapat dibatasi. Operator dapat memakai provider unduhan untuk konten publik tanpa sesi Instagram.',
  },
];

app.get('/api/faqs', (_request, response) => response.json({ items: faqs }));

app.post(
  '/api/support/messages',
  rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }),
  asyncRoute(async (request, response) => {
    const name = String(request.body?.name || '').trim().slice(0, 100);
    const email = String(request.body?.email || '').trim().toLowerCase().slice(0, 255);
    const message = String(request.body?.message || '').trim().slice(0, 5000);
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || message.length < 10) {
      throw new HttpError(400, 'Lengkapi nama, email, dan pesan minimal 10 karakter.', 'INVALID_SUPPORT_MESSAGE');
    }
    await pool.execute(
      'INSERT INTO support_messages (id, user_id, name, email, message) VALUES (?, ?, ?, ?, ?)',
      [crypto.randomUUID(), request.user?.id || null, name, email, message],
    );
    response.status(201).json({ message: 'Pesan terkirim. Tim bantuan merespons maksimal 2 hari kerja.' });
  }),
);

app.use('/api', (_request, _response, next) => next(new HttpError(404, 'Endpoint tidak ditemukan.', 'NOT_FOUND')));

const distDirectory = path.resolve('dist');
app.use(express.static(distDirectory, { index: false, maxAge: isProduction ? '1h' : 0 }));
app.use(asyncRoute(async (request, response, next) => {
  if (request.method !== 'GET') {
    next();
    return;
  }
  try {
    await fs.access(path.join(distDirectory, 'index.html'));
    response.sendFile(path.join(distDirectory, 'index.html'));
  } catch {
    response.status(404).json({ message: 'Frontend belum dibangun. Jalankan npm run dev:web atau npm run build.' });
  }
}));

app.use((error, _request, response, _next) => {
  if (response.headersSent) return;
  const status = Number(error.status || 500);
  if (status >= 500) console.error(error);
  response.status(status).json({
    message: status >= 500 ? 'Terjadi gangguan pada server.' : error.message,
    code: error.code || 'INTERNAL_ERROR',
  });
});

await connectWithRetry();
await migrate();
await pool.execute('DELETE FROM sessions WHERE expires_at <= NOW(3)');
await pool.execute('DELETE FROM password_resets WHERE expires_at <= NOW(3) OR used_at IS NOT NULL');
await recoverQueue();

app.listen(port, () => {
  console.log(`UnduhGram berjalan di http://localhost:${port}`);
});
