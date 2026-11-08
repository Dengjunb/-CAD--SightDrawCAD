param([switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
Write-Host "== ShiHui CAD v3.0 assemble ==" -ForegroundColor Cyan
$manifestPath = Join-Path $base '拆分清单.json'
if (-not (Test-Path $manifestPath)) { Write-Host 'missing 拆分清单.json' -ForegroundColor Red; exit 1 }
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$target = Join-Path $base '运行目录'
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Path $target | Out-Null
foreach ($g in $manifest.groups.PSObject.Properties) {
    $gdir = Join-Path $base $g.Name
    foreach ($m in $g.Value) {
        $vol = Join-Path $gdir $m.volume
        if (Test-Path $vol) { robocopy $vol $target /E /NFL /NDL /NJH /NJS /NP | Out-Null }
    }
}
foreach ($c in $manifest.chunked) {
    $rel = $c.rel
    $parts = @($c.parts)
    $targetFile = Join-Path $target $rel
    $partPaths = @()
    foreach ($p in $parts) { $partPaths += (Join-Path $target $p) }
    $arg = ($partPaths | ForEach-Object { '"' + $_ + '"' }) -join '+'
    Write-Host ("merge " + $rel)
    cmd /c copy /b $arg "$targetFile" > $null
    foreach ($p in $parts) { Remove-Item (Join-Path $target $p) -Force }
}
$exe = Join-Path $target '识绘CAD.exe'
if (-not (Test-Path $exe)) { Write-Host 'assemble failed: no exe' -ForegroundColor Red; exit 1 }
Write-Host ("assembled: " + $exe) -ForegroundColor Green
if (-not $NoLaunch) { Start-Process -FilePath $exe }