import { json, verifyToken } from '../_lib';

// POST /api/request —— 感谢页提交使用申请（公开，带频率限制）
export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '参数错误' }, 400);
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{2,}\.[^\s@]{2,}$/.test(email) || email.length > 100) {
    return json({ ok: false, error: '邮箱格式不正确' }, 400);
  }

  // 同邮箱 24 小时内只收一次
  const dayAgo = Date.now() - 86400000;
  const dup = await env.DB.prepare(
    'SELECT id FROM requests WHERE email=? AND ts>? LIMIT 1'
  ).bind(email, dayAgo).first();
  if (dup) {
    return json({ ok: true, duplicated: true });
  }

  const ip =
    (request.headers.get('cf-connecting-ip') || '').slice(0, 45) || 'unknown';
  const ua = (request.headers.get('user-agent') || '').slice(0, 200);

  try {
    await env.DB.prepare('INSERT INTO requests (email, ts, ip, ua) VALUES (?, ?, ?, ?)')
      .bind(email, Date.now(), ip, ua)
      .run();
  } catch (e) {
    return json({ ok: false, error: '提交失败，请稍后再试' }, 500);
  }

  return json({ ok: true });
}

// GET /api/request —— 查看申请列表（需登录）
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  const { results } = await env.DB.prepare(
    'SELECT id, email, ts, ip, ua FROM requests ORDER BY ts DESC LIMIT 500'
  ).all();

  return json({ ok: true, list: results || [] });
}

// DELETE /api/request?id= —— 删除一条申请（需登录）
export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  const id = parseInt(new URL(request.url).searchParams.get('id'), 10);
  if (!id) return json({ ok: false, error: '参数错误' }, 400);

  await env.DB.prepare('DELETE FROM requests WHERE id=?').bind(id).run();
  return json({ ok: true });
}
