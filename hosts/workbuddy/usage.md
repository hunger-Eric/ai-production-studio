# 安装与使用

1. 客户安装 Node.js 22 或更新的 LTS。使用 DeepSeek Harness 时，将解包后的 `ai-production-studio` 文件夹放入客户工作区的 `.dsh/skills/`，在 Harness 中打开该工作区并选择 `ai-production-studio` 技能。使用 WorkBuddy 时，通过技能上传入口导入 `ai-production-studio.zip`。Codex 可用同一脚本入口。
2. 客户选择一个专用本地目录。运行初始化，然后在 Obsidian 选择「打开文件夹作为仓库」，选同一目录并打开「工作台首页」。只填写各节点自己的 Markdown 正文；不要移动和重命名节点文件。企业及真实能力必填，其他节点按需填。存放 Vault 的卷须支持同卷文件硬链接（Windows 推荐本地 NTFS）。不同客户使用不同 Vault；共享电脑上的账户和权限由操作系统配置。
3. 以客户自己的方式配置 Gemini API 密钥，确保宿主调用的进程能读到 `GEMINI_API_KEY`。不要放入 Vault、提示词、命令行、生产工件或源代码。每次向 Gemini 提交阶段资料前，遵循客户的授权和预算。口播初稿及编辑使用同一模型。
4. 把 `studio` 替换成 `node "<技能目录>/scripts/studio.mjs"`。参数使用客户确认的绝对路径。以下命令中的 ID 和 SHA 使用上一命令的实际值：

```text
studio init --workspace "<客户Vault>" --customer "<客户名称>" --mode production
studio start --workspace "<客户Vault>" --brief "<任务需求.md>"
studio next --workspace "<客户Vault>" --run "<ID>"
studio submit --workspace "<客户Vault>" --run "<ID>" --stage topic --task-sha "<工作单SHA>" --file "<选题正文.md>" --origin "<宿主和来源说明>"
studio status --workspace "<客户Vault>" --run "<ID>"
studio author --workspace "<客户Vault>" --run "<ID>" --stage draft --task-sha "<工作单SHA>" --allow-network true
studio export --workspace "<客户Vault>" --run "<ID>"
studio feedback --workspace "<客户Vault>" --run "<ID>" --stage edit --node narration --result-sha "<阶段结果SHA>" --feedback-id "<同一反馈固定ID>" --file "<原反馈.md>" --adopted-file "<客户明确采纳的要求.md>"
```

按 `next` 顺序完成 topic、research、direction、draft、edit。每阶段重新取 SHA，结束时状态为 `needs_tts`。重开宿主后用同一 run ID。客户没采纳反馈时省略 `--adopted-file`。采纳项会跟随对应知识节点进入新任务，既有任务仍使用原冻结版本。

本版不会创建远程知识库、连接账号、上传视频或生成成片。已有成片可用 `studio media-check --file "<成片.mp4>"` 做技术检查，需另装 FFmpeg（含 ffprobe）。

## 在 DeepSeek Harness 中使用本地 MCP

1. 按上文初始化客户的 Obsidian 仓库。进入解包后的技能目录，执行 `npm ci --prefix scripts/engine --omit=dev --ignore-scripts`。
2. 复制 `references/studio.cordis.yml`，将脚本和仓库两处路径改成自己的绝对路径。一个连接固定绑定一个仓库。请在这个客户的专用 Harness 实例中加载该配置。
3. 在客户仓库目录执行 `dsh web --patch "<配置文件绝对路径>"`。在有 MCP 设置的桌面版本中，也可添加同样的本地 stdio 配置，命令填 `node`，参数依次填 MCP 脚本绝对路径、`--workspace`、仓库绝对路径。先调用 `mcp__studio__workspace_info` 核对客户和模式。
4. 续跑时把已有 run ID 交给 `run_status` 和 `run_next`。写反馈用 `feedback_write`，从结果里取得 Obsidian 笔记路径。已保存的 Gemini 响应用 `author_recover` 继续落盘。
5. 需要让 MCP 发起真实 Gemini 调用时，操作者在服务启动参数加上 `--authorize-run <已有的正式 run ID>`，并向 MCP 进程提供 `GEMINI_API_KEY`。这样才会出现 `author_generate`，无本机音色时也会出现短口播的 `tts_test`。这两个工具只用于指定任务。
6. 正式工作区配置 `.dsh/local-voice-profile.json` 后，重新连接会提供 `tts_local` 和 `local_voice_render`。前者绑定冻结稿和 run ID，后者给既有成片生成旁白分段。音色配置引用本机 CUDA Python、模型目录、本人参考录音和逐字稿，跟随个人工作区存放。音色素材和配置不随通用安装包分发。
6. 制作环节需要 FFmpeg、FFprobe、Python 和本机 Whisper 权重。MCP 进程使用 `STUDIO_WHISPER_MODEL_PATH` 读取权重绝对路径。沿同一个 run ID 读取 `production_next`，依次对齐字幕、登记画面、混音、预览、审看和交付。素材放入当前任务返回的 `inputs` 目录。画面交接要求无声 1080×1920、30fps，每段最多 30 秒。音乐和音效交接使用按整条口播时间轴编排的独立分轨及使用许可。正式审看由负责人记录，技术样片用 `technical_validation`。交付工具生成 MP4、封面与说明，制作反馈写回当前阶段所读节点。
7. 自动动画作者运行在 DeepSeek Harness ACP。连接参数加 `--animate-run <已授权的任务 ID>` 后，先用 `animation_plan` 冻结连续帧范围，再用 `animation_dispatch` 派发当前段。后续段续接同一 Harness 会话。作者只回传结构化画面数据，工作台在本机渲染。最后用 `animation_commit` 统一合成粗剪。派发结果不明时保留原会话和回执，不自动重发。
8. 审看粗剪后，用 `earshot_candidates` 生成实际候选、试听页和本地比较结果，由负责人选择。将候选报告 SHA、选择依据和动作帧交给 `earshot_mix`，再把原生混音回执交给制作声音阶段。需安装与项目锁文件一致的 Earshot、Cinetic 和本地模型缓存。
9. `publication_prepare` 绑定已经交付的成片与当前发布文案，生成抖音或 B 站的本地提交包。它会实际检查上传器参数和成片清理前后的解码帧，停止在账号检查和提交前。
