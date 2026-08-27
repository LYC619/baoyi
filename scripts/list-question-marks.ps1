# Diagnostic: list every '?' with context in the repaired files, so each one can be
# judged as legitimate code (?., ??, ternary, regex) or a character lost to the
# cp936 round trip.
#
# ASCII only on purpose.
$ErrorActionPreference = 'Stop'

$targets = @(
  'src\components\software\Sidebar.vue',
  'src\components\TitleBar.vue',
  'src\pages\software\Confirm.vue',
  'src\pages\software\Home.vue',
  'src\pages\software\Organize.vue',
  'src\pages\Onboarding.vue',
  'src\pages\Settings.vue'
)

foreach ($rel in $targets) {
  $path = (Resolve-Path $rel).Path
  $lines = [System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8)
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ($line -notmatch '\?') { continue }
    # Skip lines whose only '?' are unambiguous code idioms.
    $stripped = $line -replace '\?\?', '' -replace '\?\.', '' -replace '\?:', ''
    if ($stripped -notmatch '\?') { continue }
    Write-Output ("{0}:{1}  {2}" -f (Split-Path $rel -Leaf), ($i + 1), $line.Trim())
  }
}
