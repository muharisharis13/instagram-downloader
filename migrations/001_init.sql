CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  email VARCHAR(255) NULL UNIQUE,
  phone VARCHAR(24) NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT users_identity CHECK (email IS NOT NULL OR phone IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:split
CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(64) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX sessions_user_idx (user_id),
  INDEX sessions_expiry_idx (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:split
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash CHAR(64) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT password_resets_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX password_resets_user_idx (user_id),
  INDEX password_resets_expiry_idx (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:split
CREATE TABLE IF NOT EXISTS download_batches (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  guest_id CHAR(64) NULL,
  content_type ENUM('photo', 'video', 'both') NOT NULL DEFAULT 'both',
  status ENUM('pending', 'running', 'completed', 'partial', 'failed') NOT NULL DEFAULT 'pending',
  total_count INT UNSIGNED NOT NULL DEFAULT 0,
  completed_count INT UNSIGNED NOT NULL DEFAULT 0,
  success_count INT UNSIGNED NOT NULL DEFAULT 0,
  failed_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT download_batches_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX download_batches_user_idx (user_id, created_at),
  INDEX download_batches_guest_idx (guest_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:split
CREATE TABLE IF NOT EXISTS download_jobs (
  id CHAR(36) PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  guest_id CHAR(64) NULL,
  source_url VARCHAR(500) NOT NULL,
  shortcode VARCHAR(80) NOT NULL,
  content_type ENUM('photo', 'video', 'both') NOT NULL,
  status ENUM('pending', 'running', 'success', 'failed') NOT NULL DEFAULT 'pending',
  progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
  error_code VARCHAR(64) NULL,
  error_message TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  CONSTRAINT download_jobs_batch_fk FOREIGN KEY (batch_id) REFERENCES download_batches(id) ON DELETE CASCADE,
  CONSTRAINT download_jobs_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX download_jobs_batch_idx (batch_id, created_at),
  INDEX download_jobs_status_idx (status, created_at),
  INDEX download_jobs_user_idx (user_id, created_at),
  INDEX download_jobs_guest_idx (guest_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:split
CREATE TABLE IF NOT EXISTS download_results (
  id CHAR(36) PRIMARY KEY,
  job_id CHAR(36) NOT NULL,
  media_type ENUM('photo', 'video') NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(1000) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  quality VARCHAR(40) NOT NULL DEFAULT 'original',
  byte_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT download_results_job_fk FOREIGN KEY (job_id) REFERENCES download_jobs(id) ON DELETE CASCADE,
  INDEX download_results_job_idx (job_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:split
CREATE TABLE IF NOT EXISTS history (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  guest_id CHAR(64) NULL,
  job_id CHAR(36) NOT NULL,
  source_url VARCHAR(500) NOT NULL,
  content_type ENUM('photo', 'video', 'both') NOT NULL,
  status ENUM('success', 'failed') NOT NULL,
  quality VARCHAR(40) NULL,
  searched_keywords VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT history_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT history_job_fk FOREIGN KEY (job_id) REFERENCES download_jobs(id) ON DELETE CASCADE,
  UNIQUE KEY history_job_unique (job_id),
  INDEX history_user_idx (user_id, created_at),
  INDEX history_guest_idx (guest_id, created_at),
  FULLTEXT INDEX history_search_idx (source_url, searched_keywords)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:split
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id CHAR(36) PRIMARY KEY,
  default_content_type ENUM('photo', 'video', 'both') NOT NULL DEFAULT 'both',
  default_quality VARCHAR(40) NOT NULL DEFAULT 'best',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT user_preferences_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:split
CREATE TABLE IF NOT EXISTS support_messages (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  status ENUM('new', 'read', 'resolved') NOT NULL DEFAULT 'new',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT support_messages_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX support_messages_status_idx (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
