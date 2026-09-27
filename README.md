# 镜感 · JingGan

从参考视频到原创故事：镜头分析、角色设计、3D 分镜预演与 AI 视频创作工作台。

上传参考视频，提取剧情、镜头和动作；保留剧情或改写故事，调整对白语言与角色性别、物种和形象；生成本机 3D 预演，逐镜编辑、复制提示词或调用用户配置的模型 API。

## 当前能力

- Gemini 视频分析与结构化 DNA 校验。
- 故事改写、对白语言选择、可编辑角色设计和参考图生成。
- 本机 Blender 3D 预演、分镜裁切与参考视频下载。
- 分镜提示词编辑、复制、字符数检查和角色图 ZIP 下载。
- Supabase 登录/注册、来源归因、项目与个人 Key 隔离。
- Windows 渲染助手：自动准备官方 Blender、校验、测试渲染、取消与离线导入。

这是首版测试项目。在线入口：[jinggan.3yuedaohang.com](https://jinggan.3yuedaohang.com)。云端基础访问与账号边界已验证，真实模型生成和不同电脑环境仍需验收。API 视频提交目前携带角色图与提示词，**不自动上传 3D 视频**；手动全能参考流程需自行上传 3D 视频并绑定素材。

云端部署步骤与功能边界见 [Cloudflare 部署说明](docs/cloudflare-deployment.md)。云端 3D 渲染依赖本机助手，安装包发布仍受对应源码与许可材料准备进度限制。

## 本地运行

需要 Node.js **22.13 或以上**、npm。Windows 助手首版仅支持 x64。

```powershell
git clone https://github.com/Teminuosi/JingGan.git
cd JingGan
npm ci
Copy-Item .env.example .env.local
# 编辑 .env.local，配置 Supabase 公开客户端参数
npm run dev
```

通常打开 `http://localhost:3000`。登录默认启用，缺少认证配置时不放行。Supabase 需要邮箱登录和博客兼容的 profiles.is_banned 查询权限，详见 [账号配置](docs/account-login.md)。禁止使用 service_role。

登录后进入 **头像 → AI 服务设置**，自行注册、充值并创建中转 Key，再粘贴到对应模型设置并拉取、选择模型。默认 API 地址 https://heyroute.ai/v1。获取 Key 的推广入口默认折叠：<https://heyroute.ai/r/c/ch_stz5wyswlv>。镜感账号与中转账号独立。

Key 明文保存在当前浏览器并按账号隔离，不纳入仓库；模型调用可能收费。断连先检查服务商记录与缓存，项目不会自动重复提交付费请求。

## 3D 渲染助手

模型调用使用云端 API，Blender 渲染在本机执行。助手包含 Node、FFmpeg/FFprobe，用户无需自行配置环境。

根目录 `npm run helper:build` 生成 Windows 轻量 ZIP；`npm run helper:build:offline` 生成带 Blender 的离线 ZIP，需要设置已验证 Blender 4.5 的 BLENDER_PATH。打包需要本机 FFmpeg/FFprobe。解压后双击“启动镜感助手.bat”，一键准备环境，再返回网页检查助手。云端网址需在助手页显式批准。

详见 [助手说明](docs/render-helper.md)。安装包应放 GitHub Release，不提交源码仓库。目前本机验收包的第三方对应源码和许可证仍需核对后公开分发。

## 检查

```powershell
npm test
npm run test:helper
npx tsc --noEmit
npm run lint
npm run build
```

测试默认使用模拟模型，不代表真实服务或所有电脑已验证。`node scripts/test-auto-previs.mjs --render` 使用本机 Blender/FFmpeg 实际渲染，模型仍为替身。

## 结构与部署

- app/：工作台、认证、项目与模型 API。
- worker/previs/：本机渲染服务、环境管理和 Blender 脚本。
- worker/：生成任务编排。
- db/、drizzle/：D1 结构与迁移。
- scripts/：启动、验证和助手打包。

网站使用 Vinext/Vite、Cloudflare D1/R2。开发默认使用通用 hosting.config.json，不要求私有 .openai 配置。生产需配置存储、认证、域名、下载地址与邮件返回地址；构建成功不代表已部署。Blender 助手不运行在 Cloudflare Worker 中。

## 许可

项目源码使用 [MIT](LICENSE)。依赖和运行库适用各自许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。仓库不包含个人视频、生成图片、浏览器 Key、数据库、生产凭据和内部记录。请使用自己拥有或已获授权的素材。

### Windows 在线渲染助手

下载 [在线助手安装包](https://github.com/Teminuosi/JingGan/releases/download/v0.1.1-online/mirror-render-helper-windows-x64-online.zip)，解压并双击“启动镜感助手.bat”。首次联网下载并校验 FFmpeg（约 99MB），在助手设置中一键准备 Blender（约 400MB），授权镜感网址后返回网页点击“检查助手”。不必手动安装 Node 或 FFmpeg。需 Windows x64、联网与至少 3GB 空闲空间；原有 Blender 安装不受影响。
