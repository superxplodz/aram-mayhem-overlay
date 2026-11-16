# Text recognition helper for ARAM Mayhem Overlay.
# Uses the OCR engine built into Windows 10/11. Reads image paths on stdin, one per line,
# and answers each with one line: "OCR {json}" or "ERR message". Nothing leaves this PC.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  function Await($op, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  $engine = $null
  try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en-US')) } catch { }
  if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($null -eq $engine) { throw 'No Windows OCR language is installed' }
  [Console]::Out.WriteLine('READY ' + $engine.RecognizerLanguage.LanguageTag)
} catch {
  [Console]::Out.WriteLine('FAIL ' + $_.Exception.Message)
  exit 1
}

while ($null -ne ($path = [Console]::In.ReadLine())) {
  if ($path -eq '') { continue }
  $stream = $null
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    $lines = New-Object System.Collections.ArrayList
    foreach ($line in $result.Lines) {
      $x1 = [double]::MaxValue; $y1 = [double]::MaxValue; $x2 = 0.0; $y2 = 0.0
      foreach ($w in $line.Words) {
        $r = $w.BoundingRect
        if ($r.X -lt $x1) { $x1 = $r.X }
        if ($r.Y -lt $y1) { $y1 = $r.Y }
        if (($r.X + $r.Width) -gt $x2) { $x2 = $r.X + $r.Width }
        if (($r.Y + $r.Height) -gt $y2) { $y2 = $r.Y + $r.Height }
      }
      $null = $lines.Add(@{ t = $line.Text; x = [int]$x1; y = [int]$y1; w = [int]($x2 - $x1); h = [int]($y2 - $y1) })
    }
    [Console]::Out.WriteLine('OCR ' + (ConvertTo-Json -InputObject @{ lines = $lines } -Compress -Depth 4))
  } catch {
    [Console]::Out.WriteLine('ERR ' + ($_.Exception.Message -replace '\s+', ' '))
  } finally {
    if ($null -ne $stream) { try { ([System.IDisposable]$stream).Dispose() } catch { } }
  }
}
