# 自动预演：两次调用版本

2026-09-18 按用户要求替换逐镜编排、审核、重试链路。

1. 网页把完整原视频交给 Gemini，一次生成完整 DNA。
2. 本地预演服务仅发送完整 DNA 与整片编排规则，一次返回所有镜头的紧凑动画计划；本次请求没有视频附件。
3. 本地展开共享角色、道具、姿态与稀疏关键帧，检查全部镜头是否合法，再由 Blender 逐镜渲染并拼接。

新视频成功完成全流程共 2 次模型生成调用；已有 DNA 的项目只需新增 1 次。不自动逐镜审核、不自动补写、不自动重试、不因镜头数量增加调用。中转内部是否重试不是本项目可控制的计数。失败、截断或遗漏镜头会保存诊断并停止；重新点击生成是用户主动发起的新调用。

## 文件与运行

- `worker/previs/batch.mjs`：`motion-batch.v1` 的提示词与本地展开器。模型输出全片共享角色/道具/完整姿态定义，各镜头只写变化字段。没有固定动作模板，不自动补静态占位镜头。
- `worker/previs/engine.mjs`：仅一次文本编排；全部计划先校验，之后本地逐镜渲染/拼接。保存 DNA、编排提示词/原始响应、校验结果、展开的每镜计划、Blender 场景和视频。
- `worker/previs/server.mjs`：本地服务版本 `automatic-previs.v2`；原视频仅保存在本机以核对时长、画幅及保留参考，不传给第二次模型调用。Key 仅驻留内存，不写入任务文件。后台一次运行一个任务。
- `app/components/AutoPrevisPanel.tsx`：显示新增一次编排费用、渲染进度、全片播放、本地检查报告。新版前端拒绝连接旧版服务，防止仍执行原来的多次调用。
- 网站默认勾选自动预演，文案明确视频分析 1 次＋DNA 编排 1 次。已有项目在参考 DNA 页单独启动即可，无须重新分析视频。
- Blender 本地检查不能证明视频语义或动作精度。完成状态是 `rendered_unreviewed`；有数值问题时是 `needs_review`。`modelComparisonPerformed`、`modelComparisonPassed`、`watchedEntireClip` 均为 false，不冒充视觉通过。

启动：桌面 BAT，或 `npm run dev`；已有站点时也可 `npm run previs:server`。

本地预演边界：原片 ≤512 MiB、≤10 分钟、≤150 镜。这是本应用处理边界，不是中转上传上限；一次编排还受模型输出长度限制，不能保证这些边界内所有视频都能编排成功。渲染器使用关节代理和组合几何体，未提供完整布料/流体/粒子/精细手指系统。

## 上传与分析参数来源

- inlineData、Files、FPS、mediaResolution 来自 Gemini 原生接口设计；“2 FPS＋High”和逐字转写开关是项目默认值/提示词设置，不是 HeyRoute 规定。
- 用户的 24.2 MB、95.6 秒原视频已真实分析成功。HeyRoute 当前公开文档未明确 Gemini 视频原片上限，未描述 Files 上传协议；历史 Files 接口测试未跑通。
- HeyRoute 排障文档写 Cloudflare 单次请求体入口限制 100 MB，示例为 Codex。base64 增加约三分之一体积，若该入口限制适用于视频请求，则单文件理论上需小于约75 MB并预留JSON/提示词开销；这是推算，不能保证 Gemini 上游接受。未据此新增视频硬拦截。
- 已移除 16 MB 本地拦截；原本 1.9 GiB 的浏览器读取保护仍在，已明确标为本地保护而非 Gemini 官方上限。
- FPS/解析参数是否被具体中转模型执行尚未确认。历史记录对透传结论矛盾，token 差异不足以证明采样帧数；界面与 DNA 不确定性提示已纠正。用量按请求设置和官方静态处理规则估算，不是账单或实际帧数。
- 来源：https://heyroute.ai/help?collection=connect-clients&page=gemini-setup 、https://heyroute.ai/help?collection=troubleshooting&page=request-size-rate-service 、https://ai.google.dev/gemini-api/docs/video-understanding 。HeyRoute 文档正文从其官网公开 HelpDocs 静态包读取。

## 验证

- 单镜/多镜只调用一次编排、第二次请求无视频、稀疏关节正确继承、未知姿态/缺镜/输出截断停止且不重试均已通过测试。
- 真实 Blender 与 FFmpeg 的2秒测试，以及真实 HTTP 上传→一次文本编排→渲染→合并→鉴权 Range 播放通过；模型响应是测试替身，没有付费调用。
- 未用真实 Gemini 验证新全片编排提示词，也未完成新片精度评测或正常速度整片复看；不能宣称同等视觉精度已验证。
## 2026-09-18 用户后续简化要求

去掉“视频传输与分析参数”整个手动设置区，以及参数总览中的采样、解析精度、转写行。上传页只显示模型、预计用量和源片时长，不解释 FPS/解析参数。程序统一使用现有默认值：inline、请求2 FPS＋High、默认逐字转写；旧手动值不再作为隐藏覆盖，模型/API凭证不变。此要求优先于历史的“全部参数可调”。