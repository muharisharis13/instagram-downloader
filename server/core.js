import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const instagramHosts = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com']);
const contentTypes = new Set(['photo', 'video', 'both']);
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function normalizeInstagramUrl(rawValue) {
  const raw = String(rawValue ?? '')
    .trim()
    .replace(/^[\[({<'"]+|[\])}>'".,;!?]+$/g, '');

  if (!raw) return { valid: false, input: rawValue, reason: 'Link kosong.' };

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    return { valid: false, input: rawValue, reason: 'Format link tidak dikenali.' };
  }

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);
  const allowedKinds = new Set(['p', 'reel', 'tv']);
  if (!instagramHosts.has(host) || !allowedKinds.has(segments[0]) || !segments[1]) {
    return {
      valid: false,
      input: rawValue,
      reason: 'Gunakan link postingan, Reel, atau video Instagram publik.',
    };
  }

  const shortcode = segments[1].replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!shortcode) {
    return { valid: false, input: rawValue, reason: 'Kode postingan tidak valid.' };
  }

  return {
    valid: true,
    input: rawValue,
    shortcode,
    kind: segments[0],
    url: `https://www.instagram.com/${segments[0]}/${shortcode}/`,
  };
}

export function parseInstagramInput(input) {
  const source = Array.isArray(input) ? input.join('\n') : String(input ?? '');
  const tokens = source
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const seen = new Set();
  const valid = [];
  const invalid = [];

  for (const token of tokens) {
    const parsed = normalizeInstagramUrl(token);
    if (!parsed.valid) {
      invalid.push(parsed);
      continue;
    }
    if (seen.has(parsed.url)) continue;
    seen.add(parsed.url);
    valid.push(parsed);
  }

  return { valid, invalid, count: valid.length };
}

export function assertContentType(value, fallback = 'both') {
  const normalized = String(value || fallback).toLowerCase();
  if (!contentTypes.has(normalized)) {
    throw new HttpError(400, 'Jenis konten tidak valid.', 'INVALID_CONTENT_TYPE');
  }
  return normalized;
}

export function normalizeIdentity({ email, phone, identifier } = {}) {
  const raw = String(identifier ?? '').trim();
  const normalizedEmail = String(email ?? (raw.includes('@') ? raw : '')).trim().toLowerCase();
  const normalizedPhone = String(phone ?? (!raw.includes('@') ? raw : ''))
    .replace(/[^\d+]/g, '')
    .replace(/^00/, '+');

  const validEmail = normalizedEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
  const validPhone = normalizedPhone && /^\+?\d{8,15}$/.test(normalizedPhone);

  return {
    email: validEmail ? normalizedEmail : null,
    phone: validPhone ? normalizedPhone : null,
  };
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new HttpError(400, 'Sandi harus berisi 8–128 karakter.', 'INVALID_PASSWORD');
  }
  return password;
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [algorithm, cost, blockSize, parallelization, saltValue, hashValue] = String(stored).split('$');
    if (algorithm !== 'scrypt') return false;
    const expected = Buffer.from(hashValue, 'base64url');
    const actual = await scrypt(password, Buffer.from(saltValue, 'base64url'), expected.length, {
      N: Number(cost),
      r: Number(blockSize),
      p: Number(parallelization),
      maxmem: 64 * 1024 * 1024,
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, Buffer.from(actual));
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function sanitizeFilePart(value, fallback = 'instagram') {
  const cleaned = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

export function buildFileName(shortcode, index, extension, now = new Date()) {
  const stamp = now.toISOString().slice(0, 10).replaceAll('-', '');
  const sequence = String(index + 1).padStart(2, '0');
  const safeExtension = String(extension).toLowerCase().replace(/[^.a-z0-9]/g, '');
  return `instagram_${sanitizeFilePart(shortcode)}_${stamp}_${sequence}${safeExtension}`;
}

export function mediaTypeFromExtension(extension) {
  const normalized = String(extension).toLowerCase();
  if (imageExtensions.has(normalized)) return 'photo';
  if (videoExtensions.has(normalized)) return 'video';
  return null;
}

export function mimeFromExtension(extension) {
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
  };
  return map[String(extension).toLowerCase()] || 'application/octet-stream';
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';').map((value) => value.trim()).filter(Boolean)) {
    const separator = part.indexOf('=');
    const rawKey = separator === -1 ? part : part.slice(0, separator);
    const rawValue = separator === -1 ? '' : part.slice(separator + 1);
    try {
      cookies[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    } catch {
      continue;
    }
  }
  return cookies;
}
