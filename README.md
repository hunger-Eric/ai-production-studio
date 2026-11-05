# AI生产工作台

面向客户独立安装的本地视频生产工作台。客户的知识库是自己的 Obsidian Vault。DeepSeek Harness、WorkBuddy 和 Codex 共用同一套工作台程序，产品方法和客户数据分开。

当前本地开发版提供独立客户文件区和本地成片制作链。原项目的动画作者派发适配到 DeepSeek Harness ACP，声音阶段接入本机 Earshot/Cinetic，平台侧接入抖音和 B 站本地提交准备。已有虚构客户样片验证字幕对齐、本地交付和反馈。最新虚构任务完成了真实文稿、配音和对齐，Harness 作者会话未返回动画。Earshot 和提交前准备使用另一个既有样片独立验收。

本机正式文件区位于 `workspaces/AI生产工作台`，技术样片及验收产物位于独立的 `workspaces/验证-青屿仓储`。正式文件区的「工作台首页」链接到完整制作流程。

## 开始使用

- 安装 Node.js 22 或更新的 LTS 和 Obsidian。从本项目运行 `pwsh -File setup/build-workbuddy.ps1`，或取得构建后的 `ai-production-studio.zip`。本地包不包含开发者环境、客户资料或 API 密钥。
- 在 DeepSeek Harness 中打开客户目录。将解包后的技能放进该目录的 `.dsh/skills/`，选中 `ai-production-studio`。初始化后在 Obsidian 将同一目录打开为本地仓库，打开「工作台首页」并填写「企业、受众与品牌」和「真实能力、做法与交付物」。[安装与使用](hosts/workbuddy/usage.md)
- 本地 MCP 使用同一工作台程序。安装锁定依赖，再用项目附带的配置模板将连接绑定到一个已初始化的客户仓库。[MCP 安装步骤](hosts/workbuddy/usage.md#在-deepseek-harness-中使用本地-mcp)
- 成片制作需安装 FFmpeg、FFprobe、Python 与 OpenAI Whisper，并指定已下载的本机权重文件。本机可用 `setup/connect-harness.ps1` 为工作区生成连接配置。
- 已配置本人音色的正式工作区可用本机 CUDA 生成配音，并把实际音轨交给字幕对齐。参考录音和模型配置由该工作区管理。详情见[本地配音配置](hosts/workbuddy/usage.md)。
- 工作台为每阶段读取对应节点的真实 Markdown，按任务冻结。反馈关联当时的产物和节点，在 Obsidian 可以跳转查看；明确采纳的要求进入该节点以后的新任务。

```text
engine/          正文冻结、工作单、模型派发、续跑、反馈和媒体技术检查
knowledge/       通用生产方法及附许可证的表达编辑技能
hosts/workbuddy/ WorkBuddy 技能与操作说明，Codex 也可复用同一 CLI
setup/           独立 ZIP 构建
tests/           离线跨进程验收
docs/            计划、来源登记和执行边界
```

- [执行图与实际依赖](docs/EXECUTION.md)
- [产品计划](docs/PRODUCT_PLAN.md)
- [来源基线](docs/source-baseline.json)
- [本项目协作约定](AGENTS.md)

来源项目 `E:/project/视频平台` 保留独立生产；其运行入口、账号、知识和作品不被产品使用。最终验收仍是在没有开发者环境的机器上，客户安装、配置后能完整制作、续跑并积累自己的反馈。
