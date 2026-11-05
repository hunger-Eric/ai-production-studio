# 安装与使用

## Windows 从源码安装

在 Windows 安装 PowerShell 7、Node.js 22 或更新的 LTS 和 Obsidian。下载源码并解压，在源码根目录运行：

```powershell
pwsh -File setup/install.ps1 -Workspace "$env:USERPROFILE/Documents/MyStudio" -Customer "我的工作台"
```

首次安装需要 npm 下载依赖。使用源码目录之外的专用工作区。脚本返回工作区、CLI 路径和 Harness 配置文件路径。重新执行相同命令会复用工作区身份和已写入的知识笔记。Obsidian 中选「打开文件夹作为仓库」。在有 MCP 支持的 Harness 中加载该配置，或把配置中的 command、args 和 env 填到本地 stdio 服务设置。先调用 workspace_info 核对工作区。

只用 CLI 时可直接运行 `node engine/studio-cli.mjs --help`；下面命令中的 studio 可替换成 `node engine/studio-cli.mjs`。已有本机 Whisper 权重时，运行 `setup/connect-harness.ps1` 并传入 `-Workspace` 和 `-WhisperModel` 生成用于媒体制作的连接配置。每次加载同一工作区的一份配置。

## macOS 手动安装

安装适合本机架构的 Node.js 22 或更新的 LTS 及 Obsidian。下载源码 ZIP 或克隆本仓库，在终端进入解压后的源码根目录。将下面命令的工作区和名称改成自己的：

```sh
node engine/studio-cli.mjs doctor
npm ci --prefix engine --omit=dev --ignore-scripts
node engine/studio-cli.mjs init --workspace "$HOME/Documents/MyStudio" --customer "我的工作台" --mode production
```

在 Obsidian 中选择「打开文件夹作为仓库」，打开工作区里的「工作台首页」。在终端运行 `command -v node` 和 `pwd -P` 取得 Node 和源码目录的绝对路径。支持本地 MCP 的宿主里新增 stdio 服务，名称填 `studio`，命令和参数按以下示例填写：

| 设置 | 示例 |
| --- | --- |
| 命令 | `/opt/homebrew/bin/node`，替换成实际 Node 路径 |
| 第一个参数 | `/Users/me/Projects/ai-production-studio/engine/studio-mcp.mjs` |
| 第二个参数 | `--workspace` |
| 第三个参数 | `/Users/me/Documents/MyStudio` |

参数各自单独填写，即使路径有空格也保持一个参数。先调用 `workspace_info` 核对工作区，然后用 `run_start` 和 `run_next` 开始。DeepSeek Harness 可使用同样的 stdio 参数；通过补丁加载时，可复制源码里的 `hosts/deepseek-harness/studio.cordis.yml`，替换命令和两处路径，基础安装可以删掉示例中的整个 `env` 项。

生成或对齐媒体时，再按需配置：

- 使用有访问权限的 Gemini API 密钥，并按下文授权具体任务。macOS 可用 Gemini 配音；当前本机克隆音色使用 CUDA BF16。
- 安装 FFmpeg（含 ffprobe），让 MCP 进程的 PATH 找得到它们。可在宿主里显式设置 PATH。
- 为 Whisper 对齐和本地动画渲染准备 Python 环境，按需安装 `openai-whisper` 和 `Pillow`。工作台在 macOS 默认调用 `python3`；可在 MCP 环境里用 `STUDIO_MEDIA_PYTHON` 指定自己的虚拟环境解释器绝对路径，如 `/Users/me/.venvs/studio/bin/python`。将本机 Whisper 权重绝对路径填入 `STUDIO_WHISPER_MODEL_PATH`。
- 需要自动动画、Earshot/Cinetic 混音或平台提交前准备时，再配置下文对应的运行时。Mac 实机的完整制作链仍待验证。

## 从技能 ZIP 安装与使用

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

上述 CLI 命令覆盖本地知识库和口播工作流。完整制作工具通过 MCP 使用。已有成片可用 `studio media-check --file "<成片.mp4>"` 做技术检查，需另装 FFmpeg（含 ffprobe）。

## 在 DeepSeek Harness 中使用本地 MCP

1. 按上文初始化客户的 Obsidian 仓库。进入解包后的技能目录，执行 `npm ci --prefix scripts/engine --omit=dev --ignore-scripts`。
2. 复制 `references/studio.cordis.yml`，将脚本和仓库两处路径改成自己的绝对路径。一个连接固定绑定一个仓库。请在这个客户的专用 Harness 实例中加载该配置。
3. 在客户仓库目录执行 `dsh web --patch "<配置文件绝对路径>"`。在有 MCP 设置的桌面版本中，也可添加同样的本地 stdio 配置，命令填 `node`，参数依次填 MCP 脚本绝对路径、`--workspace`、仓库绝对路径。先调用 `mcp__studio__workspace_info` 核对客户和模式。
4. 续跑时把已有 run ID 交给 `run_status` 和 `run_next`。写反馈用 `feedback_write`，从结果里取得 Obsidian 笔记路径。已保存的 Gemini 响应用 `author_recover` 继续落盘。
5. 需要让 MCP 发起真实 Gemini 调用时，操作者在服务启动参数加上 `--authorize-run <已有的正式 run ID>`，并向 MCP 进程提供 `GEMINI_API_KEY`。这样才会出现 `author_generate`，无本机音色时也会出现短口播的 `tts_test`。这两个工具只用于指定任务。
6. 正式工作区配置 `.dsh/local-voice-profile.json` 后，重新连接会提供 `tts_local` 和 `local_voice_render`。前者绑定冻结稿和 run ID，后者给既有成片生成旁白分段。音色配置引用本机 CUDA Python、模型目录、本人参考录音和逐字稿，跟随个人工作区存放。音色素材和配置不随通用安装包分发。
7. 制作环节需要 FFmpeg、FFprobe、Python 和本机 Whisper 权重。MCP 进程使用 `STUDIO_WHISPER_MODEL_PATH` 读取权重绝对路径，可用 `STUDIO_MEDIA_PYTHON` 指定 Whisper 和动画渲染所用的 Python 解释器。沿同一个 run ID 读取 `production_next`，依次对齐字幕、登记画面、混音、预览、审看和交付。素材放入当前任务返回的 `inputs` 目录。画面交接要求无声 1080×1920、30fps，每段最多 30 秒。音乐和音效交接使用按整条口播时间轴编排的独立分轨及使用许可。正式审看由负责人记录，技术样片用 `technical_validation`。交付工具生成 MP4、封面与说明，制作反馈写回当前阶段所读节点。
8. 自动动画作者运行在 DeepSeek Harness ACP。连接参数加 `--animate-run <已授权的任务 ID>` 后，可走 [参考驱动的正片制作](https://github.com/hunger-Eric/ai-production-studio/blob/main/docs/scene-project.md)。较早的动画任务继续使用自己的 `animation_plan`、`animation_dispatch` 和 `animation_commit` 入口。
9. 审看粗剪后，用 `earshot_candidates` 生成实际候选、试听页和本地比较结果，由负责人选择。将候选报告 SHA、选择依据和动作帧交给 `earshot_mix`，再把原生混音回执交给制作声音阶段。需安装与项目锁文件一致的 Earshot、Cinetic 和本地模型缓存。
10. `publication_prepare` 绑定已经交付的成片与当前发布文案，生成抖音或 B 站的本地提交包。它会实际检查上传器参数和成片清理前后的解码帧，停止在账号检查和提交前。

### 用自己的录音配置本机音色

准备支持 CUDA BF16 的 Python 环境，安装 PyTorch、Qwen3-TTS 和 SoundFile，并把 `Qwen3-TTS-12Hz-0.6B-Base` 下载到本机。录制一段干净的独白，写下逐字稿。将下面的内容保存到个人工作区的 `.dsh/local-voice-profile.json`，并替换示例值。文件路径使用绝对路径，Windows JSON 中也可用斜杠。

```json
{
  "id": "my-local-voice",
  "python": "C:/my-tts/.venv/Scripts/python.exe",
  "modelDirectory": "C:/my-tts/Qwen3-TTS-12Hz-0.6B-Base",
  "modelRevision": "<下载快照的40位提交SHA>",
  "reference": "C:/my-tts/my-reference.wav",
  "referenceSha256": "<本人录音的64位小写SHA256>",
  "referenceText": "<本人录音的逐字稿>",
  "weights": {
    "model.safetensors": "<文件的64位小写SHA256>",
    "speech_tokenizer/model.safetensors": "<文件的64位小写SHA256>"
  }
}
```

用 `(Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()` 计算每个文件的 SHA。重新连接正式工作区后，在工具列表中确认出现 `tts_local`。生成需要本地模型和 GPU，字幕还需按上文配置 Whisper。
