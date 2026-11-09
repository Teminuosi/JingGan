# 镜感（JingGan）项目说明

AI 视频复刻网站：上传参考片 → Gemini 拆解成 video-dna → 改编故事 → 设计角色 → 3D 预演 → Seedance 出片 → 包装导出。
线上 https://jinggan.3yuedaohang.com（Cloudflare Workers + D1 + R2），代码 GitHub `Teminuosi/JingGan`（main）。
2026-11-08 起工作目录是 `F:\claude-project\jinggan`（旧的 `F:\codex-project\视频复刻极客版` 已删除，连同只在本机的 PROJECT.md / .env.local 一起没了）。

## 命令
- 安装：`npm ci`（Node ≥ 22.13）
- 本地站点：`npx vinext dev --port 3123`（需要登录；本地缺 .env.local 时登录不了，线上实测）
- 类型检查：`node node_modules/typescript/bin/tsc --noEmit -p .`；lint：`npm run lint`；全套测试：`npm test`（Mock，不花钱）
- 部署：`npm run build:cloudflare` → `npm run check:cloudflare`（dry-run）→ `npm run deploy:cloudflare`。配置文件必须叫 `wrangler.cloudflare.jsonc`（叫 wrangler.jsonc 会被 vite 插件混进本地 dev）。细节见 docs/cloudflare-deployment.md。

## 架构要点
- AI 全走用户自己的中转（默认 heyroute），Key 只存浏览器 localStorage，四个角色：analysis / text / image / video（app/lib/relay-client.ts）。
- 视频分析：app/lib/gemini.ts `analyzeRelayVideo`，整段视频 base64 inlineData 经 `/api/relay/native` 转发，流式返回。
- 报错翻译：gemini.ts `friendlyError`；失败提示下的「AI 帮我分析原因」：app/components/ErrorDiagnose.tsx（只在点击时调用户的文本模型）。

## 坑（现象 / 根因 / 怎么避）
- 2026-11-08 分析 202MB 视频报 413 Payload Too Large：镜感站和 heyroute 前面都是 Cloudflare，单请求体上限 100MB（不带 Key 发空包实测 95MB 过、110MB 拒），base64 还要胀 1/3。→ 原片 > 45MB 先在浏览器压成 480p（app/lib/analysis-compress.ts）。
- 2026-11-08 Windows Chrome 的 AAC 编码器不支持单声道 64k，mediabunny 会把音轨静默丢掉（discard reason `no_encodable_target_codec`），压出来是哑片。→ 用 `canEncodeAudio` 挑能编的档；原片有声、输出没声就报错。
- 分析是付费调用：失败时区分「未提交（没扣费）」和「提交后失联（可能已扣费）」，发请求前就失败的抛 `RelayNotSubmittedError`。
- 2026-11-08 `git push` 报 403「Permission to Teminuosi/JingGan.git denied」：本机 Git 凭据（细粒度令牌）对 JingGan 仓库没有 contents:write。→ 需三月给令牌加 JingGan 写权限或自己推；本地提交照常做。
- 部署（`npm run deploy:cloudflare`）是线上发布，Claude 自动权限会拦，需三月明确同意或自己跑。
- 2026-11-08 229 秒的片子分析被整份拒收：模型把最后一拍标成 230 秒，校验只容 0.01 秒。→ normalize-drift.ts `clampSlightTimeOverrun`：越出本镜 ≤2 秒（且不超过镜头时长）的 at_seconds / entry_at / exit_at 收回边界并记入改动清单；越界更多照旧拒收。旧的 `analyzeVideo`（parseVideoDna 路径）界面没再用，未同步这条。
- 2026-11-08 我误报过「全套测试通过」：后台命令写成 `npm test …; echo exit $?; tail`，任务的退出码是 tail 的 0，实际 test-story-panel 已失败（它给 relay-client 做了替身，组件新引用的导出要补进替身）。→ 看 `npm test` 自己的退出码（`rc=$?` 先存），并 grep 日志里的 ERROR。
- 2026-11-08 线上实测：页面打开几秒后会自动恢复上次的项目，这时往上传框塞文件会落空。→ 先点「分析另一个视频」回到上传页（只清界面，项目记录还在），再选文件。
- 2026-11-08 推送 403 的解法：环境变量 GH_TOKEN（细粒度令牌）没有 JingGan 写权限，但 gh 钥匙串里的登录有 repo 权限。→ 推送时临时不用 GH_TOKEN、改用 gh 的登录凭据（gh auth git-credential），不用改令牌。Claude 自动权限可能拦这一步，需三月同意。
- 2026-11-08 已解决：三月给 GH_TOKEN 对应的细粒度令牌 tms-desktop 加上了 JingGan（Contents 读写），现在直接 `git push` 就行，上面两条推送的绕路办法不用了。
