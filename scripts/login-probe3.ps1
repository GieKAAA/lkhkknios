# login-probe3.ps1 - Varian transport terakhir untuk /auth/get-token
#
# Menggunakan metode GET+query string, HTTP/1.1 paksa, dan Accept-Encoding
# ala Dart - tiga perilaku yang belum diuji di probe1/probe2.
#
# Jalankan:
#   powershell -ExecutionPolicy Bypass -File scripts\login-probe3.ps1

$ErrorActionPreference = "Stop"
$url = "https://lkh-kkn.uin-alauddin.ac.id/auth/get-token"

$nim = Read-Host "NIM"
$sec = Read-Host "Password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
if (-not $nim -or -not $password) { Write-Host "NIM/password kosong."; exit 1 }

$device = '{"version.sdkInt":28,"version.release":"9","brand":"vivo","model":"V2241A","serialNumber":"unknown","isPhysicalDevice":true}'
$qs = "username={0}&password={1}&version={2}&device_info={3}" -f `
    [uri]::EscapeDataString($nim), [uri]::EscapeDataString($password), `
    [uri]::EscapeDataString("1.1.1"), [uri]::EscapeDataString($device)

function Show-Result {
    param([string]$Label)
    $body = Get-Content "$env:TEMP\probe3-out.txt" -Raw -ErrorAction SilentlyContinue
    if ($body) { $body = $body.Substring(0, [Math]::Min(200, $body.Length)) }
    Write-Host ("[{0}]" -f $Label)
    Write-Host ("      -> {0}" -f $body)
    Write-Host ""
}

Write-Host "Menjalankan 4 varian..."
Write-Host ""

& curl.exe -s -o "$env:TEMP\probe3-out.txt" -w "" --max-time 30 `
    -H "User-Agent: Dart/3.8 (dart:io)" `
    ("{0}?{1}" -f $url, $qs)
Show-Result "1/4 GET + query string"

& curl.exe -s -o "$env:TEMP\probe3-out.txt" -w "" --max-time 30 --http1.1 `
    -H "User-Agent: Dart/3.8 (dart:io)" `
    -H "Accept-Encoding: gzip" `
    -H "Content-Type: application/json" `
    --data-binary ('{"username":"' + $nim + '","password":"' + $password + '","version":"1.1.1","device_info":' + $device + '}') `
    -X POST $url
Show-Result "2/4 POST JSON via HTTP/1.1 + Accept-Encoding gzip"

& curl.exe -s -o "$env:TEMP\probe3-out.txt" -w "" --max-time 30 `
    -H "Content-Type: application/json" `
    --data-binary ('{"username":"' + $nim + '","password":"' + $password + '","version":"1.1.1","device_info":' + $device + '}') `
    -X POST $url
Show-Result "3/4 POST JSON TANPA User-Agent Dart"

& curl.exe -s -o "$env:TEMP\probe3-out.txt" -w "" --max-time 30 `
    -H "User-Agent: Dart/3.8 (dart:io)" `
    -H "Accept-Encoding: gzip" `
    -H "Content-Type: application/x-www-form-urlencoded" `
    --data $qs -X POST $url
Show-Result "4/4 POST form urlencoded + gzip (HTTP/2)"

Write-Host "Selesai."
