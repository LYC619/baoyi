# Reverse double-encoding mojibake, one run at a time, at byte level.
#
# The corruption was: original UTF-8 bytes -> decoded as cp936 -> re-encoded UTF-8.
# Encoding mojibake back through cp936 therefore reproduces the original bytes
# exactly. But these files are MIXED: text edited after the corruption is already
# correct, and blanket conversion would destroy it (variables.scss lines 46-50).
#
# The discriminator is strict UTF-8 validity of the cp936 bytes:
#
#   mojibake   "瀛椾綋"  -> cp936 -> E5 AD 97 E4 BD 93  -> valid UTF-8 -> "字体"
#   real text  "字体"    -> cp936 -> D7 D6 CC E5        -> invalid UTF-8 -> leave alone
#
# A truncated sequence is allowed at the very END of a run only, because that is
# what a following '?' means: cp936 had no mapping there and ate the bytes. Those
# become ordinary holes for repair-mojibake.cjs to fill from reference copies.
#
# Runs whose valid portion decodes to nothing (a lone mojibake char standing for a
# 3-byte original, e.g. "鈥" for an em dash) carry no CJK evidence of their own, so
# they are converted only in files where other runs already proved to be mojibake.
#
# Run with -Apply to write; default is a report.
#
# ASCII only on purpose.
param([switch]$Apply)
$ErrorActionPreference = 'Stop'

$targets = @('src\styles\global.scss', 'src\styles\variables.scss')

$utf8 = New-Object System.Text.UTF8Encoding $false
$gbk = [System.Text.Encoding]::GetEncoding(
  936,
  [System.Text.EncoderFallback]::ExceptionFallback,
  [System.Text.DecoderFallback]::ExceptionFallback)

# How many leading bytes form complete UTF-8 sequences, and whether the remainder is
# a legal truncation rather than corruption. Returns -1 if the bytes are invalid.
function Get-Utf8ValidLength([byte[]]$b) {
  $i = 0
  while ($i -lt $b.Length) {
    $c = $b[$i]
    if ($c -lt 0x80) { $i++; continue }
    if ($c -ge 0xC2 -and $c -le 0xDF) { $need = 2 }
    elseif ($c -ge 0xE0 -and $c -le 0xEF) { $need = 3 }
    elseif ($c -ge 0xF0 -and $c -le 0xF4) { $need = 4 }
    else { return -1 }   # continuation or overlong byte where a lead must be
    $have = 1
    while ($have -lt $need -and $i + $have -lt $b.Length `
           -and $b[$i + $have] -ge 0x80 -and $b[$i + $have] -le 0xBF) { $have++ }
    if ($have -lt $need) {
      # Incomplete: legal only if it runs to the end of the buffer.
      if ($i + $have -eq $b.Length) { return $i }
      return -1
    }
    $i += $need
  }
  return $i
}

function Get-CjkRatio([string]$s) {
  if ($s.Length -eq 0) { return -1.0 }
  $n = 0
  foreach ($ch in $s.ToCharArray()) {
    $u = [int][char]$ch
    if (($u -ge 0x4E00 -and $u -le 0x9FFF) -or
        ($u -ge 0x3000 -and $u -le 0x303F) -or
        ($u -ge 0xFF00 -and $u -le 0xFFEF) -or
        $u -eq 0x2014 -or $u -eq 0x2018 -or $u -eq 0x2019 -or
        $u -eq 0x201C -or $u -eq 0x201D) { $n++ }
  }
  return [double]$n / $s.Length
}

foreach ($rel in $targets) {
  $abs = (Resolve-Path $rel).Path
  $text = [System.IO.File]::ReadAllText($abs, $utf8)
  "=== $rel ==="

  $runs = @()
  foreach ($m in [regex]::Matches($text, '[^\x00-\x7F]+')) {
    $run = $m.Value
    # PSCustomObject, not a hashtable: Sort-Object and property access on hashtables
    # are unreliable in PS 5.1 and silently scramble run order.
    $rec = [pscustomobject]@{
      index = $m.Index; length = $run.Length; text = $run
      accept = $false; note = ''; bytes = $null; decoded = ''; ratio = -1.0
    }

    $bytes = $null
    try { $bytes = $gbk.GetBytes($run) } catch { $rec.note = 'not cp936-encodable'; $runs += $rec; continue }

    $validLen = Get-Utf8ValidLength $bytes
    if ($validLen -lt 0) { $rec.note = 'cp936 bytes are not valid UTF-8 -- real text'; $runs += $rec; continue }

    $decoded = $utf8.GetString($bytes, 0, $validLen)
    $ratio = Get-CjkRatio $decoded
    $rec.bytes = $bytes
    $rec.decoded = $decoded
    $rec.ratio = $ratio

    if ($ratio -ge 0.7) { $rec.accept = $true; $rec.note = 'mojibake' }
    elseif ($ratio -lt 0) { $rec.note = 'no decodable evidence -- deferred' }
    else { $rec.note = ('CJK ratio {0:P0} too low' -f $ratio) }
    $runs += $rec
  }

  $proven = @($runs | Where-Object { $_.accept }).Count
  if ($proven -eq 0) { "  no mojibake runs found"; ""; continue }

  # Second look at the evidence-free runs, now that the file is known to be mojibake.
  foreach ($rec in $runs) {
    if ($rec.accept -or $rec.note -ne 'no decodable evidence -- deferred') { continue }
    $after = $rec.index + $rec.length
    if ($after -lt $text.Length -and $text[$after] -eq '?') {
      $rec.accept = $true
      $rec.note = 'truncated lead before a hole'
    }
  }

  foreach ($rec in $runs) {
    $line = ($text.Substring(0, $rec.index) -split "`n").Count
    $mark = if ($rec.accept) { 'FIX ' } else { 'keep' }
    "  {0} line {1,5}: {2,-28} -> {3,-24} {4}" -f `
      $mark, $line, $rec.text, ([string]$rec.decoded), $rec.note
  }

  # Rebuild as bytes: converted runs contribute their cp936 bytes verbatim (possibly
  # ending mid-character), everything else its normal UTF-8 encoding. Regex matches
  # already arrive in ascending order, so no sort is needed -- or wanted.
  $out = New-Object System.Collections.Generic.List[byte]
  $pos = 0
  foreach ($rec in ($runs | Where-Object { $_.accept })) {
    $out.AddRange($utf8.GetBytes($text.Substring($pos, $rec.index - $pos)))
    $out.AddRange([byte[]]$rec.bytes)
    $pos = $rec.index + $rec.length
  }
  $out.AddRange($utf8.GetBytes($text.Substring($pos)))
  $bytes = $out.ToArray()

  "  runs converted = $(@($runs | Where-Object { $_.accept }).Count) / $($runs.Count),  $($text.Length) chars -> $($bytes.Length) bytes"
  if ($Apply) {
    [System.IO.File]::WriteAllBytes($abs, $bytes)
    "  WRITTEN"
  }
  ""
}
if (-not $Apply) { "REPORT ONLY -- rerun with -Apply to write" }
