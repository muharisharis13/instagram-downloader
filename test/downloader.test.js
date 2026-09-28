import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGalleryDlArgs,
  extractApifyMedia,
  friendlyDownloadError,
  resolveInstagramProvider,
} from '../server/downloader.js';

test('mode anonim memakai GraphQL dan tidak mengulang HTTP 429', () => {
  const args = buildGalleryDlArgs({
    jobDirectory: '/tmp/job',
    sourceUrl: 'https://www.instagram.com/p/ABC/',
  });

  assert.deepEqual(args, [
    '--destination',
    '/tmp/job',
    '--option',
    'extractor.instagram.retries=0',
    '--option',
    'extractor.instagram.api=graphql',
    'https://www.instagram.com/p/ABC/',
  ]);
});

test('mode sesi memakai file cookies dan REST bawaan', () => {
  const args = buildGalleryDlArgs({
    jobDirectory: '/tmp/job',
    sourceUrl: 'https://www.instagram.com/reel/XYZ/',
    cookiesFile: '/run/secrets/instagram-cookies.txt',
  });

  assert.equal(args.includes('extractor.instagram.api=graphql'), false);
  assert.deepEqual(args.slice(-3), [
    '--cookies',
    '/run/secrets/instagram-cookies.txt',
    'https://www.instagram.com/reel/XYZ/',
  ]);
});

test('HTTP 429 tetap dikenali saat URL error menuju halaman login', () => {
  const result = friendlyDownloadError(
    new Error("HttpError: '429 Too Many Requests' for 'https://www.instagram.com/accounts/login/'"),
  );

  assert.deepEqual(result, {
    code: 'RATE_LIMITED',
    message: 'Instagram membatasi IP server. Tunggu pembatasan reda atau gunakan sesi Instagram yang valid.',
  });
});

test('mode auto memakai Apify saat token tersedia tanpa cookies Instagram', () => {
  assert.equal(resolveInstagramProvider({ provider: 'auto', apifyToken: 'token' }), 'apify');
  assert.equal(resolveInstagramProvider({ provider: 'auto', apifyToken: '' }), 'gallery-dl');
});

test('hasil Apify mengambil foto dan video carousel tanpa thumbnail video', () => {
  const media = extractApifyMedia([
    {
      childPosts: [
        { displayUrl: 'https://scontent.cdninstagram.com/photo.jpg' },
        {
          displayUrl: 'https://scontent.cdninstagram.com/video-cover.jpg',
          videoUrl: 'https://scontent.cdninstagram.com/video.mp4',
        },
      ],
    },
  ]);

  assert.deepEqual(media, [
    { url: 'https://scontent.cdninstagram.com/photo.jpg', mediaType: 'photo' },
    { url: 'https://scontent.cdninstagram.com/video.mp4', mediaType: 'video' },
  ]);
});
