-- 多作品集表
CREATE TABLE IF NOT EXISTS portfolios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '未命名作品集',
  slug TEXT NOT NULL,
  version INTEGER DEFAULT 0,
  page_count INTEGER DEFAULT 0,
  pages TEXT,
  pdf_size INTEGER DEFAULT 0,
  pdf_name TEXT,
  pdf_chunks INTEGER DEFAULT 0,
  r2_prefix TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  is_published INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolios_slug ON portfolios (slug);
CREATE INDEX IF NOT EXISTS idx_portfolios_published ON portfolios (is_published, sort_order);

-- 迁移：将旧 config 表中的 pages_manifest 迁移到 portfolios 表
-- 仅在 portfolios 表为空且 config 中有 pages_manifest 时执行
INSERT INTO portfolios (title, slug, version, page_count, pages, pdf_size, pdf_name, pdf_chunks, r2_prefix, sort_order, is_published, created_at, updated_at)
SELECT
  COALESCE(json_extract((SELECT value FROM config WHERE key='site_config'), '$.title'), '默认作品集'),
  'default',
  json_extract(value, '$.version'),
  json_extract(value, '$.count'),
  value,
  COALESCE(json_extract((SELECT value FROM config WHERE key='pdf_info'), '$.size'), 0),
  COALESCE(json_extract((SELECT value FROM config WHERE key='pdf_info'), '$.name'), ''),
  COALESCE(json_extract((SELECT value FROM config WHERE key='pdf_info'), '$.chunks'), 0),
  '',
  0,
  1,
  COALESCE(json_extract((SELECT value FROM config WHERE key='pages_manifest'), '$.uploaded_at'), CAST(strftime('%s','now') AS INTEGER) * 1000),
  CAST(strftime('%s','now') AS INTEGER) * 1000
FROM config
WHERE key = 'pages_manifest'
AND NOT EXISTS (SELECT 1 FROM portfolios);
