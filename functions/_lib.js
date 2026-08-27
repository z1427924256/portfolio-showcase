// 共享工具：JSON 响应、鉴权、密码哈希
const enc = new TextEncoder();

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function getSecret(env) {
  const row = await env.DB.prepare('SELECT value FROM config WHERE key=?')
    .bind('auth_secret')
    .first();
  return row ? row.value : null;
}

export async function signToken(secret, exp) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(String(exp)));
  return `${exp}.${hex(mac)}`;
}

export async function verifyToken(request, env) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer (\d+)\.([a-f0-9]{64})$/);
  if (!m) return false;
  const exp = +m[1], sig = m[2];
  if (!exp || Date.now() > exp) return false;
  const secret = await getSecret(env);
  if (!secret) return false;
  const token = await signToken(secret, exp);
  const expected = token.split('.')[1];
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(password, saltB64, iterations = 100000) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256
  );
  return hex(bits);
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const calc = await hashPassword(password, parts[2], +parts[1]);
  let diff = 0;
  for (let i = 0; i < calc.length; i++) diff |= calc.charCodeAt(i) ^ parts[3].charCodeAt(i);
  return diff === 0;
}

export const randHex = (n) =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

export const randB64 = (n) =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n))));

// ---------- 文件存储：R2（唯一存储）----------

/** 读取文件，返回 { buf } 或 null */
export async function loadFile(env, key) {
  if (!env.R2) return null;
  try {
    const obj = await env.R2.get(key);
    if (obj) return { buf: await obj.arrayBuffer() };
  } catch (e) {}
  return null;
}

/** 写入 R2，返回存储列表 */
export async function saveFile(env, key, buf, contentType) {
  if (!env.R2) throw new Error('R2 未绑定');
  await env.R2.put(key, buf, { httpMetadata: { contentType } });
  return ['r2'];
}

/** 删除 R2 文件 */
export async function deleteFile(env, key) {
  if (!env.R2) return;
  try { await env.R2.delete(key); } catch (e) {}
}
