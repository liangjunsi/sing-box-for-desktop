$ErrorActionPreference = 'Stop'
$taskRepositoryRoot = Split-Path -Parent $PSScriptRoot
$taskConfigurationPath = Join-Path $taskRepositoryRoot 'signing.local.json'
if (Test-Path -LiteralPath $taskConfigurationPath) {
    throw 'Local signing configuration already exists; keep the existing upgrade identity.'
}
$taskSigningDirectory = Join-Path $taskRepositoryRoot 'bin/signing'
New-Item -ItemType Directory -Path $taskSigningDirectory -Force | Out-Null
$taskKey = [System.Security.Cryptography.RSA]::Create(3072)
try {
    $taskRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=kukuhou Local Code Signing', $taskKey,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $taskRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $taskRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $true))
    $taskUsages = [System.Security.Cryptography.OidCollection]::new()
    $taskUsages.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3')) | Out-Null
    $taskRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($taskUsages, $false))
    $taskCertificate = $taskRequest.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddYears(5))
    try {
        $taskPassword = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
        $taskCertificatePath = Join-Path $taskSigningDirectory 'kukuhou-code-signing.pfx'
        [System.IO.File]::WriteAllBytes($taskCertificatePath, $taskCertificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $taskPassword))
        [System.IO.File]::WriteAllBytes((Join-Path $taskSigningDirectory 'kukuhou-code-signing.cer'), $taskCertificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
        @{ windows = @{ certificateFile = 'bin/signing/kukuhou-code-signing.pfx'; certificatePassword = $taskPassword } } | ConvertTo-Json | Set-Content -LiteralPath $taskConfigurationPath -Encoding utf8
        Write-Output "Created local code-signing certificate: $($taskCertificate.Thumbprint)"
        Write-Output "Expires: $($taskCertificate.NotAfter.ToString('yyyy-MM-dd'))"
    } finally {
        $taskCertificate.Dispose()
    }
} finally {
    $taskKey.Dispose()
}
