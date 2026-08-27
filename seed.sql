-- 初始化数据（敏感值已脱敏，部署时通过环境变量或 wrangler secret 注入）
INSERT INTO config (key, value) VALUES ('site_config', '{"title":"作品集","wm_enabled":true,"wm_text":"内容由 {name} 创作 · 感谢您的关注","wm_name":"","phone_enabled":false,"phone":"","qr_enabled":false,"pages":null}') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
-- admin_pass 和 auth_secret 请通过 wrangler secret 或后台首次设置时写入，切勿硬编码
