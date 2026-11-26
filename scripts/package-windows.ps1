param([switch]$Build, [switch]$PrepareRuntimes)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$destination = Join-Path $projectRoot ('release/' + $package.version)
$commands = @('typecheck','i18n:check','docs:check','selfcheck','eval:archive')
if ($PrepareRuntimes) { $commands += @('prepare:hermes','prepare:comic') }
$commands += @('check:hermes','check:comic','dist:dir')
Write-Output ('Output: ' + $destination)
foreach ($command in $commands) { Write-Output ('npm run ' + $command) }
if (-not $Build) { Write-Output 'Preview only. Add -Build to execute. No release will be published.'; exit 0 }
if (-not $IsWindows -and $env:OS -ne 'Windows_NT') { throw 'Desktop packaging requires Windows.' }
if (Test-Path -LiteralPath $destination) { throw 'This version already has output. Select a new version before building; existing packages are preserved.' }
Push-Location -LiteralPath $projectRoot
try {
  foreach ($command in $commands) {
    & npm.cmd run $command
    if ($LASTEXITCODE -ne 0) { throw ('Stopped: npm run ' + $command + ' failed.') }
  }
  Write-Output ('Built directory package: ' + (Join-Path $destination 'win-unpacked'))
  Write-Output 'Test the package with a separate profile before distributing it.'
} finally { Pop-Location }
