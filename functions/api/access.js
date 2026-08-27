import { json, getSecret, signAccess, verifyPassword, verifyToken } from '../_lib';

const SLUG_RE = /^[\w-]{1,40}$/;

// POST /api/access —— 前台作品集密码验证（公开，带频率限制）
// body: { slug, password }
// 成功设置 HttpOnly Cookie（有效期 7 天），前台随后重新拉取 config
export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  let body = {};
  try {
    body = JSON.parse(await request.text());
  } catch {}

  const slug = String(body.slug || '').slice(0, 40);
  const password = String(body.password || '').slice(0, 64);
  if (!SLUG_RE.test(slug) && slug !== 'default') {
    return json({ ok: false, error: '作品集不存在' }, 404);
  }
  if (!password) return json({ ok: false, error: '请输入密码' }, 400);

  // 查作品集
  const row = await env.DB.prepare('SELECT id, slug, password FROM portfolios WHERE slug=?').bind(slug).first();
  if (!row) return json({ ok: false, error: '作品集不存在' }, 404);
  if (!row.password) return json({ ok: false, error: '该作品集无需密码' }, 400);

  // 验证密码（PBKDF2，常数时间比较）
  const ok = await verifyPassword(password, row.password);
  if (!ok) {
    // 防爆破：简单延迟
    await new Promise((r) => setTimeout(r, 300));
    return json({ ok: false, error: '密码不正确' }, 401);
  }

  // 签发访问授权 cookie（7 天）
  const secret = await getSecret(env);
  if (!secret) return json({ ok: false, error: '系统未初始化' }, 500);
  const exp = Date.now() + 7 * 86400 * 1000;
  const token = await signAccess(secret, row.slug, exp);

  const res = json({ ok: true });
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  res.headers.append(
    'Set-Cookie',
    `pfa=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400};${secure}`
  );
  res.headers.append('Cache-Control', 'no-store');
  return res;
}

// DELETE /api/access —— 管理端主动吊销某作品集的所有已发放访问授权（需登录）
// 实现方式：轮换 auth_secret（会使所有作品集访问 cookie 和管理登录 token 失效）
export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  const secret = await getSecret(env);
  if (!secret) return json({ ok: false, error: '系统未初始化' }, 500);

  // 生成新 secret（32 字节随机）
  const newSecret = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  await env.DB.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  )
    .bind('auth_secret', newSecret)
    .run();

  return json({ ok: true, note: '已吊销所有访问授权，管理端需重新登录' });
}
