import { json, verifyToken, verifyAccess, purgeConfigs } from '../_lib';

// slug 校验
const SLUG_RE = /^[\w-]{1,40}$/;

// 按 slug 读取作品集
async function getPortfolioBySlug(env, slug) {
  if (slug === 'default') {
    return env.DB.prepare("SELECT * FROM portfolios WHERE slug='default'").first();
  }
  if (!SLUG_RE.test(slug)) return null;
  return env.DB.prepare('SELECT * FROM portfolios WHERE slug=?').bind(slug).first();
}

// GET /api/config?slug=xxx —— 公开配置 + 作品集数据（前台读取）
//   - 受密码保护且未验证：只返回 protected 标记，不含 manifest
//   - 访问次数用尽：blocked=true，不含 manifest
//   - 边缘缓存 key 统一为 /__config/{slug}，30 秒；受保护作品集不缓存
// GET /api/config?fresh=1&slug=xxx —— 管理端读取（跳过缓存，带 manifest）
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const fresh = url.searchParams.has('fresh');
  const slugRaw = url.searchParams.get('slug') || 'default';
  const cache = caches.default;

  // 管理端 fresh 模式：需要登录
  if (fresh) {
    if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期' }, 401);
  }

  // 读取全局设置
  const cfgRow = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('site_config').first();
  const cfg = cfgRow ? JSON.parse(cfgRow.value) : {};
  const qrRow = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('qr_version').first();

  // 读取作品集
  const pf = await getPortfolioBySlug(env, slugRaw);

  const payload = {
    ok: true,
    config: {
      site_title: cfg.title || '作品集',
      title: pf ? pf.title : '作品集',
      wm_enabled: cfg.wm_enabled !== false,
      wm_text: cfg.wm_text || '',
      wm_name: cfg.wm_name || '',
      wm_style: cfg.wm_style || 'capsule',
      phone_enabled: cfg.phone_enabled !== false,
      phone: cfg.phone || '',
      qr_enabled: cfg.qr_enabled !== false,
      wx_id: cfg.wx_id || '',
      pages: null,
    },
    portfolio: null,
    manifest: null,
    pdf: null,
    qr_version: qrRow ? +qrRow.value : 0,
    portfolios: [],
  };

  // 已发布作品集列表（供前台切换器 / guide 页）
  try {
    const { results } = await env.DB.prepare(
      'SELECT slug, title, page_count, password FROM portfolios WHERE is_published=1 ORDER BY sort_order, id'
    ).all();
    payload.portfolios = (results || []).map((r) => ({
      slug: r.slug,
      title: r.title,
      page_count: r.page_count || 0,
      protected: !!(r.password && r.password.length > 0),
    }));
  } catch (e) {}

  if (!pf) {
    // 作品集不存在：若未迁移，回退到旧版全局数据（兼容）
    const mfRow = await env.DB.prepare("SELECT value FROM config WHERE key='pages_manifest'").first();
    const pdfRow = await env.DB.prepare("SELECT value FROM config WHERE key='pdf_info'").first();
    if (mfRow && !payload.portfolios.length) {
      const mf = JSON.parse(mfRow.value);
      payload.config.pages = Array.isArray(cfg.pages) ? cfg.pages : null;
      payload.manifest = { version: mf.version, count: mf.count, pages: mf.pages };
      payload.pdf = pdfRow ? JSON.parse(pdfRow.value) : null;
    }
    const res0 = json(payload, 200, { 'Cache-Control': 'public, max-age=30' });
    return res0;
  }

  // 访问控制状态
  const isProtected = !!(pf.password && pf.password.length > 0);
  const blocked = (pf.visit_limit || 0) > 0 && (pf.views || 0) >= pf.visit_limit;
  const authorized = isProtected ? await verifyAccess(request, env, pf.slug) : true;

  // 页面清单与排序
  let mf = null;
  try { mf = pf.pages ? JSON.parse(pf.pages) : null; } catch {}
  let pageOrder = null;
  try { pageOrder = pf.page_order ? JSON.parse(pf.page_order) : null; } catch {}

  payload.portfolio = {
    slug: pf.slug,
    title: pf.title,
    protected: isProtected,
    authorized,
    blocked,
    views: pf.views || 0,
    visit_limit: pf.visit_limit || 0,
    page_count: pf.page_count || 0,
    version: pf.version || 0,
  };
  payload.config.title = pf.title;
  payload.config.pages = Array.isArray(pageOrder) ? pageOrder : null;

  // 未授权 / 已锁定：不返回页面数据
  if (blocked || !authorized) {
    const res1 = json(payload, 200, { 'Cache-Control': 'no-store' });
    return res1;
  }

  if (mf) {
    payload.manifest = { version: mf.version, count: mf.count, pages: mf.pages };
  }
  // 旧版 PDF 兜底（仅 default）
  if (pf.slug === 'default') {
    const pdfRow = await env.DB.prepare("SELECT value FROM config WHERE key='pdf_info'").first();
    const pdfInfo = pdfRow ? JSON.parse(pdfRow.value) : null;
    payload.pdf = pdfInfo ? { size: pdfInfo.size, version: pdfInfo.version, name: pdfInfo.name } : null;
  }

  // 边缘缓存：仅未受保护的作品集；管理端 fresh 跳过
  const cacheKey = new URL('/__config/' + encodeURIComponent(pf.slug), request.url);
  if (!fresh && !isProtected) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch (e) {}
  }

  const res = json(
    payload,
    200,
    isProtected
      ? { 'Cache-Control': 'no-store' }
      : { 'Cache-Control': 'public, max-age=30, s-maxage=30' }
  );

  if (!fresh && !isProtected) {
    try {
      await cache.put(cacheKey, res.clone());
    } catch (e) {}
  }
  return res;
}

// PUT /api/config —— 保存设置（需登录）
// 1) 全局设置：{ title, wm_enabled, wm_text, wm_name, wm_style, phone_enabled, phone, qr_enabled, wx_id }
// 2) 作品集页面排序：{ portfolio_id, pages: [1,3,2...] }
export async function onRequestPut(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '参数错误' }, 400);
  }

  // ---- 作品集页面排序 ----
  if (body.portfolio_id) {
    const pid = parseInt(body.portfolio_id, 10);
    const pfRow = await env.DB.prepare('SELECT id, page_count FROM portfolios WHERE id=?').bind(pid).first();
    if (!pfRow) return json({ ok: false, error: '作品集不存在' }, 404);
    if (!Array.isArray(body.pages) || body.pages.length < 1 || body.pages.length > 500) {
      return json({ ok: false, error: '页面列表错误' }, 400);
    }
    const count = pfRow.page_count || 0;
    for (const n of body.pages) {
      if (!Number.isInteger(n) || n < 1 || n > count) {
        return json({ ok: false, error: '页面编号超出范围' }, 400);
      }
    }
    await env.DB.prepare('UPDATE portfolios SET page_order=?, updated_at=? WHERE id=?')
      .bind(JSON.stringify(body.pages), Date.now(), pid)
      .run();
    await purgeConfigs(env, new URL(request.url).origin);
    return json({ ok: true });
  }

  // ---- 全局设置 ----
  const cur = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('site_config').first();
  const cfg = cur ? JSON.parse(cur.value) : {};

  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
  // 微信号：仅保留字母数字下划线连字符；允许清空
  const rawWx = ((str(body.wx_id, 30) ?? cfg.wx_id ?? '') || '').replace(/[^\w\-]/g, '');

  // 水印样式：capsule（胶囊）/ tile（斜纹平铺）
  let wmStyle = cfg.wm_style || 'capsule';
  if (body.wm_style === 'capsule' || body.wm_style === 'tile') wmStyle = body.wm_style;

  const clean = {
    title: str(body.title, 100) ?? cfg.title ?? '',
    wm_enabled: typeof body.wm_enabled === 'boolean' ? body.wm_enabled : cfg.wm_enabled !== false,
    wm_text: str(body.wm_text, 200) ?? cfg.wm_text ?? '',
    wm_name: str(body.wm_name, 50) ?? cfg.wm_name ?? '',
    wm_style: wmStyle,
    phone_enabled: typeof body.phone_enabled === 'boolean' ? body.phone_enabled : cfg.phone_enabled !== false,
    phone: (str(body.phone, 20) || '').replace(/\D/g, '') || cfg.phone || '',
    qr_enabled: typeof body.qr_enabled === 'boolean' ? body.qr_enabled : cfg.qr_enabled !== false,
    wx_id: rawWx,
    // v1 兼容：旧字段保留（迁移期读取）
    pages: cfg.pages ?? null,
  };

  await env.DB.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  )
    .bind('site_config', JSON.stringify(clean))
    .run();

  await purgeConfigs(env, new URL(request.url).origin);
  return json({ ok: true });
}
