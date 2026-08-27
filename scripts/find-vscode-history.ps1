# Search VS Code local history for snapshots of the files corrupted by the
# rename script. VS Code keeps one folder per file; entries.json records the
# original path plus a timestamped snapshot list.
#
# All file reads go through .NET with an explicit UTF-8 encoding -- Get-Content
# would decode as ANSI and mangle both the JSON and the Chinese inside it.
#
# ASCII only on purpose.
$ErrorActionPreference = 'Stop'

$historyRoot = Join-Path $env:APPDATA 'Code\User\History'
$utf8 = New-Object System.Text.UTF8Encoding $false

$wanted = @(
  'Sidebar.vue', 'TitleBar.vue', 'Confirm.vue', 'Home.vue',
  'Organize.vue', 'Onboarding.vue', 'Settings.vue',
  'global.scss', 'variables.scss'
)

foreach ($dir in Get-ChildItem $historyRoot -Directory) {
  $entriesPath = Join-Path $dir.FullName 'entries.json'
  if (-not (Test-Path $entriesPath)) { continue }

  try {
    $json = [System.IO.File]::ReadAllText($entriesPath, $utf8) | ConvertFrom-Json
  } catch {
    continue
  }

  $resource = [string]$json.resource
  if ($resource -notmatch 'baoyi|0_0') { continue }

  $leaf = Split-Path ([Uri]::UnescapeDataString($resource -replace '^file:///', '')) -Leaf
  if ($wanted -notcontains $leaf) { continue }

  $entries = @($json.entries)
  $newest = $entries | Sort-Object { [int64]$_.timestamp } -Descending | Select-Object -First 1
  $stamp = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$newest.timestamp).ToLocalTime()

  "{0,-16} snapshots={1,3}  newest={2:MM-dd HH:mm:ss}  file={3}  dir={4}" -f `
    $leaf, $entries.Count, $stamp, $newest.id, $dir.Name
}
