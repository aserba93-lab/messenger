# Generates SF framed logo PNGs (same style as public/favicon.svg)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function Save-SfIcon {
  param([string]$Path, [int]$Size)
  $w = $Size
  $h = $Size
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::FromArgb(255, 15, 15, 18))
  $penWidth = [Math]::Max(2, [int]($w / 32))
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 46, 50, 60)), $penWidth
  $inset = [Math]::Max(4, [int]($w / 16))
  $g.DrawRectangle($pen, $inset, $inset, $w - 2 * $inset - 1, $h - 2 * $inset - 1)
  $fontSize = [Math]::Max(10, [int]($w * 0.38))
  try {
    $ff = New-Object System.Drawing.FontFamily "Segoe UI"
  } catch {
    $ff = [System.Drawing.FontFamily]::GenericSansSerif
  }
  $font = [System.Drawing.Font]::new($ff, [float]$fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 242, 243, 245))
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString("SF", $font, $brush, [System.Drawing.RectangleF]::new(0, 0, $w, $h), $sf)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  $font.Dispose()
  $brush.Dispose()
  $pen.Dispose()
}

$web = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

Save-SfIcon -Path (Join-Path $web "electron\app-icon.png") -Size 256
Save-SfIcon -Path (Join-Path $web "public\pwa-icon-512.png") -Size 512
Save-SfIcon -Path (Join-Path $web "public\pwa-icon-192.png") -Size 192
Write-Output "Wrote icons under $web"
