# 用参考制作完整动画

这条入口面向已完成口播、旁白与真实字幕对齐的 Harness 任务，也支持为已交付视频制作新版画面。客户的 Obsidian 仓库保存其参考目录，工作台按本次实际选择保存原文、静帧和来源校验值。

## 连接

使用现有 `--animate-run <已授权任务 ID>`。将 MCP 服务的 `toolCallTimeoutMs` 设为 `1320000`。依赖由 `npm ci --prefix engine --omit=dev --ignore-scripts` 安装。FFmpeg、FFprobe 需在 PATH 内，可通过 `STUDIO_REMOTION_BROWSER` 指定本机 Chrome 或 Chromium 的绝对路径。

参考页放在 `02 写稿与制作/动画参考/代码动画画风库`。系列文件名用 `M.md` 或 `A-G.md` 一类的系列缩写，条目保留编号、名称、类别、固定版本的原提示词链接和可用静帧链接。格式为 `- **编号 名称** · 类别 · [原提示词](固定版本文件链接) · [参考静帧](固定版本文件链接)`。静帧可省略。项目不会内置客户 Notion ID 或参考媒体。

## 交给 Harness

用 `scene_project_inputs` 读取原稿与真实时间轴。Harness 浏览 `scene_style_catalog`，用 `scene_style_read` 实际读取候选原文和静帧，按题材决定画法。它用 `scene_project_plan` 保存本片设计，再用 `scene_project_next` 逐段交给同一 ACP 作者。每段不超过 900 帧。收到全部源码后，`scene_project_preview` 一次渲染连续画面。缺少完整响应时停在该段，已有完整响应可用 `scene_project_recover` 本地恢复。

本片设计须说明实际参考的主要色块、主体和背景的关系，以及要保留的构图与运动做法。确需适配题材或竖屏时，记录改动及理由。同一作者的每段工作单都收到已选静帧和这份决定。抽看预览时，对照原静帧说明实际保留和改变的部分。

场景运行能力参考原视频平台 `remotion-scene-compiler.ts` 的 script-direct 方式。允许受限的场景级 TSX、原生 HTML/SVG 和声明式 Three.js。角色、构图、材质和动作由作者决定。口播及字幕以原文件为准。原项目的历史适配器、客户素材和运行目录留在来源项目。

`scene_project_frames` 返回当前整片的实际关键画面。新片的渲染结果进入原画面工作单，后续沿原混音、审看和交付流程。已交付视频的新版可通过 `scene_project_export` 本地导出，保存在原任务的 `scene-project` 目录。记录实际查看的范围，技术解码和抽帧各按实际证据描述。
