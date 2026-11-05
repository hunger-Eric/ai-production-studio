param([string]$Destination)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
if (-not $Destination) { $Destination = Join-Path $project 'dist' }
$dist = New-Item -ItemType Directory -Path $Destination -Force
$release = Join-Path $dist.FullName 'ai-production-studio-0.2.0'
if (Test-Path -LiteralPath $release) { throw "Release output already exists: $release" }
$skill = Join-Path $release 'ai-production-studio'
$scripts = Join-Path $skill 'scripts'
$references = Join-Path $skill 'references'
New-Item -ItemType Directory -Path $scripts,$references | Out-Null
Copy-Item -LiteralPath (Join-Path $project 'hosts/workbuddy/SKILL.md') -Destination $skill
Copy-Item -LiteralPath (Join-Path $project 'LICENSE'),(Join-Path $project 'THIRD_PARTY_NOTICES.md') -Destination $skill
Copy-Item -LiteralPath (Join-Path $project 'hosts/workbuddy/studio.mjs') -Destination $scripts
Copy-Item -LiteralPath (Join-Path $project 'hosts/workbuddy/usage.md') -Destination $references
Copy-Item -LiteralPath (Join-Path $project 'hosts/deepseek-harness/studio.cordis.yml') -Destination $references
$engine = New-Item -ItemType Directory -Path (Join-Path $scripts 'engine')
Get-ChildItem -LiteralPath (Join-Path $project 'engine') -File | Copy-Item -Destination $engine.FullName
Copy-Item -LiteralPath (Join-Path $project 'engine/python') -Destination $engine.FullName -Recurse
Copy-Item -LiteralPath (Join-Path $project 'engine/publisher') -Destination $engine.FullName -Recurse
Copy-Item -LiteralPath (Join-Path $project 'knowledge') -Destination $scripts -Recurse
$zip = Join-Path $release 'ai-production-studio.zip'
Compress-Archive -LiteralPath $skill -DestinationPath $zip
Get-FileHash -LiteralPath $zip -Algorithm SHA256
