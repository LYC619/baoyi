# Scan Claude Code session transcripts for full copies of the files the rename
# script corrupted. A Write tool call carries the whole file in its input; an Edit
# carries only a fragment. We want Writes, newest first.
#
# All reads go through .NET with explicit UTF-8 -- Get-Content would decode as ANSI
# and mangle the very Chinese we are trying to recover.
#
# ASCII only on purpose.
$ErrorActionPreference = 'Stop'

$sessionDir = 'C:\Users\yicha\.claude\projects\D--8-Project-0-0------'
$sessions = @(
  'd06abef8-d80a-4835-9259-e6d56ed4f022',  # v0.4.1
  'a78fbbfe-04ff-47bc-b1c8-a42600fa127f'   # v0.4
)

$wanted = @(
  'Sidebar.vue', 'TitleBar.vue', 'Confirm.vue', 'Home.vue',
  'Organize.vue', 'Onboarding.vue', 'Settings.vue',
  'global.scss', 'variables.scss'
)

$utf8 = New-Object System.Text.UTF8Encoding $false

foreach ($sid in $sessions) {
  $path = Join-Path $sessionDir "$sid.jsonl"
  if (-not (Test-Path $path)) { Write-Output "MISSING session $sid"; continue }

  $sizeMB = [math]::Round((Get-Item $path).Length / 1MB, 1)
  Write-Output "=== session $sid  (${sizeMB}MB) ==="

  $lineNo = 0
  foreach ($line in [System.IO.File]::ReadLines($path, $utf8)) {
    $lineNo++
    if ($line.Length -eq 0) { continue }
    # Cheap prefilter before paying for JSON parsing.
    if ($line -notmatch '"(Write|Edit|MultiEdit)"') { continue }

    try { $obj = $line | ConvertFrom-Json } catch { continue }

    $content = $obj.message.content
    if ($null -eq $content) { continue }

    foreach ($block in @($content)) {
      if ($block.type -ne 'tool_use') { continue }
      if ($block.name -notin @('Write', 'Edit', 'MultiEdit')) { continue }

      $fp = [string]$block.input.file_path
      if ([string]::IsNullOrEmpty($fp)) { continue }
      $leaf = Split-Path $fp -Leaf
      if ($wanted -notcontains $leaf) { continue }

      $bodyLen = 0
      if ($block.name -eq 'Write') { $bodyLen = ([string]$block.input.content).Length }

      "{0,-6} line={1,6}  {2,-16} chars={3,7}  {4}" -f `
        $block.name, $lineNo, $leaf, $bodyLen, $obj.timestamp
    }
  }
}
