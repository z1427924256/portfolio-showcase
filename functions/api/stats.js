import { json, verifyToken } from '../_lib';

// 简易内存缓存（同一 Worker 实例 30 秒内复用结果，减少 D1 并发查询）
let _statsCache = null;
let _statsCacheTs = 0;
const STATS_TTL = 30 * 1000;

// GET /api/stats —— 访客统计（需登录）
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await verifyToken(request, env))) return json({ ok: false, error: '登录已过期，请重新登录' }, 401);

  // 命中缓存直接返回
  const now = Date.now();
  if (_statsCache && now - _statsCacheTs < STATS_TTL) {
    return json({ ok: true, stats: _statsCache, cached: true });
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [total, today, week, byDay, byDevice, byRegion, byPortfolio, recent] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) c, COUNT(DISTINCT session) u FROM visits').first(),
    env.DB.prepare('SELECT COUNT(*) c, COUNT(DISTINCT session) u FROM visits WHERE ts >= ?')
      .bind(todayStart.getTime()).first(),
    env.DB.prepare('SELECT COUNT(*) c, COUNT(DISTINCT session) u FROM visits WHERE ts >= ?')
      .bind(now - 7 * 86400 * 1000).first(),
    env.DB.prepare(
      "SELECT date(ts/1000, 'unixepoch', '+8 hours') d, COUNT(*) c, COUNT(DISTINCT session) u FROM visits WHERE ts >= ? GROUP BY d ORDER BY d"
    )
      .bind(now - 13 * 86400 * 1000).all(),
    env.DB.prepare('SELECT device k, COUNT(*) c FROM visits GROUP BY device ORDER BY c DESC').all(),
    env.DB.prepare(
      "SELECT CASE WHEN region_cn IS NULL OR region_cn='' THEN '未知' ELSE region_cn END k, COUNT(*) c FROM visits GROUP BY k ORDER BY c DESC LIMIT 10"
    ).all(),
    // 作品集访问排行（slug 关联标题；兼容未记录 slug 的旧行）
    env.DB.prepare(
      `SELECT COALESCE(NULLIF(v.slug, ''), '(未记录)') k, COUNT(*) c
       FROM visits v GROUP BY v.slug ORDER BY c DESC LIMIT 10`
    ).all(),
    env.DB.prepare(
      'SELECT ts, ip, region_cn, device, slug FROM visits ORDER BY id DESC LIMIT 100'
    ).all(),
  ]);

  const stats = {
    total: total || { c: 0, u: 0 },
    today: today || { c: 0, u: 0 },
    week: week || { c: 0, u: 0 },
    byDay: byDay.results || [],
    byDevice: byDevice.results || [],
    byRegion: byRegion.results || [],
    byPortfolio: byPortfolio.results || [],
    recent: recent.results || [],
  };

  // 写入缓存
  _statsCache = stats;
  _statsCacheTs = Date.now();

  return json({ ok: true, stats });
}
