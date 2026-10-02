param([switch]$VerifyOnly, [string]$EvidenceDirectory = 'output/image-optimization')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
if ($pkg.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version' }
$target = Join-Path $root ('release/' + $pkg.version)
if (!(Test-Path -LiteralPath (Join-Path $target 'win-unpacked/resources/app.asar'))) { throw 'Build the directory package first' }
$utf8 = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Hash([string]$file) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Json([string]$file, $value) {
  [System.IO.File]::WriteAllText($file, ($value | ConvertTo-Json -Depth 20) + "`n", $utf8)
}
function Record([string]$file, [string]$base) {
  $item = Get-Item -LiteralPath $file
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Unexpected link: $file" }
  $relative = [System.IO.Path]::GetRelativePath($base, $item.FullName).Replace('\', '/')
  if ($relative.StartsWith('../') -or [System.IO.Path]::IsPathRooted($relative)) { throw "Outside release scope: $file" }
  [ordered]@{ path = $relative; bytes = $item.Length; sha256 = (Hash $item.FullName) }
}
$sourceList = Join-Path $target 'source-files.json'
$sourceZip = Join-Path $target ('BaoYi-' + $pkg.version + '-source.zip')
$manifestPath = Join-Path $target 'manifest.json'
$sums = Join-Path $target 'SHA256SUMS.txt'

if (!$VerifyOnly) {
  foreach ($file in @($sourceList, $sourceZip, $manifestPath, $sums)) {
    if (Test-Path -LiteralPath $file) { throw "Refusing to overwrite release evidence: $file" }
  }
  $verification = Get-Content -LiteralPath (Join-Path $target 'verification.json') -Raw | ConvertFrom-Json
  if ($verification.status -ne 'passed' -or $verification.version -ne $pkg.version) { throw 'Missing successful acceptance record' }
  $content = Get-Content -LiteralPath (Join-Path (Join-Path $root $EvidenceDirectory) 'packaged-content.json') -Raw | ConvertFrom-Json
  if ($content.version -ne $pkg.version -or $content.asarSha256 -ne (Hash (Join-Path $target 'win-unpacked/resources/app.asar'))) { throw 'Packaged content changed after verification' }
  $paths = [System.Collections.Generic.List[string]]::new()
  foreach ($name in @('.gitignore', '.npmrc', 'AGENTS.md', 'README.md', 'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts', 'electron-builder.yml', 'electron-builder.portable.yml', 'electron-builder.green.yml')) {
    $paths.Add((Join-Path $root $name))
  }
  # Only build inputs and release documentation; never sweep user data or process directories.
  foreach ($name in @('electron', 'src', 'scripts', 'resources', 'docs/third-party', 'docs/releases')) {
    Get-ChildItem -LiteralPath (Join-Path $root $name) -Recurse -File | ForEach-Object { $paths.Add($_.FullName) }
  }
  $sources = @($paths | Sort-Object -Unique | ForEach-Object { Record $_ $root })
  Write-Json $sourceList $sources
  $zip = [System.IO.Compression.ZipFile]::Open($sourceZip, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in $sources) {
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root $file.path), $file.path, [System.IO.Compression.CompressionLevel]::Optimal)
    }
  } finally { $zip.Dispose() }
  $files = @(Get-ChildItem -LiteralPath (Join-Path $target 'win-unpacked') -Recurse -File | Sort-Object FullName | ForEach-Object { Record $_.FullName $target })
  $baseline = (& git -C $root rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Cannot record Git baseline' }
  $branch = (& git -C $root branch --show-current).Trim()
  $dirty = [bool](& git -C $root status --porcelain --untracked-files=normal)
  $manifest = [ordered]@{
    version = $pkg.version; createdAt = [DateTimeOffset]::Now.ToString('o'); platform = 'win32-x64'
    electronVersion = $pkg.devDependencies.electron; dataMode = 'appdata'
    executable = 'win-unpacked/' + $pkg.productName + '.exe'; codeSigned = $false
    gitBaseline = $baseline; gitBranch = $branch; uncommittedChangesIncluded = $dirty
    provenance = 'local-worktree-build'; sourceArchive = [System.IO.Path]::GetFileName($sourceZip)
    sourceArchiveSha256 = (Hash $sourceZip); sourceFileManifest = 'source-files.json'; sourceFileCount = $sources.Count
    verification = $verification; compiledContent = $content; files = $files
  }
  Write-Json $manifestPath $manifest
  $covered = @($files) + @($sourceList, $sourceZip, $manifestPath, (Join-Path $target 'verification.json') | ForEach-Object { Record $_ $target })
  [System.IO.File]::WriteAllLines($sums, [string[]]@($covered | ForEach-Object { $_.sha256 + '  ' + $_.path }), $utf8)
}

$sources = @(Get-Content -LiteralPath $sourceList -Raw | ConvertFrom-Json)
$zip = [System.IO.Compression.ZipFile]::OpenRead($sourceZip)
try {
  if ($zip.Entries.Count -ne $sources.Count) { throw 'Source archive count mismatch' }
  foreach ($file in $sources) {
    $entry = $zip.GetEntry($file.path)
    if (!$entry -or $entry.Length -ne $file.bytes) { throw "Source archive entry mismatch: $($file.path)" }
    $stream = $entry.Open(); $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { $actual = [Convert]::ToHexString($algorithm.ComputeHash($stream)).ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
    if ($actual -ne $file.sha256 -or $actual -ne (Hash (Join-Path $root $file.path))) { throw "Source hash mismatch: $($file.path)" }
  }
} finally { $zip.Dispose() }
$lines = @(Get-Content -LiteralPath $sums)
foreach ($line in $lines) {
  if ($line -notmatch '^([a-f0-9]{64})  (.+)$') { throw 'Invalid checksum record' }
  $expected = $Matches[1]; $relative = $Matches[2]
  $file = [System.IO.Path]::GetFullPath((Join-Path $target $relative))
  if (!$file.StartsWith($target + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Checksum path outside release' }
  if ((Hash $file) -ne $expected) { throw "Release checksum mismatch: $relative" }
}
Write-Output "PASS source ZIP: $($sources.Count) files; release SHA-256: $($lines.Count) files"
