# UnduhGram

Aplikasi React + Node.js + MySQL untuk memvalidasi banyak link Instagram, mengunduh foto/video publik secara paralel, memantau progres realtime, menyimpan hasil sebagai ZIP, mencari riwayat, dan menyinkronkan data lewat akun.

## Fitur

- Tempel sampai 25 link postingan, Reel, atau video Instagram sekaligus.
- Pilih foto, video, atau keduanya; file asli terbaik dipilih otomatis.
- Worker paralel dengan status per link, progres SSE, retry item gagal, dan notifikasi selesai.
- Galeri pratinjau, nama file rapi, unduh satu file, atau simpan semua sebagai ZIP.
- Riwayat lokal per perangkat; riwayat diklaim dan tersinkron saat pengguna masuk.
- Registrasi/login email atau telepon, sesi HttpOnly, reset sandi, dan otorisasi per pemilik.
- Preferensi akun, panduan mengambil link, FAQ, dan formulir bantuan.
- Migrasi MySQL otomatis saat server dimulai.

## Menjalankan dengan Docker

```bash
docker compose up --build
```

Buka `http://localhost:3000`. Ubah seluruh sandi contoh di `docker-compose.yml` sebelum deploy ke VPS, lalu pasang reverse proxy HTTPS dan set `APP_ORIGIN` ke origin publik yang tepat.

## Pengembangan lokal

Prasyarat: Node.js 22+, MySQL 8.4+, `gallery-dl`, `yt-dlp`, `ffmpeg`, dan `zip`.

```bash
cp .env.example .env
npm install
npm run dev:api
```

Terminal kedua:

```bash
npm run dev:web
```

Frontend tersedia di `http://localhost:5173`; Vite meneruskan `/api` ke port 3000.

## Validasi

```bash
npm test
npm run build
```

## Endpoint utama

- `POST /api/links/validate`
- `POST /api/downloads`
- `GET /api/downloads/:batchId`
- `GET /api/downloads/:batchId/events`
- `POST /api/downloads/:batchId/retry`
- `GET /api/downloads/:batchId/results`
- `GET /api/downloads/:batchId/archive`
- `GET /api/history?q=` dan `POST /api/history/:historyId/redownload`
- `POST /api/auth/register|login|logout|forgot-password|reset-password`
- `GET|PUT /api/preferences`
- `GET /api/faqs` dan `POST /api/support/messages`

## Catatan operasi

- Unduhan memakai `gallery-dl`; `yt-dlp` dan `ffmpeg` tersedia sebagai pendukung video dalam image Docker.
- Set `DOWNLOAD_DEBUG=1` sementara untuk mencatat keluaran `gallery-dl` yang sudah disamarkan; kembalikan ke `0` setelah diagnosis.
- Konten privat atau yang membutuhkan login memerlukan file cookies milik operator. Jangan meminta atau menyimpan sandi Instagram pengguna.
- Antrean berada dalam proses Node. Job `running` dikembalikan ke antrean setelah restart. Untuk lebih dari satu instance aplikasi, ganti antrean ini dengan Redis/BullMQ.
- Bersihkan `storage/` memakai kebijakan retensi VPS. File tidak dihapus otomatis agar unduh ulang tetap bekerja.
- Gunakan hanya untuk konten milik sendiri atau konten yang Anda berhak simpan, sesuai hukum dan ketentuan layanan yang berlaku.
