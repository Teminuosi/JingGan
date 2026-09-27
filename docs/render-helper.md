## 公开在线包

Windows x64 用户下载在线助手 ZIP，解压并双击启动 BAT。包约 39MB，首次启动从 Gyan 官方下载并校验 FFmpeg（约 99MB），随后在助手设置中一键准备官方 Blender（约 400MB）。需联网和至少 3GB 空闲空间；下载失败可再次启动，不会调用模型。程序监听本机 43128，首次需授权镜感网址。运行库存入 `%LOCALAPPDATA%\MirrorRenderHelper`，不覆盖系统安装。

构建：`node scripts/build-render-helper.mjs --online`。以下捆绑全量/离线包说明属于未公开的旧草稿方案。

# Windows 本机渲染助手

## 使用

预演页下载 Windows 助手 ZIP，解压到可写目录，双击 `启动镜感助手.bat`。打开的本机页面会检查兼容的 Blender 4.5；没有时点“一键准备”，从官方固定地址下载 4.5.3 x64 便携包，经 SHA256 校验、解压、一帧真实渲染后才就绪。原有系统 Blender 不覆盖。

下载受阻可在本机设置页选择官方 4.5.3 x64 ZIP 导入，仍执行相同校验和测试。已有离线完整包时，助手直接验证包内 Blender，不需要再下载。网络和磁盘错误可重试，取消不会自动调用模型。

云端网站首次使用，在本机设置页填写工作台 HTTPS 网址并点击允许；不使用通配 CORS。浏览器可能要求本地网络访问权限，拒绝后网页无法连助手，仍可跳过预演。当前版本保留 HTTP loopback + Origin 白名单 + 原有任务票据；不是远端账号服务。网站授权后具备本机预演操作权限，只批准可信工作台。

助手监听 `127.0.0.1:43128`，不得改为公网监听。环境、授权域名和作品放在 `%LOCALAPPDATA%\MirrorRenderHelper`，程序包里不存项目和 Key。预演沿用现有本机服务的模型编排；分析 JSON 发给文本模型，原片本机处理。没有执行收费生成。

## 打包与发布

项目根目录 `npm run helper:build` 生成 `public/downloads/mirror-render-helper-windows-x64.zip`；带 Node、FFmpeg、FFprobe，无需用户安装它们。打包采用明确文件清单，不打包 `.env`、浏览器 Key、数据库、原片或真实作品。

`npm run helper:build:offline` 生成离线 ZIP，需要显式设置 `BLENDER_PATH` 指向已测试的 Blender 4.5 可执行文件。打包前真实测试该版本再复制整个目录；不能只复制 blender.exe。`FFMPEG_PATH`/`FFPROBE_PATH` 可指定打包运行库，默认从本机 PATH 找。目录与 ZIP 都含运行库版本和许可证记录。

当前 ZIP 是本地验收构建。公开 GitHub Release 分发前，须核对实际 Node、FFmpeg、Blender 及 FFmpeg 构建依赖的许可证和对应源码提供方式，补齐完整第三方通知。不能仅凭根目录 MIT 就声称这些运行库也归 MIT。ZIP 不纳入 Git；适合上传 Release，而非提交大型二进制到源码库。当前下载入口使用 `/downloads/...zip`；云端发布时需提供该文件或把入口改到实际 Release/CDN 地址。没有发布或部署。

可沿用现有源项目 Node 启动方式；首版助手仅 Windows x64，不宣称支持 macOS、Linux、ARM64。

## 验证

- `npm run test:helper`：模拟下载/哈希/渲染失败、取消、离线导入、来源与设置 token、授权持久化、PNA 预检；不连真实模型。
- `node scripts/test-auto-previs.mjs`：原预演回归；真实 Blender 部分按原脚本环境开关执行。
- `npx tsc --noEmit`、`npm run lint`、`npm run build`：类型、静态检查、构建。

真实下载、渲染和成品启动的本轮结果记录在 `docs/superpowers/plans/2026-09-26-render-helper.md`，不把模拟测试当成真机验收。
