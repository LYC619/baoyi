param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$prefix = $root + [IO.Path]::DirectorySeparatorChar
$batch = '2026-09-29'
$manifestPath = Join-Path $root "archive/$batch/moves.json"

function WorkspacePath([string]$relative) {
    $full = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Outside workspace: $full"
    }
    return $full
}

function Inventory([string]$full) {
    $item = Get-Item -LiteralPath $full -Force
    $entries = if ($item.PSIsContainer) {
        @(Get-ChildItem -LiteralPath $full -Recurse -Force)
    } else { @($item) }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point: $full" }
    foreach ($entry in $entries) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Reparse point: $($entry.FullName)"
        }
    }
    return @($entries | Where-Object { -not $_.PSIsContainer } | Sort-Object FullName | ForEach-Object {
        [pscustomobject]@{
            Path = if ($item.PSIsContainer) { $_.FullName.Substring($full.Length + 1) } else { $_.Name }
            Bytes = $_.Length
            SHA256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        }
    })
}

$moves = [Collections.Generic.List[object]]::new()
function AddMove([string]$from, [string]$to) {
    $moves.Add([pscustomobject]@{ From=$from; To=$to; Status='planned'; Files=@() })
}

Get-ChildItem -LiteralPath (Join-Path $root 'release') -Directory |
    Where-Object { $_.Name -match '^0\.[678]\.0(?:-|$)' } | ForEach-Object {
        AddMove "release/$($_.Name)" "release/archive/$batch/$($_.Name)"
    }
Get-ChildItem -LiteralPath (Join-Path $root 'output') -Directory |
    Where-Object { $_.Name -notin @('archive', 'pica-network-verification', 'release-0.9.0-verification') } |
    ForEach-Object { AddMove "output/$($_.Name)" "output/archive/$batch/$($_.Name)" }
foreach ($name in @('.tmp-hanime-api-probe', '抱一.7z', 'series-downloads', 'test-downloads')) {
    AddMove $name "archive/$batch/$name"
}
foreach ($name in @('v0.6-进度.md','v0.7-计划.md','v0.7-进度.md','v0.8-计划.md','v0.8-进度.md','夜间任务-2026-08-31.md')) {
    AddMove $name "docs/history/$name"
}
AddMove 'doc/v0.6-全过程记录.md' 'docs/history/v0.6-全过程记录.md'

if (Test-Path -LiteralPath $manifestPath) { throw 'A manifest already exists; inspect it before another run.' }
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath })
foreach ($move in $moves) {
    $source = WorkspacePath $move.From
    $destination = WorkspacePath $move.To
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing source: $source" }
    if (Test-Path -LiteralPath $destination) { throw "Destination exists: $destination" }
    foreach ($process in $processes) {
        if ($process.ExecutablePath.Equals($source, [StringComparison]::OrdinalIgnoreCase) -or
            $process.ExecutablePath.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Running executable in $source"
        }
    }
}
$moves | Select-Object From, To | Format-Table -AutoSize
if (-not $Apply) { return }

New-Item -ItemType Directory -Path (Split-Path $manifestPath) -Force | Out-Null
foreach ($move in $moves) {
    $source = WorkspacePath $move.From
    $destination = WorkspacePath $move.To
    $move.Files = @(Inventory $source)
    $moves | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
    Move-Item -LiteralPath $source -Destination $destination
    $after = @(Inventory $destination)
    if (($move.Files | ConvertTo-Json -Depth 4 -Compress) -cne ($after | ConvertTo-Json -Depth 4 -Compress)) {
        throw "Content verification failed: $destination"
    }
    $move.Status = 'moved-and-sha256-verified'
    $moves | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Write-Output "Verified: $($move.From) -> $($move.To)"
}
