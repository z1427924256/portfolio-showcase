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
// 读：R2 优先，KV 作可选兜底（未绑定 KV 时自动跳过）；写：R2 为主，KV 双写（如已绑定）；删：双删。

/** 读取文件，返回 { buf } 或 null */
export async function loadFile(env, key) {
  if (env.R2) {
    try {
      const obj = await env.R2.get(key);
      if (obj) return { buf: await obj.arrayBuffer() };
    } catch (e) {}
  }
  if (env.FILES) {
    try {
      const buf = await env.FILES.get(key, { type: 'arrayBuffer' });
      if (buf != null) return { buf };
    } catch (e) {}
  }
  return null;
}

/** 双写 R2 + KV，返回实际写入成功的存储列表（如 ['r2','kv']） */
export async function saveFile(env, key, buf, contentType) {
  const results = await Promise.allSettled([
    env.R2 ? env.R2.put(key, buf, { httpMetadata: { contentType } }) : Promise.reject(new Error('R2 未绑定')),
    env.FILES ? env.FILES.put(key, buf, { contentType }) : Promise.reject(new Error('KV 未绑定')),
  ]);
  const stores = [];
  if (results[0].status === 'fulfilled') stores.push('r2');
  if (results[1].status === 'fulfilled') stores.push('kv');
  if (!stores.length) throw new Error('文件保存失败');
  return stores;
}

/** 双删 R2 + KV */
export async function deleteFile(env, key) {
  await Promise.all([
    env.R2 ? env.R2.delete(key).catch(() => {}) : Promise.resolve(),
    env.FILES ? env.FILES.delete(key).catch(() => {}) : Promise.resolve(),
  ]);
}
