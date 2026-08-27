import { json, verifyToken, saveFile, deleteFile } from '../_lib';

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

  // KV → R2 存量数据迁移（一次性运维操作，keys 为逗号分隔的键名，单次 ≤ 20 个）
  if (type === 'kv_to_r2') {
    if (!env.R2) return json({ ok: false, error: '未绑定 R2 存储桶' }, 400);
    const keys = String(form.get('keys') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!keys.length || keys.length > 20) return json({ ok: false, error: 'keys 参数错误（1-20 个键名）' }, 400);
    const done = [], failed = [];
    for (const k of keys) {
      try {
        const { value, metadata } = await env.FILES.getWithMetadata(k, { type: 'arrayBuffer' });
        if (value == null) { failed.push({ key: k, error: 'KV 中不存在' }); continue; }
        await env.R2.put(k, value, {
          httpMetadata: { contentType: (metadata && metadata.contentType) || 'application/octet-stream' },
        });
        done.push(k);
      } catch (e) {
        failed.push({ key: k, error: String((e && e.message) || e) });
      }
    }
    return json({ ok: failed.length === 0, done, failed });
  }

  // 列出 KV 键（迁移前后核查用）
  if (type === 'kv_list') {
    const cursor = String(form.get('cursor') || '');
    const list = await env.FILES.list({ cursor: cursor || undefined, limit: 100 });
    return json({ ok: true, keys: list.keys.map((k) => k.name), cursor: list.cursor || null });
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
    if (prevOld && prevOld.version !== version && prevOld.version !== (cur && cur.version) && prevOld.count > 0) {
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
