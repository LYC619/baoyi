# Verify exactly what each '?' consumed, by replaying the corruption on known text.
#
# Hypothesis: cp936's decoder, on hitting an invalid lead+trail pair, emits one '?'
# and consumes BOTH bytes. If true, alignment is restored right after every '?',
# so the damage is LOCAL (one CJK tail byte + the one byte after it) rather than
# a cascade that shifts the rest of the file. That difference decides whether the
# remaining four files are repairable at all.
#
# ASCII only on purpose.
$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding $false
$cp936 = [System.Text.Encoding]::GetEncoding(936)

# Known original from the TitleBar template, including the '<' that follows.
$original = [char]0x77E5 + [char]0x6B62 + [char]0x800C + [char]0x540E + [char]0x5F97 + '</span>'

$originalBytes = $utf8.GetBytes($original)
"original          : $original"
"original bytes    : $(($originalBytes | ForEach-Object { $_.ToString('X2') }) -join ' ')"

# Step 1: what the rename script did -- decode those UTF-8 bytes as cp936.
$mojibake = $cp936.GetString($originalBytes)
"decoded as cp936  : $mojibake"

# Step 2: it then wrote that string back as UTF-8; reading it back gives the same
# string, so re-encoding to cp936 is the reverse transform.
$roundTrip = $cp936.GetBytes($mojibake)
"reversed bytes    : $(($roundTrip | ForEach-Object { $_.ToString('X2') }) -join ' ')"
"reversed text     : $($utf8.GetString($roundTrip))"

# Compare byte-for-byte to locate exactly what was lost.
$lostAt = @()
$min = [Math]::Min($originalBytes.Count, $roundTrip.Count)
for ($i = 0; $i -lt $min; $i++) {
  if ($originalBytes[$i] -ne $roundTrip[$i]) { $lostAt += $i; break }
}
"first divergence  : index $($lostAt -join ',')  (orig len=$($originalBytes.Count), rev len=$($roundTrip.Count))"

# Does alignment recover? Compare the tails after the damaged region.
$origTail = ($originalBytes[-7..-1] | ForEach-Object { $_.ToString('X2') }) -join ' '
$revTail  = ($roundTrip[-7..-1]    | ForEach-Object { $_.ToString('X2') }) -join ' '
"original tail     : $origTail"
"reversed tail     : $revTail"
if ($origTail -eq $revTail) {
  "VERDICT           : alignment RECOVERS -- damage is local"
} else {
  "VERDICT           : alignment LOST -- damage cascades"
}
