# Diagnostic: for each corrupted file, compare against the clean HEAD reference to
# see how much of the file is untouched by 0.4 work (and therefore restorable
# verbatim from HEAD) versus genuinely changed (and therefore needing another source).
#
# ASCII only on purpose.
$ErrorActionPreference = 'Stop'

$ref = '..\baoyi-head-ref'

$pairs = @(
  @{ head = 'src\components\Sidebar.vue';  now = 'src\components\software\Sidebar.vue' },
  @{ head = 'src\components\TitleBar.vue'; now = 'src\components\TitleBar.vue' },
  @{ head = 'src\pages\Confirm.vue';       now = 'src\pages\software\Confirm.vue' },
  @{ head = 'src\pages\Home.vue';          now = 'src\pages\software\Home.vue' },
  @{ head = 'src\pages\Onboarding.vue';    now = 'src\pages\Onboarding.vue' },
  @{ head = 'src\pages\Settings.vue';      now = 'src\pages\Settings.vue' }
)

$utf8 = New-Object System.Text.UTF8Encoding $false

foreach ($p in $pairs) {
  $headPath = Join-Path $ref $p.head
  if (-not (Test-Path $headPath)) { Write-Output "MISSING in HEAD: $($p.head)"; continue }

  $headLines = [System.IO.File]::ReadAllLines($headPath, $utf8)
  $nowLines  = [System.IO.File]::ReadAllLines((Resolve-Path $p.now), $utf8)

  # How many of the current lines appear verbatim somewhere in HEAD? A damaged line
  # (merged / '?'-substituted) will not match, and neither will a genuine 0.4 edit.
  $headSet = New-Object System.Collections.Generic.HashSet[string]
  foreach ($l in $headLines) { [void]$headSet.Add($l) }

  $unmatched = 0
  foreach ($l in $nowLines) {
    if ($l.Trim().Length -eq 0) { continue }
    if (-not $headSet.Contains($l)) { $unmatched++ }
  }

  "{0,-16} head_lines={1,5}  now_lines={2,5}  lines_not_in_head={3,4}" -f `
    (Split-Path $p.now -Leaf), $headLines.Count, $nowLines.Count, $unmatched
}
