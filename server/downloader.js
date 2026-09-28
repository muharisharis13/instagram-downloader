import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildFileName, mediaTypeFromExtension, mimeFromExtension } from './core.js';

const downloadRoot = path.resolve(process.env.DOWNLOAD_DIR || './storage/downloads');
const archiveRoot = path.resolve(process.env.ARCHIVE_DIR || './storage/archives');
const timeoutMs = Number(process.env.DOWNLOAD_TIMEOUT_MS || 180000);

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
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(Object.assign(new Error('Proses unduhan melewati batas waktu.'), { code: 'DOWNLOAD_TIMEOUT' }));
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
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(Object.assign(new Error(output || `Proses berhenti dengan kode ${code}.`), { code: 'DOWNLOADER_FAILED' }));
    });
  });
}

function matchesSelection(mediaType, contentType) {
  return contentType === 'both' || mediaType === contentType;
}

export async function downloadInstagram({ id, sourceUrl, shortcode, contentType, onProgress }) {
  const jobDirectory = path.join(downloadRoot, id);
  await fs.rm(jobDirectory, { recursive: true, force: true });
  await fs.mkdir(jobDirectory, { recursive: true });

  const binary = process.env.GALLERY_DL_BIN || 'gallery-dl';
  const args = ['--destination', jobDirectory];
  if (process.env.INSTAGRAM_COOKIES_FILE) args.push('--cookies', process.env.INSTAGRAM_COOKIES_FILE);
  args.push(sourceUrl);

  let observedLines = 0;
  onProgress(10);
  try {
    await run(binary, args, {
      onLine: () => {
        observedLines += 1;
        onProgress(Math.min(85, 15 + observedLines * 8));
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
  if (lower.includes('private') || lower.includes('login required') || lower.includes('cookies')) {
    return { code: 'PRIVATE_OR_LOGIN_REQUIRED', message: 'Postingan privat atau membutuhkan sesi Instagram.' };
  }
  if (lower.includes('not found') || lower.includes('404') || lower.includes('does not exist')) {
    return { code: 'POST_NOT_FOUND', message: 'Postingan tidak ditemukan atau sudah dihapus.' };
  }
  if (lower.includes('rate') || lower.includes('429') || lower.includes('too many')) {
    return { code: 'RATE_LIMITED', message: 'Instagram membatasi permintaan. Tunggu sebentar lalu ulangi.' };
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
