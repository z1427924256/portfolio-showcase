import { json, verifyToken } from '../_lib';

// GET /api/config —— 公开配置（前台读取）
// 性能：单次 D1 查询 + 边缘缓存 30 秒，访客打开不再等待数据库冷启动；
// 后台带 ?fresh=1 读取实时数据（跳过缓存）
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const fresh = url.searchParams.has('fresh');
  const cache = caches.default;

  if (!fresh) {
    try {
      const cached = await cache.match(request);
      if (cached) return cached;
    } catch (e) {}
  }

  const { results } = await env.DB.prepare(
    "SELECT key, value FROM config WHERE key IN ('site_config','pdf_info','qr_version','pages_manifest')"
  ).all();
  const map = {};
  for (const r of results || []) map[r.key] = r.value;

  const cfg = (() => { try { return map.site_config ? JSON.parse(map.site_config) : {}; } catch { return {}; } })();
  const pdfInfo = (() => { try { return map.pdf_info ? JSON.parse(map.pdf_info) : null; } catch { return null; } })();
  const mf = (() => { try { return map.pages_manifest ? JSON.parse(map.pages_manifest) : null; } catch { return null; } })();

  const res = json(
    {
      ok: true,
      config: {
        title: cfg.title || '作品集',
        wm_enabled: cfg.wm_enabled !== false,
        wm_text: cfg.wm_text || '',
        wm_name: cfg.wm_name || '',
        phone_enabled: cfg.phone_enabled !== false,
        phone: cfg.phone || '',
        qr_enabled: cfg.qr_enabled !== false,
        wx_id: cfg.wx_id || '',
        pages: Array.isArray(cfg.pages) ? cfg.pages : null,
      },
      pdf: pdfInfo
        ? { size: pdfInfo.size, version: pdfInfo.version, name: pdfInfo.name }
        : null,
      manifest: mf ? { version: mf.version, count: mf.count, pages: mf.pages } : null,
      qr_version: map.qr_version ? +map.qr_version : 0,
    },
    200,
    { 'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=600' }
  );

  if (!fresh) {
    try {
      await cache.put(request, res.clone());
    } catch (e) {}
  }
  return res;
}

// PUT /api/config —— 保存设置（需登录）
export async function onRequestPut(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '参数错误' }, 400);
  }

  const cur = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('site_config').first();
  const cfg = cur ? JSON.parse(cur.value) : {};

  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
  // 微信号：仅保留字母数字下划线连字符；允许清空
  const rawWx = ((str(body.wx_id, 30) ?? cfg.wx_id ?? '') || '').replace(/[^\w\-]/g, '');

  const clean = {
    title: str(body.title, 100) ?? cfg.title ?? '',
    wm_enabled: typeof body.wm_enabled === 'boolean' ? body.wm_enabled : cfg.wm_enabled !== false,
    wm_text: str(body.wm_text, 200) ?? cfg.wm_text ?? '',
    wm_name: str(body.wm_name, 50) ?? cfg.wm_name ?? '',
    phone_enabled: typeof body.phone_enabled === 'boolean' ? body.phone_enabled : cfg.phone_enabled !== false,
    phone: (str(body.phone, 20) || '').replace(/\D/g, '') || cfg.phone || '',
    qr_enabled: typeof body.qr_enabled === 'boolean' ? body.qr_enabled : cfg.qr_enabled !== false,
    wx_id: rawWx,
    pages:
      Array.isArray(body.pages) &&
      body.pages.length <= 500 &&
      body.pages.every((n) => Number.isInteger(n) && n >= 1 && n <= 500)
        ? body.pages
        : cfg.pages ?? null,
  };

  await env.DB.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  )
    .bind('site_config', JSON.stringify(clean))
    .run();

  return json({ ok: true });
}
