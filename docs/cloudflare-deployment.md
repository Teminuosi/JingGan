# Cloudflare 部署

镜感使用 Cloudflare Workers、D1 和 R2，沿用 Vite/vinext 构建。博客继续独立部署，账号复用博客 Supabase；两站的登录会话独立。

所有命令在项目根目录执行，Node >=22.13.0。先 `npm ci`。`wrangler.jsonc` 中的账户、数据库和域名需替换为自己的资源。不要将 Cloudflare 凭据写进该文件。

```sh
node node_modules/wrangler/bin/wrangler.js d1 migrations apply jinggan-db --remote --config wrangler.jsonc
npm run build:cloudflare
npm run check:cloudflare
npm run deploy:cloudflare
node node_modules/wrangler/bin/wrangler.js secret put SUPABASE_URL --config dist/server/wrangler.json
node node_modules/wrangler/bin/wrangler.js secret put SUPABASE_PUBLISHABLE_KEY --config dist/server/wrangler.json
```

迁移只用于镜感独立 D1，不用于博客数据库。两个 Supabase 设置使用项目 URL 与公开 publishable/anon Key，禁止使用管理 PAT 或 service_role Key。Cloudflare 登录凭据通过 Wrangler 登录或进程环境提供，不进入源码。

`MIRROR_AUTH_ENABLED=true` 强制登录；`MIRROR_LOCAL_CLAIMS=false` 禁止线上认领本地项目；`MIRROR_RELAY_ALLOWED_ORIGINS` 限定 HTTPS 服务地址。用户自己的 AI Key 每次请求携带，服务端不保存。推广入口配置为 `MIRROR_RELAY_REFERRAL_URL`。

线上 `MIRROR_PIPELINE_ENABLED=false`：后台自动出片队列需要 Node worker，目前没有云端任务运行器，不开放这个入口。分析、故事、角色和分镜创作沿用现有服务；3D 渲染通过用户本机助手完成。即梦 API 是否接受参考视频仍取决于现有适配器，部署本身不会增加视频上传能力。

构建只复制网站所需公开资源，排除 Windows 安装包及本地角色实验图。助手 ZIP 不放进网站资源；发布安装包后设置 `MIRROR_HELPER_DOWNLOAD_URL` 和 `MIRROR_HELPER_OFFLINE_URL`。未配置时明确显示发布页和安装包尚未发布提示。打包许可与对应源码状态见 [runtime-distribution.md](runtime-distribution.md)，未完成前不发布现有草稿安装包。

验证：`node node_modules/typescript/bin/tsc --noEmit`、`npm run lint`、`npm run test:auth`、`npm run test:cloudflare`、`node scripts/test-relay.mjs`；`check:cloudflare` 为 Wrangler 部署 dry-run，不上传。模型测试使用 Mock，不产生付费调用。部署后检查首页、`/api/auth/config`、匿名项目/代理请求拒绝及 HTTPS 域名；真实账号、模型生成和本机渲染另行验收。
