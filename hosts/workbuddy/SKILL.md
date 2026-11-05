---
name: ai-production-studio
display_name: AI 生产工作台
display_name_en: AI Production Studio
description: 初始化独立 Obsidian 知识库，按阶段生产、续跑视频口播，并把反馈写回所属节点。
description_zh: 用客户自己的 Obsidian 知识库完成视频口播的选题、研究、创作与反馈。
description_en: Produce video narration from a customer-owned Obsidian vault and record feedback.
version: 0.2.0
author: AI Production Studio
---

# AI 生产工作台

先读取本技能目录内的 `references/usage.md`。使用同目录的 `scripts/studio.mjs`，执行 `node "<技能目录>/scripts/studio.mjs" --help`。必须使用客户明确选中的工作区绝对路径，工作区同时是客户的 Obsidian Vault。

DeepSeek Harness 已连接 `studio` MCP 时，先调用 `workspace_info` 核对客户和模式。通过 MCP 的 `run_status`、`run_next`、`stage_submit`、`narration_export` 和 `feedback_write` 执行下述步骤。MCP 参数直接接收 Markdown，`author_recover` 只恢复已保存的 Gemini 响应。

操作者为一个任务开启真实调用后，`author_generate` 执行该任务的初稿和表达编辑。工作区提供 `tts_local` 时，用它配音，传入最终润色稿 SHA 和按语义切分且逐字保留的正文。无本机音色的工作区可在授权后用 `tts_test` 并传入最终润色稿 SHA。拿到真实 WAV 后，沿同一个 run ID 的 `production_next` 工作单继续对齐、画面、混音、预览、审看、交付和反馈。

Harness 的参考驱动正片入口是 `scene_project_*`。对齐后按本片题材查 `scene_style_catalog`，实际用 `scene_style_read` 读取候选原文和可用静帧，再冻结整片画法和分段。同一作者接续各段源码，齐备后统一 Remotion 渲染并进入原制作流程。已交付视频的画面新版沿独立导出入口保留原片。

- 新任务前检查是否已有用户指定的 run。继续任务用 `status` 和 `next`，保留同一个 ID。每阶段实际读 `next` 返回的正文、采纳反馈和上游产物。
- 对选题、研究、方向负责；实际查阅材料并在研究稿中保留可查来源，不猜测证据、不让后续作者补研究。用 `submit` 提交 Markdown、当前工作单 SHA 和实际来源说明。
- 初稿、表达编辑只能交给登记 Gemini，不能由宿主默认模型代写。客户明确授权使用自己的 Gemini 账号并完成配置后，才用 `author --allow-network true`。结果不明即停；如果已取得响应，可以用同一阶段参数不带网络许可恢复本地落盘。调用与报告分开。
- 用 `export` 取得口播稿和 SHA；此版本停在待配音。用 `media-check` 检查已有成片的技术状态，不把技术通过当作视听接受。
- 客户反馈先核对产物与用户的原话，再定位已消费的知识节点。仅在客户明确采纳后传入 `--adopted-file`。必须确认返回 `local_readback_verified` 并回报 Obsidian 笔记位置。
- `fixture` 只用于显式离线测试，不允许调用 Gemini。不要把夹具当客户作品。
