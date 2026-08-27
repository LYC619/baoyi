# Detect double-encoding mojibake, the damage shape the hole-scanner cannot see.
#
# When UTF-8 bytes are decoded as cp936 and re-encoded as UTF-8, the result is
# perfectly valid UTF-8 -- just wrong ("滚动条" -> "婊氬姩鏉"). So it survives every
# encoding check and only a round-trip test finds it:
#
#   mojibake -> encode cp936 -> bytes ARE valid UTF-8 (they are the originals)
#   real text -> encode cp936 -> bytes are NOT valid UTF-8 (GBK lead bytes clash)
#
# Both encoders use ExceptionFallback so a failed round trip throws rather than
# silently substituting '?', which would make everything look like mojibake.
#
# ASCII only on purpose.
$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding $false
$gbk = [System.Text.Encoding]::GetEncoding(
  936,
  [System.Text.EncoderFallback]::ExceptionFallback,
  [System.Text.DecoderFallback]::ExceptionFallback)
$utf8Strict = [System.Text.Encoding]::GetEncoding(
  'utf-8',
  [System.Text.EncoderFallback]::ExceptionFallback,
  [System.Text.DecoderFallback]::ExceptionFallback)

$roots = @('src', 'electron', 'scripts', 'index.html')
$exts = @('.vue', '.ts', '.js', '.scss', '.css', '.json', '.html', '.md', '.cjs')

$files = @()
foreach ($r in $roots) {
  if (-not (Test-Path $r)) { continue }
  $files += Get-ChildItem -Path $r -Recurse -File | Where-Object { $exts -contains $_.Extension }
}

$totalRuns = 0
$hitFiles = 0
foreach ($f in $files) {
  $text = [System.IO.File]::ReadAllText($f.FullName, $utf8)
  $runs = 0
  $samples = @()

  # Runs of non-ASCII, at least two chars: one stray char is never a decodable run.
  foreach ($m in [regex]::Matches($text, '[^\x00-\x7F]{2,}')) {
    $run = $m.Value
    try {
      $bytes = $gbk.GetBytes($run)
      $back = $utf8Strict.GetString($bytes)
    } catch { continue }
    # A real round trip must yield non-ASCII text, otherwise it is coincidence.
    if ($back -notmatch '[^\x00-\x7F]') { continue }
    $runs++
    if ($samples.Count -lt 4) {
      $line = ($text.Substring(0, $m.Index) -split "`n").Count
      $samples += "      line {0,5}: {1}  ->  {2}" -f $line, $run, $back
    }
  }

  if ($runs -eq 0) { continue }
  $hitFiles++
  $totalRuns += $runs
  $rel = Resolve-Path -Relative $f.FullName
  "{0,5} runs  {1}" -f $runs, $rel
  $samples | ForEach-Object { $_ }
}

""
"mojibake files = $hitFiles"
"mojibake runs  = $totalRuns"
