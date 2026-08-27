import { json, verifyToken, deleteFile, purgeConfigs, hashPassword } from '../_lib';

const MAX_PORTFOLIOS = 20;

// 自动迁移：首次访问时将旧 config 中的单作品集数据迁移到 portfolios 表
async function ensureMigrated(env) {
  try {
    const count = await env.DB.prepare('SELECT COUNT(*) as c FROM portfolios').first();
    if (count && count.c > 0) return;
    const mfRow = await env.DB.prepare("SELECT value FROM config WHERE key='pages_manifest'").first();
    if (!mfRow) return;
    const mf = JSON.parse(mfRow.value);
    const cfgRow = await env.DB.prepare("SELECT value FROM config WHERE key='site_config'").first();
    const cfg = cfgRow ? JSON.parse(cfgRow.value) : {};
    const prevRow = await env.DB.prepare("SELECT value FROM config WHERE key='pages_prev'").first();
    const pdfRow = await env.DB.prepare("SELECT value FROM config WHERE key='pdf_info'").first();
    const pdf = pdfRow ? JSON.parse(pdfRow.value) : {};
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO portfolios (title, slug, version, page_count, pages, pages_prev, page_order, pdf_size, pdf_name, pdf_chunks, r2_prefix, sort_order, is_published, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      cfg.title || '默认作品集', 'default',
      mf.version || 0, mf.count || 0, mfRow.value, prevRow ? prevRow.value : null,
      cfg.pages ? JSON.stringify(cfg.pages) : null,
      pdf.size || 0, pdf.name || '', pdf.chunks || 0,
      '', 0, 1, mf.uploaded_at || now, now
    ).run();
  } catch (e) {}
}

// 生成 slug：保留中英文与数字，附加随机串保证唯一
function genSlug(title) {
  const base = (title || 'portfolio')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'portfolio';
  return base + '-' + Math.random().toString(36).slice(2, 6);
}

// GET /api/portfolios —— 管理端：完整列表（需登录）
// GET /api/portfolios?published —— 公开端：已发布列表（无敏感字段）
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const publishedOnly = url.searchParams.has('published');

  await ensureMigrated(env);

  let sql;
  if (publishedOnly) {
    sql = 'SELECT id, title, slug, page_count, is_published FROM portfolios WHERE is_published=1 ORDER BY sort_order, id';
  } else {
    if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期' }, 401);
    sql = 'SELECT * FROM portfolios ORDER BY sort_order, id';
  }
  const { results } = await env.DB.prepare(sql).all();

  const list = (results || []).map((r) => {
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
      password_protected: !!(r.password && r.password.length > 0),
      visit_limit: r.visit_limit || 0,
      views: r.views || 0,
      sort_order: r.sort_order,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });

  return json({ ok: true, portfolios: list });
}

// POST /api/portfolios —— 新建作品集（需登录）
// body: { title, slug?, password?, visit_limit? }
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '参数错误' }, 400); }

  // 数量上限
  const cnt = await env.DB.prepare('SELECT COUNT(*) as c FROM portfolios').first();
  if (cnt && cnt.c >= MAX_PORTFOLIOS) {
    return json({ ok: false, error: `最多创建 ${MAX_PORTFOLIOS} 个作品集` }, 400);
  }

  const title = (body.title || '').trim().slice(0, 100) || '未命名作品集';
  const slug = ((body.slug || '').trim().replace(/[^\w-]/g, '-').slice(0, 30)) || genSlug(title);

  // slug 白名单保护
  if (['admin', 'guide', 'thanks', 'api', 'assets', 'vendor', 'default', 'login'].includes(slug)) {
    return json({ ok: false, error: '该 URL 标识为系统保留字' }, 400);
  }

  const exist = await env.DB.prepare('SELECT id FROM portfolios WHERE slug=?').bind(slug).first();
  if (exist) return json({ ok: false, error: 'URL 标识已存在，请换一个' }, 400);

  // 密码（可选）
  let passwordHash = '';
  if (typeof body.password === 'string' && body.password.length > 0) {
    const pw = body.password.slice(0, 64);
    if (pw.length < 4) return json({ ok: false, error: '访问密码至少 4 位' }, 400);
    const saltB64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    passwordHash = 'pbkdf2$100000$' + saltB64 + '$' + await hashPassword(pw, saltB64);
  }

  const visitLimit = Math.max(0, Math.min(1000000, parseInt(body.visit_limit, 10) || 0));

  const maxSort = await env.DB.prepare('SELECT MAX(sort_order) as m FROM portfolios').first();
  const sortOrder = (maxSort && maxSort.m != null) ? maxSort.m + 1 : 0;

  const now = Date.now();
  const result = await env.DB.prepare(
    `INSERT INTO portfolios (title, slug, version, page_count, pages, pages_prev, page_order, pdf_size, pdf_name, pdf_chunks, r2_prefix, sort_order, is_published, password, visit_limit, views, created_at, updated_at)
     VALUES (?, ?, 0, 0, NULL, NULL, NULL, 0, '', 0, '', ?, 1, ?, ?, 0, ?, ?)`
  ).bind(title, slug, sortOrder, passwordHash, visitLimit, now, now).run();

  const id = result.meta ? result.meta.last_row_id : null;
  if (!id) return json({ ok: false, error: '创建失败' }, 500);

  // r2_prefix 用作品集 id 前缀，隔离存储
  await env.DB.prepare('UPDATE portfolios SET r2_prefix=? WHERE id=?').bind(`pf${id}_`, id).run();

  await purgeConfigs(env, new URL(request.url).origin);
  return json({ ok: true, id, slug });
}

// PUT /api/portfolios —— 更新作品集（需登录）
// body: { id, title?, slug?, is_published?, sort_order?, password?, visit_limit?, clear_password? }
//   或 { order: [id, id, ...] } —— 批量保存列表顺序（拖拽/上下移排序）
// password 传空字符串 = 清除密码；clear_password=true 也表示清除
export async function onRequestPut(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: '参数错误' }, 400); }

  // ---- 批量排序 ----
  if (Array.isArray(body.order)) {
    const ids = body.order.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0);
    if (!ids.length || ids.length > MAX_PORTFOLIOS) return json({ ok: false, error: '排序列表错误' }, 400);
    const now = Date.now();
    const stmts = ids.map((id, i) =>
      env.DB.prepare('UPDATE portfolios SET sort_order=?, updated_at=? WHERE id=?').bind(i, now, id)
    );
    try { await env.DB.batch(stmts); } catch { return json({ ok: false, error: '排序保存失败' }, 500); }
    await purgeConfigs(env, new URL(request.url).origin);
    return json({ ok: true });
  }

  const id = parseInt(body.id, 10);
  if (!id) return json({ ok: false, error: '缺少作品集 ID' }, 400);

  const row = await env.DB.prepare('SELECT * FROM portfolios WHERE id=?').bind(id).first();
  if (!row) return json({ ok: false, error: '作品集不存在' }, 404);

  const updates = [];
  const binds = [];
  if (typeof body.title === 'string') {
    updates.push('title=?'); binds.push(body.title.trim().slice(0, 100) || '未命名作品集');
  }
  if (typeof body.slug === 'string') {
    const slug = body.slug.trim().replace(/[^\w-]/g, '-').slice(0, 30);
    if (slug && slug !== row.slug) {
      if (['admin', 'guide', 'thanks', 'api', 'assets', 'vendor', 'default', 'login'].includes(slug)) {
        return json({ ok: false, error: '该 URL 标识为系统保留字' }, 400);
      }
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
  if (typeof body.visit_limit === 'number') {
    updates.push('visit_limit=?'); binds.push(Math.max(0, Math.min(1000000, body.visit_limit | 0)));
  }
  // 密码：传 null/''/clear_password 清除
  if (body.clear_password === true || body.password === null || body.password === '') {
    updates.push('password=?'); binds.push('');
  } else if (typeof body.password === 'string' && body.password.length > 0) {
    const pw = body.password.slice(0, 64);
    if (pw.length < 4) return json({ ok: false, error: '访问密码至少 4 位' }, 400);
    const saltB64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    updates.push('password=?');
    binds.push('pbkdf2$100000$' + saltB64 + '$' + await hashPassword(pw, saltB64));
  }
  updates.push('updated_at=?'); binds.push(Date.now());
  binds.push(id);

  await env.DB.prepare(`UPDATE portfolios SET ${updates.join(', ')} WHERE id=?`).bind(...binds).run();

  await purgeConfigs(env, new URL(request.url).origin);
  return json({ ok: true });
}

// DELETE /api/portfolios?id= —— 删除作品集（需登录）
// 清除该作品集所有版本的 R2 图片，slug 释放后可复用
export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id'), 10);
  if (!id) return json({ ok: false, error: '缺少作品集 ID' }, 400);

  const row = await env.DB.prepare('SELECT * FROM portfolios WHERE id=?').bind(id).first();
  if (!row) return json({ ok: false, error: '作品集不存在' }, 404);

  const prefix = row.r2_prefix || '';

  // 收集所有需要删除的版本（当前 + 上一版）
  const manifests = [];
  try { if (row.pages) manifests.push(JSON.parse(row.pages)); } catch {}
  try { if (row.pages_prev) manifests.push(JSON.parse(row.pages_prev)); } catch {}
  const versions = new Set();
  for (const m of manifests) {
    if (m && m.version && m.count) versions.add({ version: m.version, count: m.count });
  }

  const keys = [];
  for (const v of versions) {
    for (let i = 1; i <= v.count; i++) keys.push(`${prefix}page_v${v.version}_${i}`);
  }
  // PDF 分块（旧版兜底数据）
  for (let i = 0; i < (row.pdf_chunks || 0); i++) keys.push(`${prefix}pdf_chunk_${i}`);

  for (let i = 0; i < keys.length; i += 10) {
    await Promise.all(keys.slice(i, i + 10).map((k) => deleteFile(env, k)));
  }

  await env.DB.prepare('DELETE FROM portfolios WHERE id=?').bind(id).run();

  await purgeConfigs(env, new URL(request.url).origin);
  return json({ ok: true });
}
