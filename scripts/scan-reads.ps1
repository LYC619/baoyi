# Scan session transcripts for Read tool results containing full copies of the
# corrupted files. A Read's tool_result holds the entire file body (line-numbered),
# which is exactly what we need for recovery.
#
# Strategy: pass 1 collects tool_use ids for Reads of files we care about, pass 2
# pulls the matching tool_result bodies and reports their size. Scans every session
# in the project dir, newest file first, so the freshest copies surface early.
#
# All reads go through .NET with explicit UTF-8 -- Get-Content decodes as ANSI and
# would mangle the very Chinese we are recovering.
#
# ASCII only on purpose.
$ErrorActionPreference = 'Stop'

$sessionDir = 'C:\Users\yicha\.claude\projects\D--8-Project-0-0------'

$wanted = @(
  'Sidebar.vue', 'TitleBar.vue', 'Confirm.vue', 'Home.vue',
  'Organize.vue', 'Onboarding.vue', 'Settings.vue',
  'global.scss', 'variables.scss'
)

$utf8 = New-Object System.Text.UTF8Encoding $false

$sessionFiles = Get-ChildItem -Path $sessionDir -Filter '*.jsonl' -File |
  Sort-Object LastWriteTime -Descending

foreach ($sf in $sessionFiles) {
  $path = $sf.FullName
  $sid = $sf.BaseName

  # Pass 1: id -> leaf name, for Reads of files of interest.
  $idToLeaf = @{}
  $lineNo = 0
  foreach ($line in [System.IO.File]::ReadLines($path, $utf8)) {
    $lineNo++
    if ($line -notmatch '"Read"') { continue }
    try { $obj = $line | ConvertFrom-Json } catch { continue }
    foreach ($block in @($obj.message.content)) {
      if ($block.type -ne 'tool_use' -or $block.name -ne 'Read') { continue }
      $fp = [string]$block.input.file_path
      if ([string]::IsNullOrEmpty($fp)) { continue }
      $leaf = Split-Path $fp -Leaf
      if ($wanted -notcontains $leaf) { continue }
      $idToLeaf[[string]$block.id] = @{
        leaf   = $leaf
        line   = $lineNo
        offset = $block.input.offset
        limit  = $block.input.limit
      }
    }
  }

  if ($idToLeaf.Count -eq 0) { continue }

  Write-Output ("=== {0}  ({1:N0} KB, {2:yyyy-MM-dd HH:mm}) ===" -f $sid, ($sf.Length / 1KB), $sf.LastWriteTime)

  # Pass 2: find the results carrying the bodies.
  $lineNo = 0
  foreach ($line in [System.IO.File]::ReadLines($path, $utf8)) {
    $lineNo++
    if ($line -notmatch 'tool_result') { continue }
    try { $obj = $line | ConvertFrom-Json } catch { continue }
    foreach ($block in @($obj.message.content)) {
      if ($block.type -ne 'tool_result') { continue }
      $id = [string]$block.tool_use_id
      if (-not $idToLeaf.ContainsKey($id)) { continue }

      $body = ''
      foreach ($c in @($block.content)) {
        if ($c -is [string]) { $body += $c }
        elseif ($c.type -eq 'text') { $body += [string]$c.text }
      }
      $meta = $idToLeaf[$id]
      $range = 'FULL'
      if ($null -ne $meta.offset -or $null -ne $meta.limit) {
        $range = "offset=$($meta.offset) limit=$($meta.limit)"
      }
      # A truncation notice means the body is not a complete copy.
      $trunc = if ($body -match 'truncated|has been truncated') { 'TRUNC' } else { '' }
      "{0,-16} chars={1,7}  {2,-24} {3,-5} result_line={4,6}" -f `
        $meta.leaf, $body.Length, $range, $trunc, $lineNo
    }
  }
}
