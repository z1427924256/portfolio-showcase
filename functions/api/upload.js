import { json, verifyToken, saveFile, deleteFile, purgeConfigs } from '../_lib';

// 读取作品集（校验归属），失败返回 null
async function getPortfolio(env, id) {
  const pid = parseInt(id, 10);
  if (!pid || pid < 1 || pid > 1e9) return null;
  const row = await env.DB.prepare('SELECT * FROM portfolios WHERE id=?').bind(pid).first();
  return row || null;
}

// POST /api/upload —— 上传页面图片 / 页面清单 / 二维码（需登录）
// 多作品集：除 qrcode 外均需携带 portfolio_id
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
  const file = form.get('file');

  // 二维码（全局，与作品集无关）
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

  // ---------- 以下类型均需要 portfolio_id ----------
  const pf = await getPortfolio(env, form.get('portfolio_id'));
  if (!pf) return json({ ok: false, error: '作品集不存在或未选择' }, 404);
  const prefix = pf.r2_prefix || '';

  // 预约新版本号（渲染前调用）
  // 注意：仅读取当前版本号 +1 返回，不做原子预约。
  // 并发场景下 pages_manifest 提交时会校验 version > 当前版本，
  // 后提交者会被拒绝（单后台管理员场景下足够安全）。
  if (type === 'pages_begin') {
    let cur = null;
    try { cur = pf.pages ? JSON.parse(pf.pages) : null; } catch {}
    return json({ ok: true, version: (cur ? cur.version : 0) + 1 });
  }

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
    const stores = await saveFile(env, `${prefix}page_v${version}_${index}`, await file.arrayBuffer(), file.type || 'image/jpeg');
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

    let cur = null;
    try { cur = pf.pages ? JSON.parse(pf.pages) : null; } catch {}
    if (cur && version <= cur.version) return json({ ok: false, error: '版本号已过期，请重新上传' }, 400);

    let prevOld = null;
    try { prevOld = pf.pages_prev ? JSON.parse(pf.pages_prev) : null; } catch {}

    const manifest = { version, count: pages.length, pages, uploaded_at: Date.now() };
    await env.DB.prepare(
      'UPDATE portfolios SET version=?, page_count=?, pages=?, pages_prev=?, updated_at=? WHERE id=?'
    )
      .bind(version, pages.length, JSON.stringify(manifest), pf.pages || null, Date.now(), pf.id)
      .run();

    // 清理策略：保留上一版图片（前台配置有 30 秒缓存，老访客还在引用上一版），
    // 只清理"上上一版"
    if (prevOld && prevOld.version !== version && (!cur || prevOld.version !== cur.version) && prevOld.count > 0) {
      const olds = [];
      for (let i = 1; i <= prevOld.count; i++) olds.push(`${prefix}page_v${prevOld.version}_${i}`);
      for (let i = 0; i < olds.length; i += 10) {
        await Promise.all(olds.slice(i, i + 10).map((k) => deleteFile(env, k)));
      }
    }

    await purgeConfigs(env, new URL(request.url).origin);
    return json({ ok: true, manifest: { version, count: pages.length } });
  }

  return json({ ok: false, error: '未知类型' }, 400);
}
