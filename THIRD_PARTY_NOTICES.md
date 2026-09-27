# Third-party notices

本项目的方法设计参考了以下开源项目，但没有打包其案例图片、社区来源提示词或网站业务代码。

## video-to-prompt

- Fork: https://github.com/Teminuosi/video-to-prompt
- Upstream: https://github.com/imooooc/video-to-prompt
- Reviewed commit: `a20d7b52ff4302dfd61433f137e1308423ce2daa`
- License: MIT
- Copyright (c) 2026 Jackie Zhu

参考点：浏览器视频上传、Gemini Files API 轮询、可调 FPS 与视频在前/文本在后的请求结构。本项目重写了分析协议、结构化 Schema、角色系统、原创改编层与界面。

## awesome-gpt-image-2

- Fork: https://github.com/Teminuosi/awesome-gpt-image-2
- Upstream: https://github.com/freestylefly/awesome-gpt-image-2
- Reviewed commit: `685469889fb72fd5adefae45e1645d527edcb5e7`
- License: MIT（仓库代码与原创结构）
- Copyright (c) 2026 freestylefly

参考点：Prompt-as-Code、角色设定表、身份锚点、服装材质、连续性前置和负面约束。本项目没有复制仓库的社区案例图或第三方提示词；这些内容的权利仍属于各自作者与平台。

完整许可证文本可在各仓库的 `LICENSE` 中查看。
## Mediabunny

This product uses Mediabunny, Copyright (c) 2026-present Vanilagy and contributors, licensed under the Mozilla Public License 2.0.

License: https://www.mozilla.org/MPL/2.0/
Source: https://github.com/Vanilagy/mediabunny

## Windows 渲染助手运行库

助手安装包另含 Node.js、FFmpeg/FFprobe；离线版还包含 Blender。它们适用各自的许可证，不适用镜感根目录的 MIT 许可证。

- Node.js：保留该版本完整 `LICENSE`，包含其第三方组件通知。
- FFmpeg/FFprobe：本次 Gyan 静态构建使用 GPLv3，保留原始许可证及构建方 README（含外部库版本）。
- Blender：离线包保留官方 `copyright.txt` 与整个 `license/` 目录。

准确版本、源码获取方式、已核对内容及尚待核验的分发事项见 `docs/runtime-distribution.md`（安装包内为 `licenses/runtime-distribution.md`）。存在这些说明不表示待核验事项已经完成。
