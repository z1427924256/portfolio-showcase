import { json, verifyPassword, verifyToken, randB64, hashPassword, signToken } from '../_lib';

// POST /api/auth —— 登录（带失败次数限制）
export async function onRequestPost(context) {
  const { request, env } = context;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();

  const att = await env.DB.prepare('SELECT fails, last_ts FROM login_attempts WHERE ip=?').bind(ip).first();
  if (att && att.fails >= 5 && now - att.last_ts < 10 * 60 * 1000) {
    return json({ ok: false, error: '尝试次数过多，请 10 分钟后再试' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '参数错误' }, 400);
  }

  const passRow = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('admin_pass').first();
  if (!passRow) return json({ ok: false, error: '系统尚未初始化' }, 500);

  const ok = await verifyPassword(String(body.password || ''), passRow.value);
  if (!ok) {
    if (att) {
      await env.DB.prepare('UPDATE login_attempts SET fails=fails+1, last_ts=? WHERE ip=?').bind(now, ip).run();
    } else {
      await env.DB.prepare('INSERT INTO login_attempts (ip, fails, last_ts) VALUES (?, 1, ?)').bind(ip, now).run();
    }
    return json({ ok: false, error: '密码错误' }, 401);
  }

  await env.DB.prepare('DELETE FROM login_attempts WHERE ip=?').bind(ip).run();

  const { getSecret } = await import('../_lib');
  const secret = await getSecret(env);
  if (!secret) return json({ ok: false, error: '系统尚未初始化' }, 500);

  const exp = now + 12 * 3600 * 1000;
  const token = await signToken(secret, exp);
  return json({ ok: true, token, expires_in: 12 * 3600 });
}

// PUT /api/auth —— 修改密码（需登录）
export async function onRequestPut(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '参数错误' }, 400);
  }

  const np = String(body.new_password || '');
  if (np.length < 8) return json({ ok: false, error: '新密码至少 8 位' }, 400);

  const saltB64 = randB64(16);
  const hash = await hashPassword(np, saltB64);
  await env.DB.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  )
    .bind('admin_pass', `pbkdf2$100000$${saltB64}$${hash}`)
    .run();

  return json({ ok: true });
}
