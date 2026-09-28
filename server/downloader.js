import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buildFileName, mediaTypeFromExtension, mimeFromExtension } from './core.js';

const downloadRoot = path.resolve(process.env.DOWNLOAD_DIR || './storage/downloads');
const archiveRoot = path.resolve(process.env.ARCHIVE_DIR || './storage/archives');
const timeoutMs = Number(process.env.DOWNLOAD_TIMEOUT_MS || 600000);
const downloadDebug = process.env.DOWNLOAD_DEBUG === '1';

function redactDiagnostics(value) {
  return String(value || '')
    .replace(/(authorization|cookie|set-cookie)(\s*[:=]\s*)[^\n]+/gi, '$1$2<redacted>')
    .replace(/https?:\/\/[^\s]+/g, (rawUrl) => {
      try {
        const parsed = new URL(rawUrl);
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
      } catch {
        return '<url-redacted>';
      }
    });
}

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(fullPath)));
    else files.push(fullPath);
  }
  return files;
}

function run(command, args, { onLine, timeout = timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 5000);
      forceKill.unref();
      reject(
        Object.assign(new Error(`Proses unduhan melewati batas waktu ${Math.round(timeout / 1000)} detik.`), {
          code: 'DOWNLOAD_TIMEOUT',
          diagnostics: redactDiagnostics(output),
          elapsedMs: Date.now() - startedAt,
        }),
      );
    }, timeout);

    const collect = (chunk) => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-12000);
      for (const line of text.split('\n').filter(Boolean)) onLine?.(line);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error.diagnostics = redactDiagnostics(output);
      error.elapsedMs = Date.now() - startedAt;
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else {
        reject(
          Object.assign(new Error(output || `Proses berhenti dengan kode ${code}.`), {
            code: 'DOWNLOADER_FAILED',
            diagnostics: redactDiagnostics(output),
            elapsedMs: Date.now() - startedAt,
          }),
        );
      }
    });
  });
}

function matchesSelection(mediaType, contentType) {
  return contentType === 'both' || mediaType === contentType;
}

export function resolveInstagramProvider({ provider = process.env.INSTAGRAM_PROVIDER, apifyToken = process.env.APIFY_TOKEN } = {}) {
  const normalized = String(provider || 'auto').trim().toLowerCase();
  if (normalized === 'auto') return String(apifyToken || '').trim() ? 'apify' : 'gallery-dl';
  if (normalized === 'apify' || normalized === 'gallery-dl') return normalized;
  throw Object.assign(new Error(`Provider Instagram tidak dikenal: ${normalized}`), { code: 'PROVIDER_NOT_CONFIGURED' });
}

function normalizeApifyActor(value) {
  const actor = String(value || 'apify~instagram-api-scraper').trim().replace('/', '~');
  if (!/^[a-zA-Z0-9_-]+~[a-zA-Z0-9_-]+$/.test(actor)) {
    throw Object.assign(new Error('APIFY_INSTAGRAM_ACTOR tidak valid.'), { code: 'PROVIDER_NOT_CONFIGURED' });
  }
  return actor;
}

export function extractApifyMedia(items) {
  const media = [];
  const seen = new Set();
  const add = (url, mediaType) => {
    if (typeof url !== 'string' || !url || seen.has(url)) return;
    seen.add(url);
    media.push({ url, mediaType });
  };

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.childPosts) && item.childPosts.length) {
      for (const child of item.childPosts) {
        if (child?.videoUrl) add(child.videoUrl, 'video');
        else add(child?.displayUrl, 'photo');
      }
      continue;
    }
    if (Array.isArray(item.mediaAssets) && item.mediaAssets.length) {
      for (const asset of item.mediaAssets) add(asset?.url, asset?.isVideo ? 'video' : 'photo');
      continue;
    }
    if (item.videoUrl) add(item.videoUrl, 'video');
    else if (item.displayUrl) add(item.displayUrl, 'photo');
    if (!item.videoUrl && Array.isArray(item.videos)) {
      for (const url of item.videos) add(url, 'video');
    }
    if (!item.displayUrl && Array.isArray(item.images)) {
      for (const url of item.images) add(url, 'photo');
    }
  }

  return media;
}

function assertProviderMediaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error('URL media provider tidak valid.'), { code: 'PROVIDER_FAILED' });
  }
  const hostname = url.hostname.toLowerCase();
  const allowedSuffixes = ['cdninstagram.com', 'fbcdn.net', 'instagram.com', 'apify.com', 'apifyusercontent.com'];
  const allowed = url.protocol === 'https:' && allowedSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  if (!allowed) throw Object.assign(new Error(`Host media provider tidak diizinkan: ${hostname}`), { code: 'PROVIDER_FAILED' });
  return url;
}

function extensionFromResponse(response, mediaType) {
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const contentExtensions = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  };
  const contentExtension = contentExtensions[contentType];
  if (contentExtension && mediaTypeFromExtension(contentExtension) === mediaType) return contentExtension;
  const urlExtension = path.extname(new URL(response.url).pathname).toLowerCase();
  if (mediaTypeFromExtension(urlExtension) === mediaType) return urlExtension;
  return mediaType === 'video' ? '.mp4' : '.jpg';
}

async function downloadProviderMedia({ item, index, jobDirectory }) {
  const mediaUrl = assertProviderMediaUrl(item.url);
  let response;
  try {
    response = await fetch(mediaUrl, {
      headers: {
        accept: item.mediaType === 'video' ? 'video/*' : 'image/*',
        referer: 'https://www.instagram.com/',
        'user-agent': 'Mozilla/5.0 (compatible; UnduhGram/1.0)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(Math.min(timeoutMs, 180000)),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw Object.assign(new Error('Pengambilan media dari provider melewati batas waktu.'), { code: 'DOWNLOAD_TIMEOUT' });
    }
    throw Object.assign(new Error(`Media provider gagal diambil: ${error.message}`), { code: 'PROVIDER_FAILED' });
  }

  assertProviderMediaUrl(response.url);
  if (!response.ok || !response.body) {
    const code = response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_FAILED';
    throw Object.assign(new Error(`Media provider merespons HTTP ${response.status}.`), { code });
  }

  const extension = extensionFromResponse(response, item.mediaType);
  const filePath = path.join(jobDirectory, `provider_${String(index + 1).padStart(2, '0')}${extension}`);
  const partialPath = `${filePath}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath, { flags: 'wx' }));
    await fs.rename(partialPath, filePath);
  } catch (error) {
    await fs.rm(partialPath, { force: true });
    throw Object.assign(new Error(`Media provider gagal disimpan: ${error.message}`), { code: 'PROVIDER_FAILED' });
  }
}

async function downloadWithApify({ sourceUrl, contentType, jobDirectory, onProgress }) {
  const token = String(process.env.APIFY_TOKEN || '').trim();
  if (!token) throw Object.assign(new Error('APIFY_TOKEN belum diisi.'), { code: 'PROVIDER_NOT_CONFIGURED' });
  const actor = normalizeApifyActor(process.env.APIFY_INSTAGRAM_ACTOR);
  const endpoint = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?clean=true&timeout=300`;
  let response;
  const startedAt = Date.now();

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ directUrls: [sourceUrl], resultsType: 'posts', resultsLimit: 1 }),
      signal: AbortSignal.timeout(Math.min(timeoutMs, 310000)),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw Object.assign(new Error('Provider unduhan melewati batas waktu.'), {
        code: 'DOWNLOAD_TIMEOUT',
        elapsedMs: Date.now() - startedAt,
      });
    }
    throw Object.assign(new Error(`Provider unduhan gagal dihubungi: ${error.message}`), {
      code: 'PROVIDER_FAILED',
      elapsedMs: Date.now() - startedAt,
    });
  }

  const raw = await response.text();
  if (!response.ok) {
    const code = response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_FAILED';
    throw Object.assign(new Error(`Provider unduhan merespons HTTP ${response.status}.`), {
      code,
      diagnostics: redactDiagnostics(raw).slice(-12000),
      elapsedMs: Date.now() - startedAt,
    });
  }

  let items;
  try {
    items = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Provider unduhan mengirim respons tidak valid.'), {
      code: 'PROVIDER_FAILED',
      diagnostics: redactDiagnostics(raw).slice(-12000),
      elapsedMs: Date.now() - startedAt,
    });
  }

  const media = extractApifyMedia(items);
  const selected = media.filter((item) => matchesSelection(item.mediaType, contentType));
  if (!selected.length) {
    if (media.length) {
      const label = contentType === 'photo' ? 'foto' : 'video';
      throw Object.assign(new Error(`Postingan ini tidak memiliki ${label} yang bisa diunduh.`), { code: 'NO_MATCHING_MEDIA' });
    }
    const actorError = items?.find?.((item) => item?.error || item?.errorDescription);
    throw Object.assign(new Error(actorError?.errorDescription || actorError?.error || 'Provider tidak menemukan media publik.'), {
      code: 'PROVIDER_NO_MEDIA',
      diagnostics: redactDiagnostics(raw).slice(-12000),
      elapsedMs: Date.now() - startedAt,
    });
  }

  onProgress(35);
  for (const [index, item] of selected.entries()) {
    await downloadProviderMedia({ item, index, jobDirectory });
    onProgress(Math.min(85, 35 + Math.round(((index + 1) / selected.length) * 50)));
  }
}

export function buildGalleryDlArgs({ jobDirectory, sourceUrl, cookiesFile, debug = false }) {
  const args = [];
  if (debug) args.push('--verbose');
  args.push('--destination', jobDirectory, '--option', 'extractor.instagram.retries=0');
  if (cookiesFile) args.push('--cookies', cookiesFile);
  else args.push('--option', 'extractor.instagram.api=graphql');
  args.push(sourceUrl);
  return args;
}

async function finalizeResults({ jobDirectory, shortcode, contentType, onProgress }) {
  const downloaded = await listFiles(jobDirectory);
  const selected = [];
  for (const filePath of downloaded) {
    const extension = path.extname(filePath).toLowerCase();
    const mediaType = mediaTypeFromExtension(extension);
    if (!mediaType) continue;
    if (!matchesSelection(mediaType, contentType)) {
      await fs.rm(filePath, { force: true });
      continue;
    }
    selected.push({ filePath, extension, mediaType });
  }

  if (!selected.length) {
    const label = contentType === 'photo' ? 'foto' : contentType === 'video' ? 'video' : 'foto atau video';
    throw Object.assign(new Error(`Postingan ini tidak memiliki ${label} yang bisa diunduh.`), { code: 'NO_MATCHING_MEDIA' });
  }

  const results = [];
  for (const [index, item] of selected.entries()) {
    const fileName = buildFileName(shortcode, index, item.extension);
    const destination = path.join(jobDirectory, fileName);
    if (item.filePath !== destination) await fs.rename(item.filePath, destination);
    const stat = await fs.stat(destination);
    results.push({
      fileName,
      filePath: destination,
      mediaType: item.mediaType,
      mimeType: mimeFromExtension(item.extension),
      quality: 'original',
      byteSize: stat.size,
    });
  }

  onProgress(95);
  return results;
}

export async function downloadInstagram({ id, sourceUrl, shortcode, contentType, onProgress }) {
  const jobDirectory = path.join(downloadRoot, id);
  await fs.rm(jobDirectory, { recursive: true, force: true });
  await fs.mkdir(jobDirectory, { recursive: true });

  onProgress(10);
  if (resolveInstagramProvider() === 'apify') {
    await downloadWithApify({ sourceUrl, contentType, jobDirectory, onProgress });
  } else {
    const binary = process.env.GALLERY_DL_BIN || 'gallery-dl';
    const args = buildGalleryDlArgs({
      jobDirectory,
      sourceUrl,
      cookiesFile: process.env.INSTAGRAM_COOKIES_FILE,
      debug: downloadDebug,
    });
    let observedLines = 0;
    try {
      await run(binary, args, {
        onLine: (line) => {
          observedLines += 1;
          onProgress(Math.min(85, 15 + observedLines * 8));
          if (downloadDebug) console.info(`[gallery-dl:${id}] ${redactDiagnostics(line)}`);
        },
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw Object.assign(new Error('Layanan pengambil media belum terpasang di server.'), { code: 'DOWNLOADER_MISSING' });
      }
      throw error;
    }
  }

  return finalizeResults({ jobDirectory, shortcode, contentType, onProgress });
}

export function friendlyDownloadError(error) {
  const raw = String(error?.message || 'Unduhan gagal.');
  const lower = raw.toLowerCase();
  if (error?.code === 'DOWNLOAD_TIMEOUT') return { code: error.code, message: 'Instagram terlalu lama merespons. Coba ulangi.' };
  if (error?.code === 'DOWNLOADER_MISSING') return { code: error.code, message: error.message };
  if (error?.code === 'NO_MATCHING_MEDIA') return { code: error.code, message: error.message };
  if (error?.code === 'PROVIDER_NOT_CONFIGURED') return { code: error.code, message: 'Provider unduhan belum dikonfigurasi di server.' };
  if (error?.code === 'PROVIDER_RATE_LIMITED') return { code: error.code, message: 'Provider unduhan sedang membatasi permintaan. Coba lagi nanti.' };
  if (error?.code === 'PROVIDER_NO_MEDIA') return { code: error.code, message: 'Media publik tidak ditemukan. Pastikan link aktif dan postingan bersifat publik.' };
  if (error?.code === 'PROVIDER_FAILED') return { code: error.code, message: 'Provider unduhan gagal mengambil media. Coba lagi nanti.' };
  if (lower.includes('rate') || lower.includes('429') || lower.includes('too many')) {
    return { code: 'RATE_LIMITED', message: 'Instagram membatasi IP server. Tunggu pembatasan reda atau gunakan sesi Instagram yang valid.' };
  }
  if (lower.includes('private') || lower.includes('login required') || lower.includes('cookies')) {
    return { code: 'PRIVATE_OR_LOGIN_REQUIRED', message: 'Postingan privat atau membutuhkan sesi Instagram.' };
  }
  if (lower.includes('not found') || lower.includes('404') || lower.includes('does not exist')) {
    return { code: 'POST_NOT_FOUND', message: 'Postingan tidak ditemukan atau sudah dihapus.' };
  }
  return { code: error?.code || 'DOWNLOAD_FAILED', message: 'Media gagal diambil. Periksa link lalu coba lagi.' };
}

export async function createArchive(batchId, files) {
  if (!files.length) throw Object.assign(new Error('Belum ada hasil berhasil untuk disimpan.'), { code: 'NO_RESULTS' });
  await fs.mkdir(archiveRoot, { recursive: true });
  const archivePath = path.join(archiveRoot, `unduhgram_${batchId}.zip`);
  await fs.rm(archivePath, { force: true });
  await run('zip', ['-j', '-q', archivePath, ...files], { timeout: 120000 });
  return archivePath;
}

export function isManagedDownloadPath(filePath) {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(`${downloadRoot}${path.sep}`);
}
