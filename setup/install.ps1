#Requires -Version 7.0
param(
  [Parameter(Mandatory)][string]$Workspace,
  [Parameter(Mandatory)][string]$Customer,
  [ValidateSet('production', 'fixture')][string]$Mode = 'production',
  [string]$WhisperModel
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$engine = Join-Path $project 'engine'
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$major = & $node -p 'process.versions.node.split(".")[0]'
if ($LASTEXITCODE -ne 0 -or [int]$major -lt 22) { throw '请安装 Node.js 22 或更新的 LTS 版本。' }
if ($WhisperModel) {
  $WhisperModel = (Resolve-Path -LiteralPath $WhisperModel).Path
  if (-not (Test-Path -LiteralPath $WhisperModel -PathType Leaf)) { throw '请提供本机 Whisper 权重文件。' }
}
$vault = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Workspace)
$checkout = [IO.Path]::GetFullPath($project).TrimEnd([IO.Path]::DirectorySeparatorChar)
$sourcePrefix = $checkout + [IO.Path]::DirectorySeparatorChar
if ($vault.TrimEnd([IO.Path]::DirectorySeparatorChar) -eq $checkout -or
    $vault.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw '请选择源码目录之外的专用工作区。'
}
$npm = (Get-Command npm -CommandType Application | Select-Object -First 1).Source
& $npm ci --prefix $engine --omit=dev --ignore-scripts | Out-Host
if ($LASTEXITCODE -ne 0) { throw '工作台依赖安装失败。' }
$studio = Join-Path $engine 'studio-cli.mjs'
$workspaceInfo = & $node $studio init --workspace $vault --customer $Customer --mode $Mode
if ($LASTEXITCODE -ne 0) { throw '工作区初始化失败。' }
$info = $workspaceInfo | ConvertFrom-Json
$connection = @{ Workspace = $vault }
if ($WhisperModel) { $connection.WhisperModel = $WhisperModel }
$patch = & (Join-Path $PSScriptRoot 'connect-harness.ps1') @connection
[ordered]@{
  workspace = $vault
  workspaceId = $info.workspaceId
  mode = $info.mode
  obsidianHome = Join-Path $vault '工作台首页.md'
  harnessPatch = $patch
  cli = $studio
} | ConvertTo-Json
