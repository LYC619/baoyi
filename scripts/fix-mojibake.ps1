# One-shot repair: undo a UTF-8-read-as-ANSI round trip.
#
# What happened: PowerShell 5.1's Get-Content -Raw decoded BOM-less UTF-8 files
# using the ANSI codepage (936 here), then the text was written back out as UTF-8.
# So the bytes on disk are now utf8(cp936_decode(original_bytes)).
#
# To undo: decode the file as UTF-8 to get the mojibake string, then encode that
# string back to cp936 -- those bytes are the original UTF-8 bytes. Write them raw.
#
# Lossy where cp936 could not map a byte pair: the decoder substituted '?' and the
# original bytes are gone. Strict fallback below reports any char that cannot go
# back to cp936, which would mean the file is NOT pure mojibake and must be skipped.
#
# ASCII only on purpose, including inside regex literals -- this script must not
# fall into the very bug it repairs. CJK ranges are built from char codes.
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

# Strict encoder: throw instead of silently substituting, so mixed files are caught.
$cp936 = [System.Text.Encoding]::GetEncoding(
  936,
  [System.Text.EncoderFallback]::ExceptionFallback,
  [System.Text.DecoderFallback]::ExceptionFallback
)

# CJK + CJK punctuation + fullwidth forms, assembled from code points so this
# file stays pure ASCII.
$cjkClass = '[' +
  [char]0x3000 + '-' + [char]0x303F +
  [char]0x4E00 + '-' + [char]0x9FFF +
  [char]0xFF00 + '-' + [char]0xFFEF + ']'

foreach ($rel in $targets) {
  $path = (Resolve-Path $rel).Path
  $mojibake = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)

  try {
    $originalBytes = $cp936.GetBytes($mojibake)
  } catch {
    Write-Output "SKIP  $rel  -- not pure mojibake: $($_.Exception.Message)"
    continue
  }

  [System.IO.File]::WriteAllBytes($path, $originalBytes)

  # '?' sitting next to CJK is almost certainly a lost character, as opposed to a
  # legitimate '?' in code (?., ??, ternaries, regex).
  $repaired = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  $suspect = ([regex]::Matches($repaired, "$cjkClass\?|\?$cjkClass")).Count
  Write-Output "OK    $rel  suspect_losses=$suspect"
}
