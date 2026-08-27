# Sweep the whole working tree for mojibake damage, not just the seven files the
# earlier pass happened to look at.
#
# A damage site is a '?' whose preceding char is non-ASCII: the '?' ate the third
# byte of that CJK char plus the byte after it. A legitimate '?' in source always
# sits next to ASCII (optional chaining, ternary, regex, query string).
#
# ASCII only on purpose.
$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding $false
$roots = @('src', 'electron', 'scripts', 'index.html')
$exts = @('.vue', '.ts', '.js', '.scss', '.css', '.json', '.html', '.md', '.cjs')

$files = @()
foreach ($r in $roots) {
  if (-not (Test-Path $r)) { continue }
  $files += Get-ChildItem -Path $r -Recurse -File |
    Where-Object { $exts -contains $_.Extension }
}

$total = 0
$hit = 0
foreach ($f in $files) {
  $text = [System.IO.File]::ReadAllText($f.FullName, $utf8)
  if ($text.IndexOf('?') -lt 0) { continue }
  $sites = 0
  for ($i = 1; $i -lt $text.Length; $i++) {
    if ($text[$i] -ne '?') { continue }
    if ([int][char]$text[$i - 1] -gt 0x7F) { $sites++ }
  }
  if ($sites -eq 0) { continue }
  $hit++
  $total += $sites
  $rel = Resolve-Path -Relative $f.FullName
  "{0,5}  {1}" -f $sites, $rel
}
""
"files damaged = $hit"
"TOTAL damage sites = $total"
