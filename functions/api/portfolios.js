import { json, verifyToken, deleteFile } from '../_lib';

// 自动迁移：首次访问时将旧 config 中的 pages_manifest 迁移到 portfolios 表
async function ensureMigrated(env) {
  try {
    const count = await env.DB.prepare('SELECT COUNT(*) as c FROM portfolios').first();
    if (count && count.c > 0) return;
    // 检查旧数据
    const mfRow = await env.DB.prepare("SELECT value FROM config WHERE key='pages_manifest'").first();
    if (!mfRow) return;
    const mf = JSON.parse(mfRow.value);
    const cfgRow = await env.DB.prepare("SELECT value FROM config WHERE key='site_config'").first();
    const cfg = cfgRow ? JSON.parse(cfgRow.value) : {};
    const pdfRow = await env.DB.prepare("SELECT value FROM config WHERE key='pdf_info'").first();
    const pdf = pdfRow ? JSON.parse(pdfRow.value) : {};
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO portfolios (title, slug, version, page_count, pages, pdf_size, pdf_name, pdf_chunks, r2_prefix, sort_order, is_published, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      cfg.title || '默认作品集', 'default',
      mf.version || 0, mf.count || 0, mfRow.value,
      pdf.size || 0, pdf.name || '', pdf.chunks || 0,
      '', 0, 1, mf.uploaded_at || now, now
    ).run();
  } catch (e) {}
}

// 生成 slug：中文转拼音首字母 + 随机串；英文保留
function genSlug(title) {
  const base = (title || 'portfolio')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'portfolio';
  return base + '-' + Math.random().toString(36).slice(2, 6);
}

// GET /api/portfolios —— 管理端：列表
// GET /api/portfolios?published=1 —— 公开端：已发布列表
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const publishedOnly = url.searchParams.has('published');

  await ensureMigrated(env);

  let sql, bind;
  if (publishedOnly) {
    sql = 'SELECT id, title, slug, page_count, sort_order FROM portfolios WHERE is_published=1 ORDER BY sort_order, id';
    bind = [];
  } else {
    if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期' }, 401);
    sql = 'SELECT * FROM portfolios ORDER BY sort_order, id';
    bind = [];
  }
  const { results } = await env.DB.prepare(sql).bind(...bind).all();

  const list = (results || []).map(r => {
    if (publishedOnly) {
      return { id: r.id, title: r.title, slug: r.slug, page_count: r.page_count };
    }
    let pages = null;
    try { pages = r.pages ? JSON.parse(r.pages) : null; } catch {}
    return {
      id: r.id, title: r.title, slug: r.slug,
      version: r.version, page_count: r.page_count,
      pages: pages ? { version: pages.version, count: pages.count, pages: pages.pages } : null,
      pdf: r.pdf_size > 0 ? { size: r.pdf_size, name: r.pdf_name } : null,
      r2_prefix: r.r2_prefix,
      is_published: r.is_published === 1,
      sort_order: r.sort_order,
    };
  });

  return json({ ok: true, portfolios: list });
}

// POST /api/portfolios —— 新建作品集（需登录）
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '参数错误' }, 400); }

  const title = (body.title || '').trim().slice(0, 100) || '未命名作品集';
  const slug = ((body.slug || '').trim().replace(/[^\w-]/g, '-').slice(0, 30)) || genSlug(title);
  const now = Date.now();

  // 检查 slug 唯一
  const exist = await env.DB.prepare('SELECT id FROM portfolios WHERE slug=?').bind(slug).first();
  if (exist) return json({ ok: false, error: 'URL 标识已存在，请换一个' }, 400);

  // 获取 sort_order
  const maxSort = await env.DB.prepare('SELECT MAX(sort_order) as m FROM portfolios').first();
  const sortOrder = (maxSort && maxSort.m != null) ? maxSort.m + 1 : 0;

  // r2_prefix: 用 portfolio id 前缀，迁移的老作品集为空字符串
  const result = await env.DB.prepare(
    `INSERT INTO portfolios (title, slug, version, page_count, pages, pdf_size, pdf_name, pdf_chunks, r2_prefix, sort_order, is_published, created_at, updated_at)
     VALUES (?, ?, 0, 0, NULL, 0, '', 0, ?, ?, 1, ?, ?)`
  ).bind(title, slug, '', sortOrder, now, now).run();

  const id = result.meta ? result.meta.last_row_id : null;
  if (!id) return json({ ok: false, error: '创建失败' }, 500);

  // 更新 r2_prefix
  await env.DB.prepare('UPDATE portfolios SET r2_prefix=? WHERE id=?').bind(`pf${id}_`, id).run();

  // 清除 CDN 缓存
  try {
    const cache = caches.default;
    await cache.delete(new URL('https://placeholder.example.com/api/config'));
    await cache.delete(new URL('https://placeholder.example.com/api/portfolios?published=1'));
  } catch (e) {}

  return json({ ok: true, id, slug });
}

// PUT /api/portfolios —— 更新作品集（需登录）
// body: { id, title?, slug?, is_published?, sort_order? }
export async function onRequestPut(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '参数错误' }, 400); }
  const id = parseInt(body.id, 10);
  if (!id) return json({ ok: false, error: '缺少作品集 ID' }, 400);

  const row = await env.DB.prepare('SELECT * FROM portfolios WHERE id=?').bind(id).first();
  if (!row) return json({ ok: false, error: '作品集不存在' }, 404);

  const updates = [];
  const binds = [];
  if (typeof body.title === 'string') {
    updates.push('title=?'); binds.push(body.title.trim().slice(0, 100));
  }
  if (typeof body.slug === 'string') {
    const slug = body.slug.trim().replace(/[^\w-]/g, '-').slice(0, 30);
    if (slug) {
      const dup = await env.DB.prepare('SELECT id FROM portfolios WHERE slug=? AND id!=?').bind(slug, id).first();
      if (dup) return json({ ok: false, error: 'URL 标识已存在' }, 400);
      updates.push('slug=?'); binds.push(slug);
    }
  }
  if (typeof body.is_published === 'boolean') {
    updates.push('is_published=?'); binds.push(body.is_published ? 1 : 0);
  }
  if (typeof body.sort_order === 'number') {
    updates.push('sort_order=?'); binds.push(body.sort_order);
  }
  updates.push('updated_at=?'); binds.push(Date.now());
  binds.push(id);

  if (updates.length > 1) {
    await env.DB.prepare(`UPDATE portfolios SET ${updates.join(', ')} WHERE id=?`).bind(...binds).run();
  }

  // 清除 CDN 缓存
  try {
    const cache = caches.default;
    await cache.delete(new URL('https://placeholder.example.com/api/config'));
    await cache.delete(new URL('https://placeholder.example.com/api/portfolios?published=1'));
  } catch (e) {}

  return json({ ok: true });
}

// DELETE /api/portfolios?id= —— 删除作品集（需登录）
export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id'), 10);
  if (!id) return json({ ok: false, error: '缺少作品集 ID' }, 400);

  const row = await env.DB.prepare('SELECT * FROM portfolios WHERE id=?').bind(id).first();
  if (!row) return json({ ok: false, error: '作品集不存在' }, 404);

  const prefix = row.r2_prefix || '';
  const version = row.version || 0;
  const count = row.page_count || 0;

  // 删除 R2 页面图片
  for (let i = 1; i <= count; i++) {
    await deleteFile(env, `${prefix}page_v${version}_${i}`);
  }
  // 删除 PDF 分块
  for (let i = 0; i < (row.pdf_chunks || 0); i++) {
    await deleteFile(env, `${prefix}pdf_chunk_${i}`);
  }

  // 删除 D1 记录
  await env.DB.prepare('DELETE FROM portfolios WHERE id=?').bind(id).run();

  // 清除 CDN 缓存
  try {
    const cache = caches.default;
    await cache.delete(new URL('https://placeholder.example.com/api/config'));
    await cache.delete(new URL('https://placeholder.example.com/api/portfolios?published=1'));
  } catch (e) {}

  return json({ ok: true });
}
