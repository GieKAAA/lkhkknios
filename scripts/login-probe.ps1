# login-probe.ps1 - Matriks diagnosis /auth/get-token
#
# Menjalankan serangkaian varian permintaan login ke server LKH dengan
# kredensial ASLI Anda untuk menemukan varian yang diterima server.
#
#   - Kredensial diminta lewat prompt (password tidak tampil di layar),
#     dipakai hanya di memori, TIDAK disimpan ke file/history.
#   - Satu-satunya tujuan network: https://lkh-kkn.uin-alauddin.ac.id
#     (server yang sama seperti saat login biasa).
#
# Jalankan dari folder project:
#   powershell -ExecutionPolicy Bypass -File scripts\login-probe.ps1

$ErrorActionPreference = "Stop"
$url = "https://lkh-kkn.uin-alauddin.ac.id/auth/get-token"

$nim = Read-Host "NIM"
$sec = Read-Host "Password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
if (-not $nim -or -not $password) { Write-Host "NIM/password kosong."; exit 1 }

# Replika persis device_info milik app iOS (utils/deviceInfo.ts)
$fakeDevice = '{"version.sdkInt":28,"version.release":"9","version.codename":"REL","brand":"vivo","device":"marlin","model":"V2241A","product":"V2241A","type":"user","isPhysicalDevice":true,"serialNumber":"unknown"}'

function New-RandomDevice {
    # Fingerprint Android realistis yang berbeda tiap eksekusi
    $brands = @(
        @{ brand = "samsung"; model = "SM-A155F";  device = "a15xm";   sdk = 34 },
        @{ brand = "Xiaomi";  model = "23021RAAEG"; device = "sky";    sdk = 33 },
        @{ brand = "OPPO";    model = "CPH2381";   device = "OP5361";  sdk = 33 },
        @{ brand = "vivo";    model = "V2312";     device = "PD2312F"; sdk = 34 }
    )
    $b = Get-Random $brands
    $chars = (48..57) + (65..90) + (97..122)
    $serial = -join (1..12 | ForEach-Object { [char](Get-Random $chars) })
    $rel = "$($b.sdk - 7).0"
    return ('{"version.sdkInt":' + $b.sdk + ',"version.release":"' + $rel +
            '","brand":"' + $b.brand + '","device":"' + $b.device +
            '","model":"' + $b.model + '","manufacturer":"' + $b.brand +
            '","product":"' + $b.device + '","type":"user"' +
            ',"isPhysicalDevice":true,"serialNumber":"' + $serial + '"}')
}

$randomDevice = New-RandomDevice
Write-Host ""
Write-Host "[info] device_info acak untuk varian 4/6: $randomDevice"
Write-Host ""

function Invoke-Variant {
    param(
        [string]$Label,
        [ValidateSet("url", "multi")] [string]$Kind,
        [string]$DeviceInfo,
        [string]$Version
    )
    $encU = [uri]::EscapeDataString($nim)
    $encP = [uri]::EscapeDataString($password)
    $encD = [uri]::EscapeDataString($DeviceInfo)
    $out = "$env:TEMP\probe-out.txt"

    if ($Kind -eq "url") {
        & curl.exe -s -o $out -w "%{http_code}" -X POST $url `
            -H "User-Agent: Dart/3.8 (dart:io)" `
            --data "username=$encU&password=$encP&version=$Version&device_info=$encD" `
            --max-time 30 | Out-Null
    }
    else {
        & curl.exe -s -o $out -w "%{http_code}" -X POST $url `
            -H "User-Agent: Dart/3.8 (dart:io)" `
            -F "username=$nim" -F "password=$password" `
            -F "version=$Version" -F "device_info=$DeviceInfo" `
            --max-time 30 | Out-Null
    }
    $body = ""
    if (Test-Path $out) { $body = (Get-Content $out -Raw -ErrorAction SilentlyContinue) }
    if ($body) { $body = $body.Substring(0, [Math]::Min(160, $body.Length)) }
    $status = if ($LASTEXITCODE -eq 0) { "terkirim" } else { "curl-error $LASTEXITCODE" }
    Write-Host ("[{0}] {1}" -f $Label, $status)
    Write-Host ("      body: {0}" -f $body)
    Write-Host ""
}

Write-Host "Menjalankan 6 varian..." 
Write-Host ""

Invoke-Variant -Label "1/6 replika persis app iOS (multipart, vivo palsu, v1.1.1)" -Kind multi -DeviceInfo $fakeDevice -Version "1.1.1"
Invoke-Variant -Label "2/6 urlencoded, vivo palsu, v1.1.1            " -Kind url  -DeviceInfo $fakeDevice -Version "1.1.1"
Invoke-Variant -Label "3/6 urlencoded, TANPA device_info, v1.1.1   " -Kind url  -DeviceInfo ""        -Version "1.1.1"
Invoke-Variant -Label "4/6 urlencoded, device ACAK realistis, v1.1.1" -Kind url  -DeviceInfo $randomDevice -Version "1.1.1"
Invoke-Variant -Label "5/6 urlencoded, vivo palsu, v2.0.0          " -Kind url  -DeviceInfo $fakeDevice -Version "2.0.0"
Invoke-Variant -Label "6/6 multipart, device ACAK realistis, v1.1.1" -Kind multi -DeviceInfo $randomDevice -Version "1.1.1"

Write-Host "Selesai. Varian yang baliknya BUKAN 422/Unauthorized = arah perbaikan."
Write-Host "Kalau SEMUA 422 identik -> masalahnya bukan bentuk kiriman; laporkan ke panitia."
