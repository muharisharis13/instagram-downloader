import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

export function buildGalleryDlArgs({ jobDirectory, sourceUrl, cookiesFile, debug = false }) {
  const args = [];
  if (debug) args.push('--verbose');
  args.push('--destination', jobDirectory, '--option', 'extractor.instagram.retries=0');
  if (cookiesFile) args.push('--cookies', cookiesFile);
  else args.push('--option', 'extractor.instagram.api=graphql');
  args.push(sourceUrl);
  return args;
}

export async function downloadInstagram({ id, sourceUrl, shortcode, contentType, onProgress }) {
  const jobDirectory = path.join(downloadRoot, id);
  await fs.rm(jobDirectory, { recursive: true, force: true });
  await fs.mkdir(jobDirectory, { recursive: true });

  const binary = process.env.GALLERY_DL_BIN || 'gallery-dl';
  const args = buildGalleryDlArgs({
    jobDirectory,
    sourceUrl,
    cookiesFile: process.env.INSTAGRAM_COOKIES_FILE,
    debug: downloadDebug,
  });

  let observedLines = 0;
  onProgress(10);
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

export function friendlyDownloadError(error) {
  const raw = String(error?.message || 'Unduhan gagal.');
  const lower = raw.toLowerCase();
  if (error?.code === 'DOWNLOAD_TIMEOUT') return { code: error.code, message: 'Instagram terlalu lama merespons. Coba ulangi.' };
  if (error?.code === 'DOWNLOADER_MISSING') return { code: error.code, message: error.message };
  if (error?.code === 'NO_MATCHING_MEDIA') return { code: error.code, message: error.message };
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
