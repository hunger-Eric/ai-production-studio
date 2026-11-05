param(
  [Parameter(Mandatory)][string]$Workspace,
  [Parameter(Mandatory)][string]$WhisperModel,
  [string]$HarnessCommand,
  [string]$HarnessEntry,
  [switch]$HarnessElectron,
  [string]$AnimationFont,
  [string]$EarshotRepository,
  [string]$CineticPath,
  [string]$EarshotPython,
  [string]$EarshotModelCache,
  [string]$PublishPython
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$vault = (Resolve-Path -LiteralPath $Workspace).Path
$model = (Resolve-Path -LiteralPath $WhisperModel).Path
$server = Join-Path $project 'engine/studio-mcp.mjs'
if (-not (Test-Path -LiteralPath (Join-Path $vault 'studio.json') -PathType Leaf)) { throw '请先初始化工作区' }
if (-not (Test-Path -LiteralPath (Join-Path $project 'engine/node_modules/@modelcontextprotocol/sdk') -PathType Container)) { throw '请先在项目根目录执行 npm ci --prefix engine' }
if (-not (Test-Path -LiteralPath $model -PathType Leaf)) { throw '请提供本机 Whisper 权重文件' }
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$settings = New-Item -ItemType Directory -Force -Path (Join-Path $vault '.dsh')
$toolEnv = @{ STUDIO_WHISPER_MODEL_PATH = $model }
$paths = @{
  STUDIO_HARNESS_COMMAND = $HarnessCommand
  STUDIO_ANIMATION_FONT = $AnimationFont; STUDIO_EARSHOT_REPOSITORY = $EarshotRepository
  STUDIO_CINETIC_PATH = $CineticPath; STUDIO_EARSHOT_PYTHON = $EarshotPython
  STUDIO_EARSHOT_MODEL_CACHE = $EarshotModelCache; STUDIO_PUBLISH_PYTHON = $PublishPython
}
foreach ($name in $paths.Keys) {
  if ($paths[$name]) { $toolEnv[$name] = (Resolve-Path -LiteralPath $paths[$name]).Path }
}
if ($HarnessEntry) {
  if ($HarnessElectron -and $HarnessEntry -match '^(.*\.asar)[\\/].+$') {
    $archive = (Resolve-Path -LiteralPath $Matches[1]).Path
    $toolEnv.STUDIO_HARNESS_ENTRY = $archive + $HarnessEntry.Substring($Matches[1].Length)
  } else {
    $toolEnv.STUDIO_HARNESS_ENTRY = (Resolve-Path -LiteralPath $HarnessEntry).Path
  }
}
if ($HarnessElectron) { $toolEnv.STUDIO_HARNESS_ELECTRON = '1' }
$name = if ($toolEnv.Count -gt 1) { 'production-studio-native.cordis.json' } else { 'production-studio.cordis.json' }
$patch = Join-Path $settings.FullName $name
$config = @(@{ insert = @(@{
  id = 'mcp-production-studio'
  name = '@deepseek-ai/dsh-mcp-client'
  config = @{
    serverName = 'studio'
    transport = 'stdio'
    command = $node
    args = @($server, '--workspace', $vault)
    env = $toolEnv
    failOnStartupError = $true
    toolCallTimeoutMs = 660000
  }
}) })
$json = ConvertTo-Json -InputObject $config -Depth 8
if (Test-Path -LiteralPath $patch) {
  $existing = Get-Content -LiteralPath $patch -Raw -Encoding utf8 | ConvertFrom-Json
  $current = $existing.insert.config
  $envMatches = $current.env.PSObject.Properties.Count -eq $toolEnv.Count
  foreach ($key in $toolEnv.Keys) { if ($current.env.$key -ne $toolEnv[$key]) { $envMatches = $false } }
  if ($current.command -ne $node -or $current.args[0] -ne $server -or $current.args[2] -ne $vault -or -not $envMatches) {
    throw "连接配置已存在且有差异：$patch"
  }
} else {
  Set-Content -LiteralPath $patch -Value $json -Encoding utf8NoBOM
}
Write-Output $patch
