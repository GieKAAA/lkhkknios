# login-probe2.ps1 - Uji hipotesis JSON body di /auth/get-token
#
# Temuan dari bedah libapp.so resmi: string "x-www-form-urlencoded" TIDAK
# ada, sementara "application/json" ada dekat kluster konstanta login ->
# kemungkinan besar app resmi mengirim body JSON, dan server kini hanya
# menerima JSON (kiriman form = selalu "invalid credentials").
#
# Jalankan:
#   powershell -ExecutionPolicy Bypass -File scripts\login-probe2.ps1

$ErrorActionPreference = "Stop"
$url = "https://lkh-kkn.uin-alauddin.ac.id/auth/get-token"

$nim = Read-Host "NIM"
$sec = Read-Host "Password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
if (-not $nim -or -not $password) { Write-Host "NIM/password kosong."; exit 1 }

$fakeDevice = '{"version.sdkInt":28,"version.release":"9","brand":"vivo","model":"V2241A","serialNumber":"unknown","isPhysicalDevice":true}'

function Invoke-Variant {
    param([string]$Label, [object]$Payload, [string]$ContentType, [string]$ExtraHeader)
    $curlArgs = @("-s", "-X", "POST", $url,
        "-H", "User-Agent: Dart/3.8 (dart:io)",
        "-H", "Content-Type: $ContentType")
    if ($ExtraHeader) { $curlArgs += @("-H", $ExtraHeader) }
    if ($null -ne $Payload) {
        $bodyText = $Payload | ConvertTo-Json -Compress
        $curlArgs += @("--data-binary", $bodyText)
    }
    else {
        # varian kontrol form: kunci=nilai di-encode manual
        $curlArgs += @("--data",
            ("username={0}&password={1}" -f `
                [uri]::EscapeDataString($nim), [uri]::EscapeDataString($password)))
    }
    $out = "$env:TEMP\probe2-out.txt"
    $curlArgs += @("-o", $out, "-w", "%{http_code}", "--max-time", "30")
    & curl.exe @curlArgs | Out-Null
    $body = ""
    if (Test-Path $out) { $body = (Get-Content $out -Raw -ErrorAction SilentlyContinue) }
    if ($body) { $body = $body.Substring(0, [Math]::Min(200, $body.Length)) }
    Write-Host ("[{0}]" -f $Label)
    Write-Host ("      -> {0}" -f $body)
    Write-Host ""
}

Invoke-Variant -Label "1/5 JSON lengkap (username+password+version+device_info)" `
    -Payload (@{ username = $nim; password = $password; version = "1.1.1"; device_info = $fakeDevice }) `
    -ContentType "application/json"

Invoke-Variant -Label "2/5 JSON tanpa device_info" `
    -Payload (@{ username = $nim; password = $password; version = "1.1.1" }) `
    -ContentType "application/json"

Invoke-Variant -Label "3/5 JSON + Accept: application/json" `
    -Payload (@{ username = $nim; password = $password; version = "1.1.1"; device_info = $fakeDevice }) `
    -ContentType "application/json" `
    -ExtraHeader "Accept: application/json"

Invoke-Variant -Label "4/5 JSON versi 2.0.0" `
    -Payload (@{ username = $nim; password = $password; version = "2.0.0"; device_info = $fakeDevice }) `
    -ContentType "application/json"

Invoke-Variant -Label "5/5 kontrol: form urlencoded (harusnya gagal lagi)" `
    -Payload $null `
    -ContentType "application/x-www-form-urlencoded"

Write-Host "Selesai. Varian yang baliknya BUKAN 422/Unauthorized = arah perbaikan."
