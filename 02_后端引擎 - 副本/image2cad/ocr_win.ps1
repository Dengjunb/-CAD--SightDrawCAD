param(
    [Parameter(Mandatory=$true)][string]$ImagePath,
    [string]$Language = "zh-Hans-CN"
)
# Windows built-in OCR bridge (Windows.Media.Ocr).
# Input: a local image path. Output: one UTF-8 JSON line on stdout.
# Called by image2cad/ocr.py. Keep this file ASCII-only: Windows PowerShell
# 5.1 reads BOM-less .ps1 as ANSI and would corrupt non-ASCII comments.
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

# Generic WinRT IAsyncOperation -> .NET Task awaiter.
$asTaskGeneric = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
})[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    $lang = [Windows.Globalization.Language]::new($Language)
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    if ($null -eq $engine) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if ($null -eq $engine) {
        '{"ok":false,"error":"no-ocr-engine"}'
        exit 0
    }

    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $result.Lines) {
        $x1 = 1e9; $y1 = 1e9; $x2 = -1e9; $y2 = -1e9
        foreach ($w in $line.Words) {
            $r = $w.BoundingRect
            if ($r.X -lt $x1) { $x1 = $r.X }
            if ($r.Y -lt $y1) { $y1 = $r.Y }
            if (($r.X + $r.Width) -gt $x2) { $x2 = $r.X + $r.Width }
            if (($r.Y + $r.Height) -gt $y2) { $y2 = $r.Y + $r.Height }
        }
        if ($x2 -lt $x1) { continue }
        $lines += [pscustomobject]@{
            text = $line.Text
            x = [double]$x1
            y = [double]$y1
            w = [double]($x2 - $x1)
            h = [double]($y2 - $y1)
        }
    }
    $payload = [pscustomobject]@{
        ok = $true
        width = [int]$bitmap.PixelWidth
        height = [int]$bitmap.PixelHeight
        language = $Language
        lines = $lines
    }
    $payload | ConvertTo-Json -Depth 6 -Compress
}
catch {
    $msg = $_.Exception.Message -replace '"', "'"
    Write-Output ('{"ok":false,"error":"' + $msg + '"}')
}
