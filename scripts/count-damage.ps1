# Count real damage sites per file.
#
# A damage site is a '?' that replaced two bytes: the third byte of a CJK char plus
# the byte after it. Because alignment recovers (verified in probe-loss.ps1), such a
# '?' is always immediately preceded by a partial/mojibake CJK char -- whereas a
# legitimate '?' in code sits next to ASCII (?., ??, ternary, regex, query string).
#
# ASCII only on purpose.
$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding $false

$targets = @(
  'src\components\software\Sidebar.vue',
  'src\components\TitleBar.vue',
  'src\pages\software\Confirm.vue',
  'src\pages\software\Home.vue',
  'src\pages\software\Organize.vue',
  'src\pages\Onboarding.vue',
  'src\pages\Settings.vue'
)

$total = 0
foreach ($rel in $targets) {
  $text = [System.IO.File]::ReadAllText((Resolve-Path $rel), $utf8)
  $sites = 0
  for ($i = 1; $i -lt $text.Length; $i++) {
    if ($text[$i] -ne '?') { continue }
    $prev = [int][char]$text[$i - 1]
    # Preceded by a non-ASCII char => the '?' ate that char's tail byte.
    if ($prev -gt 0x7F) { $sites++ }
  }
  $total += $sites
  "{0,-16} damage_sites={1,4}" -f (Split-Path $rel -Leaf), $sites
}
"TOTAL damage sites = $total"
