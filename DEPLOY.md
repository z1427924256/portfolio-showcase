# 多作品集系统 · 部署指引

## 一、本次改动概览

| 模块 | 说明 |
|---|---|
| 数据库 | 新增 `portfolios` 表（多作品集 + 密码/访问上限/发布状态），`visits` 表新增 `slug` 列 |
| 后端 API | `/api/portfolios` CRUD、`/api/upload` 按作品集上传、`/api/config` 按作品集返回、`/api/access` 密码验证 |
| 路由 | `/{slug}` 作品集直达、`/sitemap.xml` 动态站点地图（SEO）、`/` 智能跳转 |
| 前台 | 密码门、胶囊/斜纹平铺双水印样式、按 slug 加载图片 |
| 后台 | 「作品集」管理页（新建/编辑/删除/复制链接/密码/访问上限）、上传与页面管理均按作品集隔离 |

## 二、部署步骤（已有 v1 站点升级）

```bash
cd portfolio-app

# 1. 登录 Cloudflare（会打开浏览器授权）
npx wrangler login

# 2. 执行 v2 数据库迁移（仅需一次）
#    命令行方式：
npx wrangler d1 execute portfolio-showcase-db --remote --file=schema_v2.sql

#    注意：ALTER TABLE 若重复执行会报"column already exists"，属正常，忽略即可。
#    若 prefers Dashboard：D1 → portfolio-showcase-db → Console → 粘贴 schema_v2.sql 执行。

# 3. 部署代码
npx wrangler pages deploy . --project-name=portfolio-showcase

# 4. 验证
#    打开 https://你的域名/admin 登录后，
#    「作品集」标签页应显示自动迁移来的「default 作品集」（含旧数据）。
```

## 三、全新站点部署

```bash
npx wrangler d1 execute portfolio-showcase-db --remote --file=schema.sql
npx wrangler d1 execute portfolio-showcase-db --remote --file=schema_v2.sql
npx wrangler pages deploy . --project-name=portfolio-showcase
```

> 全新站点无旧数据时，首次打开 `/admin` 会自动创建「我的第一个作品集」。

## 四、迁移说明（自动兜底）

即使不执行 `schema_v2.sql` 中的 INSERT 语句，`/api/portfolios` 首次被调用时也会自动把旧版单作品集数据（`config` 表中的 `pages_manifest` / `pdf_info`）迁移为 slug 为 `default` 的作品集，前台旧链接 `/?slug=default` 继续可用。但 `visits` 表的 `slug` 列必须通过 `schema_v2.sql` 添加，否则访问统计写入失败。

## 五、架构要点

- **存储隔离**：每个作品集的 R2 对象带 `pf{id}_` 前缀，删除作品集时按前缀清理。
- **图片 URL**：`/api/file/{slug}/page/v{版本}/{页码}.webp`，旧格式 `/api/file/page/...` 兼容 default 作品集。
- **密码保护**：PBKDF2 哈希存储，验证通过后签发 HttpOnly Cookie（7 天）；受保护作品集的图片与配置均绕过共享边缘缓存，防止按 URL 绕过密码。
- **访问上限**：达到上限后 `/api/config` 返回 `blocked: true`，前台显示失效提示。
- **水印**：`capsule`（磨砂胶囊底部居中）/ `tile`（斜纹平铺全屏，防截图分享），在后台「内容设置」中选择，全局生效。
- **SEO**：`/sitemap.xml` 动态列出已发布作品集；`/{slug}` 直达路由返回完整前台页面。

## 六、待办（二期）

- Resend 邮件通知（作品集被访问时通知站长）
- 作品集复制功能

> 已完成（原二期项）：后台水印实时预览（胶囊/斜纹平铺双样式切换）、作品集列表卡片化排序（上下移持久化）、作品集访问排行统计。
> 已下线：使用申请功能（`/api/request` 与感谢页表单已删除，`schema_v2.sql` 含 `DROP TABLE IF EXISTS requests` 幂等清理）。
