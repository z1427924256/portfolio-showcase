import { loadFile } from '../../_lib';

const CHUNK = 20 * 1024 * 1024;

/** 按魔数识别图片格式：WebP(RIFF....WEBP) / 否则视为 JPEG */
function imgContentType(buf) {
  const b = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function notFound() {
  return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

// slug 校验：字母数字下划线连字符，长度 1-40
const SLUG_RE = /^[\w-]{1,40}$/;

/** 按 slug 查作品集（拿 r2_prefix 与密码状态），default 表示旧版单作品集 */
async function findPortfolio(env, slug) {
  if (slug === 'default') {
    const row = await env.DB.prepare("SELECT slug, r2_prefix, password FROM portfolios WHERE slug='default'").first();
    return row || { slug: 'default', r2_prefix: '', password: '' };
  }
  if (!SLUG_RE.test(slug)) return null;
  const row = await env.DB.prepare('SELECT slug, r2_prefix, password FROM portfolios WHERE slug=?').bind(slug).first();
  return row || null;
}

// GET /api/file/{slug}/page/v{version}/{index}.webp|.jpg —— 作品集页面图片
// GET /api/file/page/v{version}/{index}.webp|.jpg —— 旧版兼容（default 作品集）
// GET /api/file/qrcode —— 二维码（全局）
// GET /api/file/pdf/v{v}/{size}.pdf —— 旧版 PDF 兜底（default 作品集）
export async function onRequestGet(context) {
  const { request, env, params } = context;
  const parts = params.path || [];
  const path = parts.join('/');
  const cache = caches.default;

  // 二维码（全局资源，与作品集无关）
  if (path === 'qrcode' || path === 'qrcode.png') {
    let cached = null;
    try {
      cached = await cache.match(request);
    } catch (e) {}
    if (cached) return cached;

    const obj = await loadFile(env, 'qrcode_img');
    if (!obj) return notFound();

    const vRow = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('qr_version').first();
    const version = vRow ? +vRow.value : 1;

    const res = new Response(obj.buf, {
      headers: {
        'Content-Type': imgContentType(obj.buf),
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: `"qr-${version}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
    try {
      await cache.put(request, res.clone());
    } catch (e) {}
    return res;
  }

  // 解析路径：区分「新格式（带 slug）」与「旧格式（default）」
  // 新：{slug}/page/v{v}/{i}.ext
  // 旧：page/v{v}/{i}.ext
  let slug = 'default';
  let rest = parts;

  if (parts.length >= 4 && parts[0] !== 'page' && parts[0] !== 'pdf') {
    slug = parts[0];
    rest = parts.slice(1);
  }

  // ---------- 页面图片 ----------
  const pm = rest.join('/').match(/^page\/v(\d{1,4})\/(\d{1,3})\.(jpg|webp)$/);
  if (pm) {
    const version = +pm[1];
    const index = +pm[2];
    if (version < 1 || version > 1000 || index < 1 || index > 500) return notFound();

    // 无密码作品集：先查边缘缓存（命中则跳过 D1 查询）
    let cached = null;
    try {
      cached = await cache.match(request);
    } catch (e) {}
    if (cached) return cached;

    const pf = await findPortfolio(env, slug);
    if (!pf) return notFound();

    const obj = await loadFile(env, `${pf.r2_prefix || ''}page_v${version}_${index}`);
    if (!obj) return notFound();

    const protectedPf = !!(pf.password && pf.password.length > 0);
    // 受密码保护的作品集：响应不进入共享边缘缓存（按 URL 缓存会绕过密码）
    const cacheCtl = protectedPf
      ? 'private, max-age=600'
      : 'public, max-age=31536000, immutable';

    const res = new Response(obj.buf, {
      headers: {
        'Content-Type': imgContentType(obj.buf),
        'Cache-Control': cacheCtl,
        ETag: `"${slug}-p${version}-${index}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
    if (!protectedPf) {
      try {
        await cache.put(request, res.clone());
      } catch (e) {}
    }
    return res;
  }

  // ---------- 旧版 PDF 兜底（default 作品集） ----------
  const m = rest.join('/').match(/^pdf\/v(\d+)\/(\d+)\.pdf$/);
  if (!m) return notFound();

  const version = +m[1];
  const total = +m[2];
  const row = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('pdf_info').first();
  const info = row ? JSON.parse(row.value) : null;
  if (!info || info.version !== version || info.size !== total) {
    return new Response('文件已更新，请刷新页面', {
      status: 410,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  const rangeHeader = request.headers.get('Range');
  const headers = {
    'Content-Type': 'application/pdf',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    ETag: `"pdf-${version}-${total}"`,
  };

  const readRange = async (start, end) => {
    const firstChunk = Math.floor(start / CHUNK);
    const lastChunk = Math.floor(end / CHUNK);
    const partsArr = [];
    for (let i = firstChunk; i <= lastChunk; i++) {
      const f = await loadFile(env, `pdf_chunk_${i}`);
      if (!f) break;
      const arr = new Uint8Array(f.buf);
      const from = i === firstChunk ? start - i * CHUNK : 0;
      const to = i === lastChunk ? end - i * CHUNK : arr.length - 1;
      partsArr.push(arr.slice(from, to + 1));
    }
    const total2 = partsArr.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total2);
    let off = 0;
    for (const p of partsArr) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  };

  if (!rangeHeader) {
    let idx = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          if (cancelled || idx >= info.chunks) {
            controller.close();
            return;
          }
          const i = idx++;
          const f = await loadFile(env, `pdf_chunk_${i}`);
          if (!f) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(f.buf));
        } catch (e) {
          try {
            controller.close();
          } catch (e2) {}
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { ...headers, 'Content-Length': String(total) },
    });
  }

  const rm = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!rm) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }
  const start = +rm[1];
  const end = rm[2] === '' ? total - 1 : Math.min(+rm[2], total - 1);
  if (start >= total || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }

  const slice = await readRange(start, end);
  return new Response(slice, {
    status: 206,
    headers: {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(end - start + 1),
    },
  });
}

export async function onRequestHead(context) {
  const { request, env, params } = context;
  const path = (params.path || []).join('/');
  const m = path.match(/^(?:[\w-]+\/)?pdf\/v(\d+)\/(\d+)\.pdf$/);
  if (!m) return new Response(null, { status: 404 });
  const row = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('pdf_info').first();
  const info = row ? JSON.parse(row.value) : null;
  if (!info || info.version !== +m[1] || info.size !== +m[2]) {
    return new Response(null, { status: 410 });
  }
  return new Response(null, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ETag: `"pdf-${m[1]}-${m[2]}"`,
      'Content-Length': String(info.size),
    },
  });
}
