# List every resource VS Code local history knows about, so we can confirm whether
# this project appears at all (rather than trusting a path-pattern guess).
#
# ASCII only; reads via .NET with explicit UTF-8.
$ErrorActionPreference = 'Stop'

$historyRoot = Join-Path $env:APPDATA 'Code\User\History'
$utf8 = New-Object System.Text.UTF8Encoding $false

foreach ($dir in Get-ChildItem $historyRoot -Directory) {
  $entriesPath = Join-Path $dir.FullName 'entries.json'
  if (-not (Test-Path $entriesPath)) { continue }

  try {
    $json = [System.IO.File]::ReadAllText($entriesPath, $utf8) | ConvertFrom-Json
  } catch {
    Write-Output "UNPARSEABLE  $($dir.Name)"
    continue
  }

  $raw = ([string]$json.resource) -replace '^file:///', ''
  $resource = [Uri]::UnescapeDataString($raw)
  $count = @($json.entries).Count
  $newest = @($json.entries) | Sort-Object { [int64]$_.timestamp } -Descending | Select-Object -First 1
  $stamp = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$newest.timestamp).ToLocalTime()
  "{0:yyyy-MM-dd HH:mm}  n={1,3}  {2}" -f $stamp, $count, $resource
}
