import { json, loadFile } from '../../_lib';

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

function pdfHeaders(version, total) {
  return {
    'Content-Type': 'application/pdf',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    ETag: `"pdf-${version}-${total}"`,
  };
}

async function loadPdfInfo(env) {
  const row = await env.DB.prepare('SELECT value FROM config WHERE key=?').bind('pdf_info').first();
  return row ? JSON.parse(row.value) : null;
}

async function readRange(env, start, end) {
  const firstChunk = Math.floor(start / CHUNK);
  const lastChunk = Math.floor(end / CHUNK);
  const parts = [];
  for (let i = firstChunk; i <= lastChunk; i++) {
    const f = await loadFile(env, `pdf_chunk_${i}`);
    if (!f) break;
    const arr = new Uint8Array(f.buf);
    const from = i === firstChunk ? start - i * CHUNK : 0;
    const to = i === lastChunk ? end - i * CHUNK : arr.length - 1;
    parts.push(arr.slice(from, to + 1));
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// GET /api/file/page/v{version}/{index}.jpg —— 页面图片（边缘缓存 + 浏览器长缓存）
// GET /api/file/qrcode?v= —— 二维码
// GET /api/file/pdf/v{v}/{size}.pdf —— 旧版 PDF（仅兜底）
export async function onRequestGet(context) {
  const { request, env, params } = context;
  const path = (params.path || []).join('/');
  const cache = caches.default;

  // 页面图片
  const pm = path.match(/^page\/v(\d{1,4})\/(\d{1,3})\.jpg$/);
  if (pm) {
    const version = +pm[1];
    const index = +pm[2];
    if (version < 1 || version > 1000 || index < 1 || index > 500) {
      return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    let cached = null;
    try {
      cached = await cache.match(request);
    } catch (e) {}
    if (cached) return cached;

    const obj = await loadFile(env, `page_v${version}_${index}`);
    if (!obj) return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

    const contentType = imgContentType(obj.buf);
    const res = new Response(obj.buf, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: `"p${version}-${index}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
    try {
      await cache.put(request, res.clone());
    } catch (e) {}
    return res;
  }

  // 二维码
  if (path === 'qrcode' || path === 'qrcode.png') {
    let cached = null;
    try {
      cached = await cache.match(request);
    } catch (e) {}
    if (cached) return cached;

    const obj = await loadFile(env, 'qrcode_img');
    if (!obj) return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

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

  // 旧版 PDF 兜底
  const m = path.match(/^pdf\/v(\d+)\/(\d+)\.pdf$/);
  if (!m) return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

  const version = +m[1];
  const total = +m[2];
  const info = await loadPdfInfo(env);
  if (!info || info.version !== version || info.size !== total) {
    return new Response('文件已更新，请刷新页面', {
      status: 410,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  const rangeHeader = request.headers.get('Range');
  const headers = pdfHeaders(version, total);

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

  const slice = await readRange(env, start, end);
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
  const m = path.match(/^pdf\/v(\d+)\/(\d+)\.pdf$/);
  if (!m) return new Response(null, { status: 404 });
  const info = await loadPdfInfo(env);
  if (!info || info.version !== +m[1] || info.size !== +m[2]) {
    return new Response(null, { status: 410 });
  }
  return new Response(null, {
    status: 200,
    headers: { ...pdfHeaders(+m[1], info.size), 'Content-Length': String(info.size) },
  });
}
