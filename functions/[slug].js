// /{slug} —— 作品集直达路由
// - 保留路径（admin/guide/thanks 等）交由静态资源处理
// - 已发布作品集：返回前台页面（index.html），前端按 pathname 渲染对应作品集
// - 不存在 / 未发布：跳转导航页 /guide
// - /sitemap.xml：动态生成站点地图（SEO）

const RESERVED = new Set([
  'admin', 'guide', 'thanks', 'login', 'api', 'assets', 'vendor',
  'favicon.ico', 'robots.txt', 'index.html', '_redirects',
]);

function redirect(location, status = 302) {
  return new Response(null, { status, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const slug = String(params.slug || '').slice(0, 40);

  // sitemap.xml —— 动态生成站点地图（SEO）
  if (slug === 'sitemap.xml') {
    let urls = [];
    try {
      const { results } = await env.DB.prepare(
        'SELECT slug, updated_at FROM portfolios WHERE is_published=1 AND page_count > 0 ORDER BY sort_order, id'
      ).all();
      const origin = new URL(request.url).origin;
      urls = (results || []).map((r) => {
        const lastmod = r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 10) : '';
        return `<url><loc>${origin}/${encodeURIComponent(r.slug)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<changefreq>weekly</changefreq></url>`;
      });
    } catch (e) {}
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${new URL(request.url).origin}/guide</loc><changefreq>weekly</changefreq></url>\n${urls.join('\n')}\n</urlset>`;
    return new Response(xml, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
    });
  }

  // 保留路径 → 静态资源
  if (RESERVED.has(slug)) {
    return env.ASSETS.fetch(request);
  }

  // 合法 slug 格式
  if (!/^[\w-]{1,40}$/.test(slug)) {
    return redirect('/guide');
  }

  // 查作品集
  let row = null;
  try {
    row = await env.DB.prepare('SELECT id, slug, is_published FROM portfolios WHERE slug=?').bind(slug).first();
  } catch (e) {}

  if (row && row.is_published === 1) {
    // 返回前台页面（保留原始 URL，前端 JS 按 pathname 加载作品集）
    return env.ASSETS.fetch(new URL('/', request.url));
  }

  return redirect('/guide');
}

// 其余方法（POST 等）不适用于页面路由
export async function onRequestPost() {
  return new Response('Method Not Allowed', { status: 405, headers: { 'Cache-Control': 'no-store' } });
}
