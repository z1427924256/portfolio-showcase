-- =========================================================
-- v2 迁移：多作品集架构（在 v1 基础上执行，仅需执行一次）
-- v1 → v2 变化：
--   1. 新增 portfolios 表（多作品集，含密码保护/访问限制）
--   2. visits 表新增 slug 列（按作品集统计）
--   3. 旧 config 中的单作品集数据自动迁移为 default 作品集
-- 全新部署：先执行 schema.sql，再执行本文件
-- =========================================================

-- 多作品集表
CREATE TABLE IF NOT EXISTS portfolios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '未命名作品集',
  slug TEXT NOT NULL,
  version INTEGER DEFAULT 0,
  page_count INTEGER DEFAULT 0,
  pages TEXT,
  pages_prev TEXT,
  page_order TEXT,
  pdf_size INTEGER DEFAULT 0,
  pdf_name TEXT,
  pdf_chunks INTEGER DEFAULT 0,
  pdf_version INTEGER DEFAULT 0,
  r2_prefix TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  is_published INTEGER DEFAULT 1,
  password TEXT DEFAULT '',
  visit_limit INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolios_slug ON portfolios (slug);
CREATE INDEX IF NOT EXISTS idx_portfolios_published ON portfolios (is_published, sort_order);

-- visits 表增加 slug 列（存量行默认 ''，代表旧 default 作品集）
ALTER TABLE visits ADD COLUMN slug TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_visits_slug ON visits (slug, ts);

-- 移除「使用申请」功能：清理不再使用的申请表（幂等，可安全重复执行）
DROP TABLE IF EXISTS requests;

-- 迁移：将旧 config 表中的单作品集数据迁入 portfolios 表
-- 仅在 portfolios 表为空且 config 中有 pages_manifest 时生效
INSERT INTO portfolios (title, slug, version, page_count, pages, pages_prev, page_order, pdf_size, pdf_name, pdf_chunks, r2_prefix, sort_order, is_published, password, visit_limit, views, created_at, updated_at)
SELECT
  COALESCE(json_extract((SELECT value FROM config WHERE key='site_config'), '$.title'), '默认作品集'),
  'default',
  json_extract(value, '$.version'),
  json_extract(value, '$.count'),
  value,
  (SELECT value FROM config WHERE key='pages_prev'),
  (SELECT CASE WHEN json_extract(value2, '$.pages') IS NOT NULL THEN json_extract(value2, '$.pages') ELSE NULL END
     FROM (SELECT value AS value2 FROM config WHERE key='site_config')),
  COALESCE(json_extract((SELECT value FROM config WHERE key='pdf_info'), '$.size'), 0),
  COALESCE(json_extract((SELECT value FROM config WHERE key='pdf_info'), '$.name'), ''),
  COALESCE(json_extract((SELECT value FROM config WHERE key='pdf_info'), '$.chunks'), 0),
  '',
  0,
  1,
  '',
  0,
  0,
  COALESCE(json_extract((SELECT value FROM config WHERE key='pages_manifest'), '$.uploaded_at'), CAST(strftime('%s','now') AS INTEGER) * 1000),
  CAST(strftime('%s','now') AS INTEGER) * 1000
FROM config
WHERE key = 'pages_manifest'
AND NOT EXISTS (SELECT 1 FROM portfolios);
