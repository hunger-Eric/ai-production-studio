# AI生产工作台

面向客户独立安装的本地视频生产工作台。客户的知识库是自己的 Obsidian Vault。DeepSeek Harness、WorkBuddy 和 Codex 共用同一套工作台程序，产品方法和客户数据分开。

当前本地开发版提供独立客户文件区和本地成片制作链。原项目的动画作者派发适配到 DeepSeek Harness ACP，声音阶段接入本机 Earshot/Cinetic，平台侧接入抖音和 B 站本地提交准备。已有虚构客户样片验证字幕对齐、本地交付和反馈。最新虚构任务完成了真实文稿、配音和对齐，Harness 作者会话未返回动画。Earshot 和提交前准备使用另一个既有样片独立验收。

## 在自己的电脑上部署

从 GitHub 下载源码 ZIP 或克隆本仓库。Windows 安装 PowerShell 7、Node.js 22 或更新的 LTS。解压后在源码根目录执行：

```powershell
pwsh -File setup/install.ps1 -Workspace "$env:USERPROFILE/Documents/MyStudio" -Customer "我的工作台"
```

脚本安装锁定的 Node 依赖，创建独立工作区并生成本地 MCP 配置。首次安装无需 Gemini 密钥、Whisper 权重或开发者资料。用 Obsidian 打开返回的工作区目录并填写「工作台首页」。使用 DeepSeek Harness 时加载返回的 MCP 配置。CLI 也可以直接使用。详见[安装与使用](hosts/workbuddy/usage.md)。

| 想做什么 | 需要自己的配置 |
| --- | --- |
| 建知识库、创建任务、取工作单、续跑和写反馈 | 自己的 Obsidian 工作区与正文 |
| 让 Gemini 写稿或配音 | 有相应模型访问权限的 Gemini API 密钥及指定任务授权 |
| 本机克隆音色和字幕对齐 | 本机语音模型与本人参考录音、FFmpeg、Whisper 与本地权重 |
| 自动动画、原生混音、平台提交前准备 | 分别配置 Harness ACP、Earshot/Cinetic 和本地上传器依赖 |

macOS 用户可按[手动安装说明](hosts/workbuddy/usage.md#macos-手动安装)，自行安装 Node.js、创建 Obsidian 工作区并配置本地 MCP。macOS 的安装命令与 MCP 配置已在隔离环境核对，仍待 Mac 实机验证。

全链制作依赖以上运行时。本机克隆音色当前需要 CUDA BF16，macOS 可使用 Gemini 配音入口。

```text
engine/          正文冻结、工作单、模型派发、续跑、反馈和媒体技术检查
knowledge/       通用生产方法及附许可证的表达编辑技能
hosts/workbuddy/ WorkBuddy 技能与操作说明，Codex 也可复用同一 CLI
setup/           自助安装、连接配置及独立 ZIP 构建
tests/           离线跨进程验收
docs/            计划、来源登记和执行边界
```

- [执行图与实际依赖](docs/EXECUTION.md)
- [产品计划](docs/PRODUCT_PLAN.md)
- [来源基线](docs/source-baseline.json)
- [本项目协作约定](AGENTS.md)

来源视频项目与工作台独立。每个工作区使用自己的账号、知识和作品。

## 开源许可

工作台原创代码采用 [MIT](LICENSE)。随源码或安装包分发的第三方材料保留各自的许可和署名，见[第三方许可说明](THIRD_PARTY_NOTICES.md)。
