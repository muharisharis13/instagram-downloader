import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const contentOptions = [
  { value: 'photo', label: 'Foto', description: 'Semua gambar dalam postingan' },
  { value: 'video', label: 'Video', description: 'Reel dan video postingan' },
  { value: 'both', label: 'Foto + Video', description: 'Ambil semua media tersedia' },
];

const statusLabels = {
  pending: 'Menunggu',
  running: 'Sedang diunduh',
  success: 'Berhasil',
  failed: 'Gagal',
  completed: 'Selesai',
  partial: 'Selesai sebagian',
};

const navigationItems = [
  { view: 'download', label: 'Unduh', icon: 'download' },
  { view: 'history', label: 'Riwayat', icon: 'history' },
  { view: 'settings', label: 'Bantuan', icon: 'help' },
];

function AppIcon({ name }) {
  const paths = {
    download: <><path d="M12 3v11" /><path d="m8 10 4 4 4-4" /><path d="M5 18v2h14v-2" /></>,
    history: <><path d="M4 5v4h4" /><path d="M5.2 8A8 8 0 1 1 4 13" /><path d="M12 7v5l3 2" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.8 9a2.3 2.3 0 1 1 3.7 1.8c-.9.7-1.5 1.1-1.5 2.2" /><path d="M12 17h.01" /></>,
    account: <><circle cx="12" cy="8" r="3" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></>,
    close: <><path d="m7 7 10 10" /><path d="M17 7 7 17" /></>,
  };
  return <svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || 'Permintaan gagal.');
  return body;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function shortUrl(url) {
  return String(url).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

function normalizeInstagramLink(rawValue) {
  const raw = String(rawValue ?? '').trim().replace(/^[\[({<'"]+|[\])}>'".,;!?]+$/g, '');
  if (!raw) return { valid: false, input: rawValue, reason: 'Link kosong.' };
  let parsedUrl;
  try {
    parsedUrl = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { valid: false, input: rawValue, reason: 'Format link tidak dikenali.' };
  }
  const host = parsedUrl.hostname.toLowerCase();
  const segments = parsedUrl.pathname.split('/').filter(Boolean);
  if (!['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(host) || !['p', 'reel', 'tv'].includes(segments[0]) || !segments[1]) {
    return { valid: false, input: rawValue, reason: 'Gunakan link postingan, Reel, atau video Instagram publik.' };
  }
  const shortcode = segments[1].replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!shortcode) return { valid: false, input: rawValue, reason: 'Kode postingan tidak valid.' };
  return {
    valid: true,
    input: rawValue,
    shortcode,
    kind: segments[0],
    url: `https://www.instagram.com/${segments[0]}/${shortcode}/`,
  };
}

function parseInstagramLinks(input) {
  const tokens = String(input ?? '').split(/[\s,]+/).map((token) => token.trim()).filter(Boolean);
  const seen = new Set();
  const valid = [];
  const invalid = [];
  for (const token of tokens) {
    const item = normalizeInstagramLink(token);
    if (!item.valid) invalid.push(item);
    else if (!seen.has(item.url)) {
      seen.add(item.url);
      valid.push(item);
    }
  }
  return { valid, invalid, count: valid.length };
}

function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(onClose, 4200);
    return () => clearTimeout(timer);
  }, [toast, onClose]);
  if (!toast) return null;
  return (
    <div className={`toast toast-${toast.type || 'success'}`} role={toast.type === 'error' ? 'alert' : 'status'} aria-live={toast.type === 'error' ? 'assertive' : 'polite'}>
      <span>{toast.message}</span>
      <button type="button" onClick={onClose} aria-label="Tutup pemberitahuan"><AppIcon name="close" /></button>
    </div>
  );
}

function ContentTypePicker({ value, onChange }) {
  return (
    <fieldset className="content-picker">
      <legend>Jenis konten</legend>
      <div className="choice-grid">
        {contentOptions.map((option) => (
          <label key={option.value} className={`choice-card ${value === option.value ? 'active' : ''}`}>
            <input
              type="radio"
              name="content-type"
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span className="choice-mark" aria-hidden="true" />
            <strong>{option.label}</strong>
            <small>{option.description}</small>
          </label>
        ))}
      </div>
      <p className="field-note">Kualitas terbaik dipilih otomatis dari sumber.</p>
    </fieldset>
  );
}

function LinkList({ parsed, selected, setSelected }) {
  const validUrls = parsed.valid.map((item) => item.url);
  const allSelected = validUrls.length > 0 && validUrls.every((url) => selected.includes(url));
  const toggleAll = () => setSelected(allSelected ? [] : validUrls);
  const toggle = (url) => setSelected((current) => (
    current.includes(url) ? current.filter((item) => item !== url) : [...current, url]
  ));

  if (!parsed.valid.length && !parsed.invalid.length) return null;
  return (
    <section className="detected-panel" aria-live="polite">
      <div className="section-row">
        <div>
          <p className="eyebrow">Link terdeteksi</p>
          <h3>{parsed.valid.length} siap diproses</h3>
        </div>
        <div className="selection-actions">
          {parsed.valid.length > 0 && <span className="selection-count">{selected.length}/{parsed.valid.length} dipilih</span>}
          {parsed.valid.length > 0 && (
            <button type="button" className="button button-quiet" onClick={toggleAll}>
              {allSelected ? 'Kosongkan' : 'Pilih semua'}
            </button>
          )}
        </div>
      </div>
      <div className="link-list">
        {parsed.valid.map((item) => (
          <label className="link-row" key={item.url}>
            <input type="checkbox" checked={selected.includes(item.url)} onChange={() => toggle(item.url)} aria-label={`Pilih ${item.url}`} />
            <span className="link-icon valid" aria-hidden="true">✓</span>
            <span>
              <strong>{item.kind === 'reel' ? 'Reel' : 'Postingan'} {item.shortcode}</strong>
              <small>{shortUrl(item.url)}</small>
            </span>
          </label>
        ))}
        {parsed.invalid.map((item, index) => (
          <div className="link-row invalid-row" key={`${item.input}-${index}`}>
            <span className="fake-check" aria-hidden="true" />
            <span className="link-icon invalid" aria-hidden="true">!</span>
            <span>
              <strong>{String(item.input || 'Link tidak valid')}</strong>
              <small>{item.reason}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function JobStatus({ job }) {
  return (
    <article className="job-row">
      <div className="job-main">
        <div className="job-title">
          <span className={`status-dot status-${job.status}`} aria-hidden="true" />
          <div>
            <strong>{job.shortcode}</strong>
            <small>{shortUrl(job.sourceUrl)}</small>
          </div>
        </div>
        <span className={`status-pill status-${job.status}`}>{statusLabels[job.status] || job.status}</span>
      </div>
      <div className="progress-track" role="progressbar" aria-label={`Progres ${job.shortcode}`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={job.progress}>
        <span style={{ width: `${job.progress}%` }} />
      </div>
      <div className="job-meta">
        <span>{job.progress}%</span>
        {job.errorMessage && <span className="error-text">{job.errorMessage}</span>}
        {job.status === 'success' && <span>{job.results.length} file</span>}
      </div>
    </article>
  );
}

function ResultGallery({ results, onPreview }) {
  if (!results.length) return null;
  return (
    <section className="results-section">
      <div className="section-row">
        <div>
          <p className="eyebrow">Hasil berhasil</p>
          <h2>{results.length} file siap disimpan</h2>
        </div>
      </div>
      <div className="result-grid">
        {results.map((result) => (
          <button type="button" className="result-card" key={result.id} onClick={() => onPreview(result)}>
            <div className="media-frame">
              {result.mediaType === 'photo' ? (
                <img src={result.fileUrl} alt={`Pratinjau ${result.fileName}`} loading="lazy" />
              ) : (
                <video src={result.fileUrl} muted preload="metadata" aria-label={`Pratinjau ${result.fileName}`} />
              )}
              <span className="media-badge">{result.mediaType === 'photo' ? 'Foto' : 'Video'}</span>
            </div>
            <span className="result-info">
              <strong>{result.fileName}</strong>
              <small>Kualitas asli · {formatBytes(result.byteSize)}</small>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function PreviewModal({ result, onClose }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  useEffect(() => {
    if (!result) return undefined;
    const previousFocus = document.activeElement;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const focusable = [...dialogRef.current.querySelectorAll('button, a[href], video[controls]')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.body.classList.add('modal-open');
    closeRef.current?.focus();
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('modal-open');
      window.removeEventListener('keydown', onKey);
      previousFocus?.focus?.();
    };
  }, [result, onClose]);
  if (!result) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="preview-modal" role="dialog" aria-modal="true" aria-labelledby="preview-title" onMouseDown={(event) => event.stopPropagation()}>
        <button ref={closeRef} type="button" className="modal-close" onClick={onClose} aria-label="Tutup pratinjau"><AppIcon name="close" /></button>
        <div className="preview-media">
          {result.mediaType === 'photo' ? (
            <img src={result.fileUrl} alt={result.fileName} />
          ) : (
            <video src={result.fileUrl} controls autoPlay />
          )}
        </div>
        <div className="preview-details">
          <div>
            <p className="eyebrow">{result.mediaType === 'photo' ? 'Foto' : 'Video'} · kualitas asli</p>
            <h3 id="preview-title">{result.fileName}</h3>
          </div>
          <a className="button button-secondary" href={result.fileUrl} download={result.fileName}>Simpan file</a>
        </div>
      </section>
    </div>
  );
}

function DownloadPage({ preferences, activeBatchId, onBatchChange, notify, onOpenHistory }) {
  const inputRef = useRef(null);
  const [input, setInput] = useState('');
  const [parsed, setParsed] = useState({ valid: [], invalid: [], count: 0 });
  const [selected, setSelected] = useState([]);
  const [contentType, setContentType] = useState(preferences.defaultContentType || 'both');
  const [validating, setValidating] = useState(false);
  const [validationMessage, setValidationMessage] = useState('');
  const [starting, setStarting] = useState(false);
  const [batch, setBatch] = useState(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null);
  const notifiedBatch = useRef(null);

  useEffect(() => setContentType(preferences.defaultContentType || 'both'), [preferences.defaultContentType]);

  useEffect(() => {
    if (!input.trim()) return undefined;
    const controller = new AbortController();
    let alive = true;
    const timer = setTimeout(async () => {
      setValidating(true);
      try {
        const result = await api('/api/links/validate', {
          method: 'POST',
          body: JSON.stringify({ text: input }),
          signal: controller.signal,
        });
        if (!alive) return;
        setParsed(result);
        const available = new Set(result.valid.map((item) => item.url));
        setSelected((current) => current.filter((url) => available.has(url)));
        setValidationMessage('');
      } catch (error) {
        if (alive && error.name !== 'AbortError') setValidationMessage('Validasi server belum tersedia. Link tetap diperiksa saat proses dimulai.');
      } finally {
        if (alive) setValidating(false);
      }
    }, 320);
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [input]);

  useEffect(() => {
    if (!activeBatchId) return undefined;
    let alive = true;
    const update = (snapshot) => {
      if (!alive) return;
      setBatch(snapshot);
      if (snapshot.done && notifiedBatch.current !== snapshot.id) {
        notifiedBatch.current = snapshot.id;
        const message = snapshot.failedCount
          ? `Selesai: ${snapshot.successCount} berhasil, ${snapshot.failedCount} gagal.`
          : `Semua ${snapshot.successCount} unduhan berhasil.`;
        notify(message, snapshot.failedCount ? 'warning' : 'success');
        if ('Notification' in window && Notification.permission === 'granted') new Notification('UnduhGram selesai', { body: message });
      }
    };
    api(`/api/downloads/${activeBatchId}`).then(update).catch((error) => notify(error.message, 'error'));
    const events = new EventSource(`/api/downloads/${activeBatchId}/events`);
    events.addEventListener('snapshot', (event) => update(JSON.parse(event.data)));
    events.onerror = () => {};
    return () => {
      alive = false;
      events.close();
    };
  }, [activeBatchId, notify]);

  const results = useMemo(() => batch?.jobs.flatMap((job) => job.results) || [], [batch]);
  const tooManyLinks = parsed.valid.length > 25;

  const updateInput = (value) => {
    const next = parseInstagramLinks(value);
    setInput(value);
    setParsed(next);
    setSelected(next.valid.map((item) => item.url));
    setValidationMessage('');
  };

  const clearInput = () => {
    updateInput('');
    inputRef.current?.focus();
  };

  const startDownload = async (event) => {
    event?.preventDefault();
    if (!selected.length) return notify('Pilih minimal satu link valid.', 'error');
    if (tooManyLinks) return notify('Maksimal 25 link dalam satu proses.', 'error');
    setStarting(true);
    try {
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
      const created = await api('/api/downloads', {
        method: 'POST',
        body: JSON.stringify({ links: selected, contentType }),
      });
      notifiedBatch.current = null;
      onBatchChange(created.batchId);
      notify(`${selected.length} link masuk antrean.`, 'success');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setStarting(false);
    }
  };

  const retryFailed = async () => {
    try {
      const result = await api(`/api/downloads/${batch.id}/retry`, { method: 'POST', body: '{}' });
      notifiedBatch.current = null;
      notify(result.message, 'success');
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  const saveAll = async () => {
    setSaving(true);
    try {
      const response = await fetch(batch.archiveUrl, { credentials: 'same-origin' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || 'Arsip gagal dibuat.');
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `unduhgram_${batch.id.slice(0, 8)}.zip`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      const warning = response.headers.get('X-Download-Warnings');
      notify(warning ? `Arsip tersimpan; ${warning}.` : 'Semua hasil berhasil disimpan.', warning ? 'warning' : 'success');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main>
      <section className="hero-shell">
        <div className="hero-copy">
          <p className="eyebrow">Unduh massal Instagram</p>
          <h1>Simpan banyak konten. Satu kali jalan.</h1>
          <p>Tempel hingga 25 link postingan atau Reel publik, pilih media, lalu pantau semuanya tanpa refresh.</p>
          <div className="trust-row">
            <span>Kualitas asli</span><span>Progres realtime</span><span>Arsip ZIP rapi</span>
          </div>
        </div>
        <form className="download-card" onSubmit={startDownload} aria-busy={starting || validating}>
          <label htmlFor="links-input" className="input-label">Tempel link Instagram</label>
          <div className={`textarea-wrap ${validating ? 'is-loading' : ''}`}>
            <textarea
              ref={inputRef}
              id="links-input"
              value={input}
              onChange={(event) => updateInput(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void startDownload(event);
              }}
              placeholder={'https://www.instagram.com/p/...\nhttps://www.instagram.com/reel/...'}
              rows="7"
              aria-describedby="links-help links-status"
            />
          </div>
          <div className="composer-meta" id="links-help">
            <span>Pisahkan dengan baris baru, spasi, atau koma.</span>
            {input && <button type="button" className="inline-action" onClick={clearInput}>Hapus semua</button>}
          </div>
          <div className="detection-strip" id="links-status" aria-live="polite">
            <span className={parsed.valid.length ? 'is-valid' : ''}><strong>{parsed.valid.length}</strong> valid</span>
            <span className={parsed.invalid.length ? 'is-invalid' : ''}><strong>{parsed.invalid.length}</strong> perlu diperbaiki</span>
            <span><strong>{selected.length}</strong> dipilih</span>
            {validating && <span className="checking-label">Memeriksa…</span>}
          </div>
          {tooManyLinks && <p className="inline-feedback error-text">Maksimal 25 link. Hapus {parsed.valid.length - 25} link sebelum melanjutkan.</p>}
          {validationMessage && <p className="inline-feedback">{validationMessage}</p>}
          <ContentTypePicker value={contentType} onChange={setContentType} />
          <button
            type="submit"
            className="button button-primary button-large"
            disabled={!selected.length || starting || tooManyLinks}
          >
            {starting ? 'Menyiapkan antrean…' : `Unduh ${selected.length} link`}
          </button>
          <p className="keyboard-hint">Tekan Ctrl/⌘ + Enter untuk mulai.</p>
          {!selected.length && parsed.valid.length > 0 && <p className="form-message">Pilih link yang ingin diproses.</p>}
        </form>
      </section>

      <LinkList parsed={parsed} selected={selected} setSelected={setSelected} />

      {batch && (
        <section className="monitor-panel">
          <div className="section-row monitor-head">
            <div>
              <p className="eyebrow">Proses unduhan</p>
              <h2>{batch.done ? statusLabels[batch.status] : 'Sedang berjalan'}</h2>
              <p>{batch.completedCount} dari {batch.totalCount} link selesai</p>
            </div>
            <div className="progress-ring" style={{ '--progress': `${batch.progress * 3.6}deg` }}>
              <span>{batch.progress}%</span>
            </div>
          </div>
          <div className="summary-strip">
            <span><strong>{batch.totalCount}</strong> Total</span>
            <span><strong>{batch.successCount}</strong> Berhasil</span>
            <span><strong>{batch.failedCount}</strong> Gagal</span>
          </div>
          <div className="job-list">{batch.jobs.map((job) => <JobStatus key={job.id} job={job} />)}</div>
          {batch.done && (
            <div className="monitor-actions">
              {results.length > 0 && (
                <button type="button" className="button button-primary" onClick={saveAll} disabled={saving}>
                  {saving ? 'Menyiapkan arsip…' : `Simpan semua (${results.length})`}
                </button>
              )}
              {batch.failedCount > 0 && <button type="button" className="button button-secondary" onClick={retryFailed}>Ulangi yang gagal</button>}
              <button type="button" className="button button-quiet" onClick={onOpenHistory}>Lihat riwayat</button>
            </div>
          )}
        </section>
      )}

      <ResultGallery results={results} onPreview={setPreview} />
      <PreviewModal result={preview} onClose={() => setPreview(null)} />

      <section className="how-section">
        <div>
          <p className="eyebrow">Tiga langkah</p>
          <h2>Dari link menjadi arsip rapi</h2>
        </div>
        <div className="step-grid">
          <article><span>01</span><h3>Tempel link</h3><p>Salin beberapa link postingan atau Reel Instagram publik.</p></article>
          <article><span>02</span><h3>Pilih media</h3><p>Ambil foto, video, atau keduanya dengan kualitas terbaik.</p></article>
          <article><span>03</span><h3>Simpan hasil</h3><p>Pratinjau file lalu unduh semuanya sebagai satu arsip ZIP.</p></article>
        </div>
      </section>
    </main>
  );
}

function HistoryPage({ notify, onRedownload }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmingId, setConfirmingId] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const result = await api(`/api/history?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        setItems(result.items);
      } catch (error) {
        if (error.name !== 'AbortError') notify(error.message, 'error');
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, notify]);

  const redownload = async (item) => {
    setConfirmingId(null);
    try {
      const created = await api(`/api/history/${item.id}/redownload`, { method: 'POST', body: '{}' });
      notify(created.message, 'success');
      onRedownload(created.batchId);
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  return (
    <main className="page-shell">
      <header className="page-header">
        <p className="eyebrow">Arsip aktivitas</p>
        <h1>Riwayat unduhan</h1>
        <p>Cari link lama dan jalankan ulang tanpa menempel dari awal.</p>
      </header>
      <section className="panel history-panel">
        <div className="history-toolbar">
          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari link atau kata kunci" aria-label="Cari riwayat" />
            {query && <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="Hapus pencarian"><AppIcon name="close" /></button>}
          </label>
          <span className="result-count">{loading ? 'Memuat…' : `${items.length} item`}</span>
        </div>
        {loading ? (
          <div className="empty-state"><div className="loader" /><p>Memuat riwayat…</p></div>
        ) : items.length ? (
          <div className="history-list">
            {items.map((item) => (
              <article className="history-row" key={item.id}>
                <div className={`history-thumb ${item.status}`} aria-hidden="true">{item.contentType === 'video' ? '▶' : '▧'}</div>
                <div className="history-main">
                  <strong>{shortUrl(item.sourceUrl)}</strong>
                  <span>{formatDate(item.createdAt)}</span>
                  {item.errorMessage && <small className="error-text">{item.errorMessage}</small>}
                </div>
                <div className="history-tags">
                  <span className="tag">{contentOptions.find((option) => option.value === item.contentType)?.label}</span>
                  <span className={`status-pill status-${item.status}`}>{statusLabels[item.status]}</span>
                </div>
                {confirmingId === item.id ? (
                  <div className="history-confirm" role="group" aria-label={`Konfirmasi unduh ulang ${shortUrl(item.sourceUrl)}`}>
                    <span>Unduh ulang?</span>
                    <button type="button" className="button button-primary" onClick={() => redownload(item)}>Ya</button>
                    <button type="button" className="button button-quiet" onClick={() => setConfirmingId(null)}>Batal</button>
                  </div>
                ) : (
                  <button type="button" className="button button-secondary" onClick={() => setConfirmingId(item.id)}>Unduh lagi</button>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-symbol" aria-hidden="true">↺</div>
            <h3>{query ? 'Tidak ada riwayat yang cocok' : 'Belum ada riwayat unduhan'}</h3>
            <p>{query ? 'Coba kata kunci atau potongan link lain.' : 'Mulai unduhan pertama untuk melihatnya di sini.'}</p>
          </div>
        )}
      </section>
    </main>
  );
}

function AccountPage({ session, onSessionChange, notify }) {
  const [mode, setMode] = useState('login');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setPassword('');
    setShowPassword(false);
    if (nextMode !== 'reset') setResetToken('');
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (mode === 'forgot') {
        const result = await api('/api/auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ identifier }),
        });
        if (result.debugResetToken) setResetToken(result.debugResetToken);
        notify(result.message, 'success');
        setMode('reset');
      } else if (mode === 'reset') {
        const result = await api('/api/auth/reset-password', {
          method: 'POST',
          body: JSON.stringify({ token: resetToken, password }),
        });
        notify(result.message, 'success');
        switchMode('login');
        setPassword('');
      } else {
        const result = await api(`/api/auth/${mode}`, {
          method: 'POST',
          body: JSON.stringify({ identifier, password }),
        });
        onSessionChange(result.user);
        notify(mode === 'register' ? 'Akun berhasil dibuat.' : 'Berhasil masuk.', 'success');
      }
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
      onSessionChange(null);
      notify('Anda sudah keluar.', 'success');
    } catch (error) {
      notify(error.message, 'error');
    }
  };

  if (session === undefined) {
    return (
      <main className="page-shell">
        <div className="page-loading" role="status"><div className="loader" /><p>Memeriksa sesi akun…</p></div>
      </main>
    );
  }

  if (session) {
    return (
      <main className="page-shell account-page">
        <header className="page-header">
          <p className="eyebrow">Akun pengguna</p><h1>Riwayat tetap bersama Anda.</h1>
          <p>Unduhan perangkat ini sudah ditautkan ke akun dan bisa dibuka setelah masuk dari perangkat lain.</p>
        </header>
        <section className="account-card signed-in">
          <div className="avatar">{(session.email || session.phone || 'U').slice(0, 1).toUpperCase()}</div>
          <div><p className="eyebrow">Sedang masuk</p><h2>{session.email || session.phone}</h2><p>Terdaftar {formatDate(session.createdAt)}</p></div>
          <span className="sync-badge">Sinkron aktif</span>
          <button type="button" className="button button-secondary" onClick={logout}>Keluar</button>
        </section>
        <div className="account-benefits">
          <article><strong>Riwayat tersinkron</strong><p>Cari dan unduh ulang dari perangkat mana pun.</p></article>
          <article><strong>Preferensi tersimpan</strong><p>Jenis media bawaan mengikuti akun Anda.</p></article>
          <article><strong>Akses terlindungi</strong><p>Sesi aman tersimpan dalam cookie HttpOnly.</p></article>
        </div>
      </main>
    );
  }

  return (
    <main className="page-shell auth-layout">
      <section className="auth-intro">
        <p className="eyebrow">Akun pengguna</p>
        <h1>Bawa riwayat ke mana pun.</h1>
        <p>Buat akun untuk menyinkronkan unduhan, preferensi, dan akses ulang di perangkat lain.</p>
        <ul><li>Riwayat privat per akun</li><li>Masuk dengan email atau nomor telepon</li><li>Pemulihan sandi aman</li></ul>
      </section>
      <section className="auth-card">
        <div className="auth-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>Masuk</button>
          <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'active' : ''} onClick={() => switchMode('register')}>Daftar</button>
        </div>
        <form onSubmit={submit} aria-busy={busy}>
          <div className="form-heading">
            <h2>{mode === 'register' ? 'Buat akun baru' : mode === 'forgot' ? 'Lupa sandi' : mode === 'reset' ? 'Buat sandi baru' : 'Selamat datang kembali'}</h2>
            <p>{mode === 'forgot' ? 'Masukkan identitas akun. Respons selalu sama demi keamanan.' : mode === 'reset' ? 'Gunakan kode reset yang diterima.' : 'Gunakan email atau nomor telepon.'}</p>
          </div>
          {mode !== 'reset' && (
            <label className="form-field">Email atau nomor telepon
              <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" required />
            </label>
          )}
          {mode === 'reset' && (
            <label className="form-field">Kode reset
              <input value={resetToken} onChange={(event) => setResetToken(event.target.value)} required />
            </label>
          )}
          {mode !== 'forgot' && (
            <label className="form-field">Sandi
              <span className="password-field">
                <input type={showPassword ? 'text' : 'password'} minLength="8" maxLength="128" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />
                <button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Sembunyikan sandi' : 'Tampilkan sandi'}>{showPassword ? 'Sembunyikan' : 'Lihat'}</button>
              </span>
              <small>Minimal 8 karakter.</small>
            </label>
          )}
          <button type="submit" className="button button-primary button-large" disabled={busy}>
            {busy ? 'Memproses…' : mode === 'register' ? 'Buat akun' : mode === 'forgot' ? 'Kirim petunjuk' : mode === 'reset' ? 'Simpan sandi baru' : 'Masuk'}
          </button>
          {mode === 'login' && <button type="button" className="text-button" onClick={() => switchMode('forgot')}>Lupa sandi?</button>}
          {(mode === 'forgot' || mode === 'reset') && <button type="button" className="text-button" onClick={() => switchMode('login')}>Kembali ke masuk</button>}
        </form>
      </section>
    </main>
  );
}

function SettingsPage({ session, preferences, onSavePreferences, notify }) {
  const [draft, setDraft] = useState(preferences);
  const [faqs, setFaqs] = useState([]);
  const [support, setSupport] = useState({ name: '', email: session?.email || '', message: '' });
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => setDraft(preferences), [preferences]);
  useEffect(() => {
    api('/api/faqs').then((result) => setFaqs(result.items)).catch((error) => notify(error.message, 'error'));
  }, [notify]);

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSavePreferences(draft);
      notify('Preferensi berhasil disimpan dan berlaku pada unduhan berikutnya.', 'success');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const sendSupport = async (event) => {
    event.preventDefault();
    setSending(true);
    try {
      const result = await api('/api/support/messages', { method: 'POST', body: JSON.stringify(support) });
      notify(result.message, 'success');
      setSupport((current) => ({ ...current, message: '' }));
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="page-shell settings-page">
      <header className="page-header"><p className="eyebrow">Pengaturan & bantuan</p><h1>Atur sekali, pakai seterusnya.</h1><p>Pilih bawaan unduhan, pelajari cara mengambil link, atau kirim pertanyaan.</p></header>

      <section className="settings-grid">
        <article className="panel guide-panel">
          <div className="panel-heading"><span className="number-icon">1</span><div><p className="eyebrow">Panduan</p><h2>Cara mengambil link Instagram</h2></div></div>
          <ol className="guide-list">
            <li><span>1</span><div><strong>Buka postingan atau Reel</strong><p>Pilih konten Instagram publik yang ingin disimpan.</p></div></li>
            <li><span>2</span><div><strong>Tekan Bagikan</strong><p>Pilih menu “Salin tautan” pada aplikasi Instagram.</p></div></li>
            <li><span>3</span><div><strong>Tempel di UnduhGram</strong><p>Gabungkan beberapa link dalam satu kolom.</p></div></li>
          </ol>
          <div className="link-example"><small>Contoh link valid</small><code>https://www.instagram.com/reel/ABC123/</code></div>
        </article>

        <form className="panel preference-panel" onSubmit={save}>
          <div className="panel-heading"><span className="number-icon">2</span><div><p className="eyebrow">Preferensi</p><h2>Bawaan unduhan</h2></div></div>
          <ContentTypePicker value={draft.defaultContentType} onChange={(value) => setDraft({ ...draft, defaultContentType: value })} />
          <label className="form-field">Kualitas bawaan
            <select value={draft.defaultQuality} onChange={(event) => setDraft({ ...draft, defaultQuality: event.target.value })}>
              <option value="best">Otomatis — kualitas terbaik</option>
            </select>
            <small>UnduhGram mengambil file asli terbaik yang tersedia.</small>
          </label>
          <button className="button button-primary" disabled={saving}>{saving ? 'Menyimpan…' : 'Simpan preferensi'}</button>
          {!session && <p className="field-note">Preferensi tersimpan di perangkat ini. Masuk untuk sinkron antarperangkat.</p>}
        </form>
      </section>

      <section className="panel faq-panel">
        <div className="panel-heading"><span className="number-icon">3</span><div><p className="eyebrow">Bantuan cepat</p><h2>Pertanyaan umum</h2></div></div>
        <div className="faq-list">
          {faqs.map((faq) => <details key={faq.id}><summary>{faq.question}<span>+</span></summary><p>{faq.answer}</p></details>)}
        </div>
      </section>

      <section className="contact-layout">
        <div className="contact-copy"><p className="eyebrow">Masih butuh bantuan?</p><h2>Ceritakan kendala Anda.</h2><p>Tim bantuan merespons maksimal dua hari kerja. Jangan kirim sandi atau cookies Instagram.</p><a href="mailto:bantuan@unduhgram.local">bantuan@unduhgram.local</a></div>
        <form className="panel support-form" onSubmit={sendSupport}>
          <label className="form-field">Nama<input value={support.name} onChange={(event) => setSupport({ ...support, name: event.target.value })} required /></label>
          <label className="form-field">Email<input type="email" value={support.email} onChange={(event) => setSupport({ ...support, email: event.target.value })} required /></label>
          <label className="form-field">Pesan<textarea rows="5" minLength="10" value={support.message} onChange={(event) => setSupport({ ...support, message: event.target.value })} required /></label>
          <button className="button button-primary" disabled={sending}>{sending ? 'Mengirim…' : 'Kirim pesan'}</button>
        </form>
      </section>
    </main>
  );
}

function App() {
  const initialView = ['download', 'history', 'account', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'download';
  const [view, setView] = useState(initialView);
  const [session, setSession] = useState(undefined);
  const [activeBatchId, setActiveBatchId] = useState(sessionStorage.getItem('activeBatchId'));
  const [preferences, setPreferences] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('downloadPreferences')) || { defaultContentType: 'both', defaultQuality: 'best' };
    } catch {
      return { defaultContentType: 'both', defaultQuality: 'best' };
    }
  });
  const [toast, setToast] = useState(null);
  const notify = React.useCallback((message, type = 'success') => setToast({ message, type, id: Date.now() }), []);

  const navigate = (nextView) => {
    location.hash = nextView;
    setView(nextView);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const changeBatch = (batchId) => {
    sessionStorage.setItem('activeBatchId', batchId);
    setActiveBatchId(batchId);
  };

  useEffect(() => {
    const onHash = () => {
      const next = location.hash.slice(1);
      if (['download', 'history', 'account', 'settings'].includes(next)) setView(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    api('/api/auth/session')
      .then((result) => setSession(result.user))
      .catch((error) => {
        setSession(null);
        notify(error.message, 'error');
      });
  }, [notify]);

  useEffect(() => {
    if (!session) return;
    api('/api/preferences')
      .then((result) => setPreferences(result))
      .catch((error) => notify(error.message, 'error'));
  }, [session, notify]);

  const savePreferences = async (next) => {
    if (session) {
      const saved = await api('/api/preferences', { method: 'PUT', body: JSON.stringify(next) });
      setPreferences(saved);
      return;
    }
    localStorage.setItem('downloadPreferences', JSON.stringify(next));
    setPreferences(next);
  };

  const changeSession = (user) => {
    setSession(user);
    if (user) return;
    sessionStorage.removeItem('activeBatchId');
    setActiveBatchId(null);
    try {
      setPreferences(JSON.parse(localStorage.getItem('downloadPreferences')) || { defaultContentType: 'both', defaultQuality: 'best' });
    } catch {
      setPreferences({ defaultContentType: 'both', defaultQuality: 'best' });
    }
  };

  return (
    <div className="app-shell">
      <header className="site-header">
        <button type="button" className="brand" onClick={() => navigate('download')} aria-label="Buka halaman unduh">
          <span className="brand-mark"><i /><i /><i /></span><span>UnduhGram</span>
        </button>
        <nav aria-label="Menu utama">
          <button type="button" className={view === 'download' ? 'active' : ''} onClick={() => navigate('download')}>Unduh</button>
          <button type="button" className={view === 'history' ? 'active' : ''} onClick={() => navigate('history')}>Riwayat</button>
          <button type="button" className={view === 'settings' ? 'active' : ''} onClick={() => navigate('settings')}>Bantuan</button>
        </nav>
        <button type="button" className="account-button" onClick={() => navigate('account')}>
          <span className="account-dot">{session ? (session.email || session.phone).slice(0, 1).toUpperCase() : 'U'}</span>
          <span>{session ? 'Akun' : 'Masuk'}</span>
        </button>
      </header>

      {view === 'download' && <DownloadPage preferences={preferences} activeBatchId={activeBatchId} onBatchChange={changeBatch} notify={notify} onOpenHistory={() => navigate('history')} />}
      {view === 'history' && <HistoryPage notify={notify} onRedownload={(batchId) => { changeBatch(batchId); navigate('download'); }} />}
      {view === 'account' && <AccountPage session={session} onSessionChange={changeSession} notify={notify} />}
      {view === 'settings' && <SettingsPage session={session} preferences={preferences} onSavePreferences={savePreferences} notify={notify} />}

      <footer className="site-footer">
        <div className="brand"><span className="brand-mark"><i /><i /><i /></span><span>UnduhGram</span></div>
        <p>Gunakan hanya untuk konten milik sendiri atau konten yang Anda berhak simpan.</p>
        <button type="button" onClick={() => navigate('settings')}>Pengaturan & bantuan</button>
      </footer>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
