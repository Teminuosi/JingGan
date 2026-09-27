# Blender MCP 单镜头复核

2026-09-18：已接通真实 Blender 5.2.1 与上游 MCP，不替换 Gemini 分析、任务队列或离线渲染器。

## 分工与边界

- Gemini 负责分析原片，原始分析保留为证据；Shot DNA 是可修正的执行数据。
- 上游 `ahujasid/mcp-for-blender` 提供场景检查、执行 Python、保存场景等工具，不提供自动高质量视频重建算法。
- 本项目增加单镜头工作目录、原片截取、不可覆盖的渲染版本、复核记录及事务登记。
- 大渲染仍使用现有离线 Blender → PNG → FFmpeg，避免 MCP socket 长等待。
- 当前是开发者 CLI；尚无面向用户的一键自动迭代 UI，也未验证付费视频生成效果。

上游本地位置：`F:\claude-project\视频复刻\mcp-for-blender`，版本 `6f992ffbca3cb715d111fc640b737b808632273c`，MIT。先在该目录执行 `uv sync --frozen`。Blender 需要 GUI 事件循环，CLI 启动独立隐藏进程并隔离配置，不接管用户已有窗口。遥测已关闭。

## 使用

在本项目目录执行，`S` 表示 prepare 输出的 session.json 路径：

```powershell
npm run blender:review -- prepare --shot SHOT_ID --repo 'F:\claude-project\视频复刻\mcp-for-blender' --source '原视频.mp4' --port 9879
npm run blender:review -- start --session S
npm run blender:review -- reference --session S
npm run blender:review -- load --session S
npm run blender:review -- inspect --session S
npm run blender:review -- apply --session S --code '可信场景修正.py'
npm run blender:review -- snapshot --session S --frame 1
npm run blender:review -- render --session S --version v1
# 对照原片完整复看、记录问题、修改、重新渲染、完整复看。
npm run blender:review -- publish --session S --version v1 --review '复核记录.json'
npm run blender:review -- stop --session S
```

`prepare --db` 可显式指定数据库，默认读取本地 Wrangler D1 数据库。不要在远端环境套用本机绝对路径。`apply` 会执行完整 Blender Python，只接受本地可信脚本。

`publish` 检查视频 SHA256、复核结果、输入数据指纹、连续帧数产生的完成记录与文件大小；事务中再次核对当前版本。可通过 `executionCorrections` 修正 camera、actors、objects、environment、action_timeline、expression_timeline、summary，必须写 evidence，不能改源片时间范围或增删角色。登记后 revision 增加，原始 Gemini 分析不改。相同 revision 的人工复核预演不会被模板预演覆盖。编辑镜头后应重新准备与复核。

复核布尔值是审核人的声明，程序不能替人证明画面正确。源片路径、修改前 dna.json、执行过的 Python、scene.blend、复核依据和视频哈希保存在会话与资产记录中。备份数据库后再做实际登记。

## 本次样片

- 项目 `pl_cd18d765-c481-495b-8af6-f0b06e4b07ca`，第 3 镜 `...-s2`，26.4–29.6 秒。
- 源视频：`C:\Users\Administrator\Desktop\Often\AI短剧提示词\fuke gougou\7580c6b68cea822d04fecc084ef714ba_raw.mp4`。
- 会话：`.worker/objects/blender-review/pl_cd18d765-c481-495b-8af6-f0b06e4b07ca-s2/bda8e71d-0b1b-4594-8075-1349420de015/`。
- `comparison.html` 同步查看原片、旧灰模、新空间预演；`reference-v2/review.json` 记录复核与执行数据修正。
- 原片 96 帧、v1 和 v2 各 77 帧均按时间顺序逐帧检查，v1 的转身过早、直臂挥动已修改后重渲。不是实时音视频播放验收；本次静音空间预演不代表最终成片验收。
- v2 已登记为该镜头优先预演；保留旧资产。程序化动物代理只验证比例、空间和粗动作，步态细节、真实外貌、材质与音轨不在本次成果内。
- 本次没有重新调用 Gemini，也没有调用付费视频接口。

## 修复与验证

1. 英文朝向（away_from_camera 等）能正确转换。
2. 全片预演不再把 60.2 秒整片运镜描述写进每一镜；按镜保存，并保留已复核的同版描述。
3. 下游使用最新的本镜预演，不误取其他镜头。
4. 原片复核纠正开头 D 左前景、A 右前景、转身离开与挥手时间，移除错投到表情栏的动作。

`node scripts/test-blender-review.mjs` 覆盖朝向、分镜描述、已复核版本保护、最新预演选择和修正边界。
`node scripts/test-blender-publish.mjs SESSION REVIEW` 对数据库副本验证复核/哈希拦截、事务登记、执行修正及过期拒绝；真实登记前已通过。真实登记后检查原始分析未变化、项目 16 个本地资产路径可访问。

## 测试清理事故记录

第一次运行原有 smoke-worker 时，其递归删除 `.worker` 的代码误删旧全片预演目录和部分测试会话。数据库未丢失；六段旧分镜预演保留下来并备份。全片 MP4 已由保留片段重建并裁到 1445 帧，布局图重渲，非逐字节恢复；旧 PNG 缓存未恢复。备份与恢复脚本在 `.backup/mcp-integration-20260918/`。smoke-worker 已改用系统临时目录，隔离后通过。
