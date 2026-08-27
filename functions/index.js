// / —— 根路径
// 智能跳转：仅有一个已发布的作品集时直达该作品集，否则跳转导航页 /guide
function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  let rows = [];
  try {
    const { results } = await env.DB.prepare(
      'SELECT slug FROM portfolios WHERE is_published=1 AND page_count > 0 ORDER BY sort_order, id'
    ).all();
    rows = results || [];
  } catch (e) {}

  if (rows.length === 1) {
    return redirect('/' + rows[0].slug);
  }
  return redirect('/guide');
}

export async function onRequestHead() {
  return new Response(null, { status: 302, headers: { Location: '/guide', 'Cache-Control': 'no-store' } });
}
