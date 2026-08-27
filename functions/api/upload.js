import { json, verifyToken, saveFile, deleteFile, loadFile } from '../_lib';

// POST /api/upload —— 上传页面图片 / 页面清单 / 二维码（需登录）
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: '参数错误' }, 400);
  }

  const type = form.get('type');

  // 预约新作品集版本号（渲染前调用）
  // 注意：此处仅读取当前版本号 +1 返回，不做原子预约。
  // 并发场景下 pages_manifest 提交时会校验 version > cur.version，
  // 后提交者会被拒绝（单后台管理员场景下足够安全）。
  if (type === 'pages_begin') {
    const row = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('pages_manifest').first();
    const cur = row ? JSON.parse(row.value) : null;
    const nextVer = (cur ? cur.version : 0) + 1;
    // 传入 pages_manifest 时会校验 version > cur.version
    return json({ ok: true, version: nextVer });
  }

  const file = form.get('file');

  // 单页图片
  if (type === 'page_image') {
    const version = parseInt(form.get('version'), 10) || 0;
    const index = parseInt(form.get('index'), 10) || 0;
    if (version < 1 || version > 1000 || index < 1 || index > 500) {
      return json({ ok: false, error: '参数错误' }, 400);
    }
    if (!(file instanceof File)) return json({ ok: false, error: '缺少文件' }, 400);
    if (file.size > 8 * 1024 * 1024) return json({ ok: false, error: '单页图片过大' }, 400);
    if (!/^image\//.test(file.type)) return json({ ok: false, error: '请上传图片文件' }, 400);
    const stores = await saveFile(env, `page_v${version}_${index}`, await file.arrayBuffer(), file.type || 'image/jpeg');
    return json({ ok: true, storage: stores });
  }

  // 页面清单（所有页面上传完成后提交，提交后前台立即生效）
  if (type === 'pages_manifest') {
    let m;
    try {
      m = JSON.parse(form.get('manifest') || 'null');
    } catch {
      m = null;
    }
    if (!m || typeof m !== 'object') return json({ ok: false, error: '参数错误' }, 400);

    const version = parseInt(m.version, 10) || 0;
    const pages = m.pages;
    if (version < 1 || version > 1000) return json({ ok: false, error: '参数错误' }, 400);
    if (!Array.isArray(pages) || pages.length < 1 || pages.length > 500) {
      return json({ ok: false, error: '页数需在 1-500 之间' }, 400);
    }
    if (m.count !== pages.length) return json({ ok: false, error: '页数与清单不一致' }, 400);
    for (const p of pages) {
      if (!p || !Number.isFinite(p.w) || !Number.isFinite(p.h) || p.w < 1 || p.h < 1 || p.w > 50000 || p.h > 100000) {
        return json({ ok: false, error: '页面尺寸数据错误' }, 400);
      }
    }

    const row = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('pages_manifest').first();
    const cur = row ? JSON.parse(row.value) : null;
    if (cur && version <= cur.version) return json({ ok: false, error: '版本号已过期，请重新上传' }, 400);

    const manifest = { version, count: pages.length, pages, uploaded_at: Date.now() };
    await env.DB.prepare(
      'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    )
      .bind('pages_manifest', JSON.stringify(manifest))
      .run();

    // 清理策略：保留上一版图片（前台配置有 30 秒缓存，老访客还在引用上一版），
    // 只清理"上上一版"
    const prevRow = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('pages_prev').first();
    const prevOld = prevRow ? JSON.parse(prevRow.value) : null;
    if (prevOld && prevOld.version !== version && (!cur || prevOld.version !== cur.version) && prevOld.count > 0) {
      const olds = [];
      for (let i = 1; i <= prevOld.count; i++) olds.push(`page_v${prevOld.version}_${i}`);
      for (let i = 0; i < olds.length; i += 10) {
        await Promise.all(olds.slice(i, i + 10).map((k) => deleteFile(env, k)));
      }
    }
    if (cur && cur.version !== version) {
      await env.DB.prepare(
        'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
        .bind('pages_prev', JSON.stringify(cur))
        .run();
    }
    return json({ ok: true, manifest: { version, count: pages.length } });
  }

  // 二维码
  if (type === 'qrcode') {
    if (!(file instanceof File)) return json({ ok: false, error: '缺少文件' }, 400);
    if (file.size > 4 * 1024 * 1024) return json({ ok: false, error: '图片不能超过 4MB' }, 400);
    if (!/^image\//.test(file.type)) return json({ ok: false, error: '请上传图片文件' }, 400);
    const stores = await saveFile(env, 'qrcode_img', await file.arrayBuffer(), file.type);
    const vRow = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('qr_version').first();
    const version = (vRow ? +vRow.value : 0) + 1;
    await env.DB.prepare(
      'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    )
      .bind('qr_version', String(version))
      .run();
    return json({ ok: true, version });
  }

  return json({ ok: false, error: '未知类型' }, 400);
}

// DELETE /api/upload —— 删除当前作品集（需登录）
// 清除所有 R2 页面图片 + PDF 分块 + D1 记录，保留站点设置和二维码
export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  // 读取当前和上一版 manifest
  const mfRow = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('pages_manifest').first();
  const cur = mfRow ? JSON.parse(mfRow.value) : null;
  const prevRow = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('pages_prev').first();
  const prev = prevRow ? JSON.parse(prevRow.value) : null;

  // 删除 R2 页面图片
  const versions = [cur, prev].filter(Boolean);
  for (const m of versions) {
    for (let i = 1; i <= (m.count || 0); i++) {
      await deleteFile(env, `page_v${m.version}_${i}`);
    }
  }

  // 删除 PDF 分块
  const pdfRow = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('pdf_info').first();
  const pdfInfo = pdfRow ? JSON.parse(pdfRow.value) : null;
  if (pdfInfo && pdfInfo.size) {
    const chunks = Math.ceil(pdfInfo.size / (20 * 1024 * 1024));
    for (let i = 0; i < chunks; i++) {
      await deleteFile(env, `pdf_chunk_${i}`);
    }
  }

  // 清除 D1 记录
  await env.DB.prepare('DELETE FROM config WHERE key IN (?, ?, ?)')
    .bind('pages_manifest', 'pages_prev', 'pdf_info')
    .run();

  // 清除配置中的 pages 排序
  const cfgRow = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('site_config').first();
  if (cfgRow) {
    try {
      const cfg = JSON.parse(cfgRow.value);
      cfg.pages = null;
      await env.DB.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .bind('site_config', JSON.stringify(cfg))
        .run();
    } catch (e) {}
  }

  // 清除 CDN 缓存
  try {
    const cache = caches.default;
    const cfgUrl = new URL('https://placeholder.example.com/api/config');
    await cache.delete(cfgUrl);
  } catch (e) {}

  return json({ ok: true });
}
