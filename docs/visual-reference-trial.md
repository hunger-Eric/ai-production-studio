# 在 Harness 中做一段参考试片

试片复用已交付的 Harness 视频的一段。原片需要保留分段计划、本机旁白、逐字对齐的字幕和预览。Harness 选段和参考，动画作者据此创作，Remotion 渲染画面，FFmpeg 合成原旁白与字幕。新旧片段保存在同一任务的独立试做目录。

1. 在 Obsidian 仓库中创建 `02 写稿与制作/动画参考`。可把 [三份画法示例](../knowledge/visual-references/) 复制进去，也可添加自己的 Markdown 笔记。已有同名笔记时保留现有内容。
2. 更新源码后运行 `npm ci --prefix engine --omit=dev --ignore-scripts`。沿用已配置的 Harness ACP 作者及 FFmpeg、FFprobe。可在 MCP 服务的 `env` 中设置 `STUDIO_REMOTION_BROWSER`，值为 Chrome 或 Chromium 的绝对路径。
3. 在本次 Harness MCP 连接的 `args` 末尾加入两个参数 `--visual-trial-run` 和已授权的原任务 ID。将该连接的 `toolCallTimeoutMs` 设为 `1320000`，给作者和本机渲染留出时间。
4. 在 Harness 中说「从 Obsidian 选参考，用这条视频的一段试做新版画面，保留稿子、旁白和字幕，交付新旧两个 MP4」。Harness 可通过 `visual_trial_inputs` 和 `visual_trial_generate` 读取素材并提交选段、参考和本段画法。

结果位于原任务的 `visual-reference-trial`，包含 `reference-preview.mp4`、`original-excerpt.mp4` 和 `receipt.json`。这条入口用于单段验证。

中断时优先调用 `visual_trial_recover`，从已保存的作者响应重新渲染。没有完整响应时，只有明确获得一次重试授权后才在本次 MCP 连接加上 `--visual-trial-retry-dispatch` 和原 `dispatch.json` 的外层 `sha256`。此时 `visual_trial_retry` 沿原选段、参考及画法继续，恢复已有响应或派发一次。
