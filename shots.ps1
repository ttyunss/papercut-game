$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$root = "C:\Users\ASUS\.codely\Default\papercut-game"
$dir = "$root\shots"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$prof = "$env:TEMP\edge-headless-profile"
$page = "file:///" + ($root -replace '\\','/') + "/index.html"
$v = Get-Random  # 防止 file:// 缓存导致截图内容过期

$targets = @(
  @{ n = "home";       h = "" },
  @{ n = "patterns1";  h = "#patterns=1" },
  @{ n = "L1-1";       h = "#preview=L1-1" },
  @{ n = "L1-2";       h = "#preview=L1-2" },
  @{ n = "L1-3";       h = "#preview=L1-3" },
  @{ n = "L2-1";       h = "#preview=L2-1" },
  @{ n = "L2-2";       h = "#preview=L2-2" },
  @{ n = "L2-3";       h = "#preview=L2-3" },
  @{ n = "L3-1";       h = "#preview=L3-1" },
  @{ n = "L3-2";       h = "#preview=L3-2" },
  @{ n = "L3-3";       h = "#preview=L3-3" }
)

foreach ($t in $targets) {
  $out = "$dir\$($t.n).png"
  & $edge --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$prof" --window-size=1380,860 --virtual-time-budget=5000 --screenshot="$out" "$page`?v=$v$($t.h)" 2>$null | Out-Null
  if (Test-Path $out) { Write-Output "OK  $($t.n)" } else { Write-Output "FAIL $($t.n)" }
}
