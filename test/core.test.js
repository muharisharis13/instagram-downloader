import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFileName,
  hashPassword,
  mediaTypeFromExtension,
  normalizeIdentity,
  parseCookies,
  parseInstagramInput,
  verifyPassword,
} from '../server/core.js';

test('memisahkan, menormalkan, dan menghapus duplikat link Instagram', () => {
  const result = parseInstagramInput(`
    https://instagram.com/p/ABC_123/?utm_source=test
    instagram.com/reel/xyz-789/
    https://www.instagram.com/p/ABC_123/
  `);
  assert.equal(result.count, 2);
  assert.deepEqual(result.valid.map((item) => item.url), [
    'https://www.instagram.com/p/ABC_123/',
    'https://www.instagram.com/reel/xyz-789/',
  ]);
});

test('menolak profil dan domain selain Instagram', () => {
  const result = parseInstagramInput('https://instagram.com/nama-pengguna https://example.com/p/ABC/');
  assert.equal(result.valid.length, 0);
  assert.equal(result.invalid.length, 2);
});

test('membuat nama file stabil dan aman', () => {
  const name = buildFileName('A B/C', 1, '.JPG', new Date('2026-09-28T00:00:00Z'));
  assert.equal(name, 'instagram_A-B-C_20260928_02.jpg');
});

test('hash sandi bisa diverifikasi tanpa menyimpan sandi asli', async () => {
  const hash = await hashPassword('sandi-rahasia');
  assert.equal(await verifyPassword('sandi-rahasia', hash), true);
  assert.equal(await verifyPassword('sandi-salah', hash), false);
  assert.equal(hash.includes('sandi-rahasia'), false);
});

test('menormalkan email, nomor telepon, dan jenis media', () => {
  assert.deepEqual(normalizeIdentity({ identifier: ' USER@Example.com ' }), { email: 'user@example.com', phone: null });
  assert.deepEqual(normalizeIdentity({ identifier: '+62 812-3456-7890' }), { email: null, phone: '+6281234567890' });
  assert.equal(mediaTypeFromExtension('.WEBP'), 'photo');
  assert.equal(mediaTypeFromExtension('.mp4'), 'video');
  assert.equal(mediaTypeFromExtension('.txt'), null);
});

test('cookie rusak diabaikan tanpa menjatuhkan request', () => {
  assert.deepEqual(parseCookies('normal=ok; rusak=%E0%A4%A; lain=aman'), { normal: 'ok', lain: 'aman' });
});
