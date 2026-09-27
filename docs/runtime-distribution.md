# 当前公开方案：Windows 在线助手 1.0.1

仅含镜感代码和已核对的 Node.js 26.7.0，Node 完整许可证随包保留、官方对应源码随 Release 提供。FFmpeg/FFprobe 首次启动直接从 Gyan 官方 GitHub Release 下载固定版本 essentials ZIP（2025-07-31-git-119d127d05），核验 GitHub 提供的 SHA256 后解压；Blender 仍直接下载官方 4.5.3 便携版。完整上游目录和许可证保留于用户本机，不在在线包中分发这些二进制。

`node scripts/build-render-helper.mjs --online` 构建此包；旧的捆绑全量/离线包继续保持草稿，以下待补材料只针对旧包。

# Windows 助手运行库与源码材料

镜感自身代码按根目录 `LICENSE` 的 MIT 许可证提供。助手通过独立进程调用 Node.js、FFmpeg/FFprobe 和 Blender；这些软件保留自己的版权与许可证，不能统一标为 MIT。

## 本次草稿的准确版本

| 组件 | 版本与来源 | 许可证及包内材料 | 源码材料 |
| --- | --- | --- | --- |
| Node.js | 26.7.0，包内二进制与官方 Windows x64 二进制及校验值一致 | `licenses/Node-LICENSE.txt`，包含 Node 及其第三方通知 | `node-v26.7.0.tar.xz`，官方 SHA256 已核对 |
| FFmpeg / FFprobe | Gyan `2025-07-31-git-119d127d05-full_build` | GPLv3；`licenses/FFmpeg-GPLv3.txt`、`FFmpeg-provider-README.txt`，保留原始配置及外部库版本 | FFmpeg 完整提交 `119d127d05c910db0f0d31c1b124a8d60fd0d75d` 的源码归档；**尚不代表所有静态依赖的完整对应源码** |
| Blender | 官方 4.5.3 Windows x64，未修改 | 离线包原样保留 `blender/copyright.txt` 与整个 `blender/license/`（各组件版权、SPDX 文本等） | 官方 `blender-4.5.3.tar.xz`，官方 MD5 已核对，另计算 SHA256 |

源码归档作为同一 GitHub Release 的附件提供，不放入运行包或源码 Git 历史。用户运行助手无需下载这些源码。归档地址与校验值见 `runtime-sources.json`；运行包及源码附件的校验值见 `SHA256SUMS.txt`。

### 原始来源

- Node 许可证：https://github.com/nodejs/node/blob/v26.7.0/LICENSE
- Node 源码：https://nodejs.org/dist/v26.7.0/node-v26.7.0.tar.xz
- FFmpeg 原始构建：https://github.com/GyanD/codexffmpeg/releases/tag/2025-07-31-git-119d127d05
- FFmpeg 主项目源码：https://github.com/FFmpeg/FFmpeg/commit/119d127d05c910db0f0d31c1b124a8d60fd0d75d
- FFmpeg 许可说明：https://ffmpeg.org/legal.html
- Blender 主项目源码：https://download.blender.org/source/blender-4.5.3.tar.xz
- Blender 4.5 系列依赖源码归档：https://download.blender.org/source/blender-with-libraries-4.5.0.tar.xz

## 公开分发前仍待补齐

1. **FFmpeg 的完整静态依赖源码与构建材料。** 原始 README 列出了大量依赖版本，但 `openal-soft` 只写 `latest`，一些工具链、依赖和本地补丁信息尚未定位。FFmpeg 主项目源码归档不能替代这些材料；不得把 `--enable-gpl --enable-version3` 的静态完整版当作 LGPL 包。
2. **Blender 依赖源码对应关系。** 已逐字比较 4.5.0 和 4.5.3 的 `build_files/build_environment/cmake/versions.cmake`，内容相同；4.5.0 的官方 with-libraries 归档是待核验的依赖来源。仍需取得并核对其中的依赖及构建材料，不把“版本定义相同”直接当作完整对应源码已经交付。

Node 二进制来源核对已完成：包内文件与官方 `win-x64/node.exe` 一致，SHA256 为 `e921fe5307e29bf6fd00000dd594356affd3a7b044e52720c7f10decbdc305b9`。

Release 保持草稿。只有源码材料与实际二进制对应关系核实后，才将状态改为公开；不能仅因存在许可证文件就标注“全部合规”。

## 后续打包

`scripts/build-render-helper.mjs` 从 FFmpeg 二进制所在安装包读取原始 `README.txt` 与 `LICENSE`。自定义位置可设置 `FFMPEG_NOTICES_DIR`。打包器核对 README 的版本是否与实际二进制一致，并拒绝 `--enable-nonfree` 构建。替换运行库时，需要重新整理其来源、许可证、源码、构建材料和校验值，不能继续沿用本次清单。
