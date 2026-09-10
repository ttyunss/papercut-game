$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$root = "C:\Users\ASUS\.codely\Default\papercut-game"
$dir = "$root\shots"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$prof = "$env:TEMP\edge-profile-v2"
$page = "file:///" + ($root -replace '\\','/') + "/index.html"
$v = Get-Random

# warmup: 写入 localStorage 访问标记(避免首次帮助弹窗遮挡)
& $edge --headless=new --disable-gpu --user-data-dir="$prof" --window-size=1380,860 --virtual-time-budget=3000 --screenshot="$env:TEMP\warmup2.png" "$page`?v=$v" 2>$null | Out-Null
Write-Output "warmup done"

$targets = @(
  @{ n = "title";   h = "" },
  @{ n = "menu";    h = "#menu" },
  @{ n = "story";   h = "#story" },
  @{ n = "levels";  h = "" },
  @{ n = "cut2-fold";   h = "#cut=2" },
  @{ n = "cut2-cut";    h = "#cut=2:cut" },
  @{ n = "cut2-unfold"; h = "#cut=2:unfold" },
  @{ n = "cut3-fold";   h = "#cut=3" },
  @{ n = "cut3-cut";    h = "#cut=3:cut" },
  @{ n = "cut3-unfold"; h = "#cut=3:unfold" },
  @{ n = "free";    h = "#free" },
  @{ n = "puzzle1"; h = "#patterns=1" }
)

foreach ($t in $targets) {
  $out = "$dir\$($t.n).png"
  & $edge --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$prof" --window-size=1380,860 --virtual-time-budget=6000 --screenshot="$out" "$page`?v=$v$($t.h)" 2>$null | Out-Null
  if (Test-Path $out) { Write-Output "OK  $($t.n)" } else { Write-Output "FAIL $($t.n)" }
}
