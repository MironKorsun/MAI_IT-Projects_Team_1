# Создание секретов развёртывания в Windows (PowerShell). Пароли запрашиваются у оператора,
# сохраняются только в deploy\secrets (каталог не попадает в git и в образ).
# Запуск из корня проекта:  powershell -ExecutionPolicy Bypass -File deploy\init-secrets.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $PSScriptRoot 'secrets'
New-Item -ItemType Directory -Force (Join-Path $dir 'tls') | Out-Null
if (-not (Test-Path (Join-Path $root '.env'))) { Copy-Item (Join-Path $root '.env.example') (Join-Path $root '.env') }

function Save($name, $value) { [IO.File]::WriteAllText((Join-Path $dir $name), $value) }
function Plain($secure) { [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)) }
function Ask($prompt, $min) {
  while ($true) {
    $a = Plain (Read-Host "$prompt (не короче $min символов)" -AsSecureString)
    $b = Plain (Read-Host 'Повторите' -AsSecureString)
    if ($a -ne $b) { Write-Host 'Не совпадает, ещё раз.'; continue }
    if ($a.Length -lt $min) { Write-Host 'Слишком короткий.'; continue }
    return $a
  }
}

if (Test-Path (Join-Path $dir 'database_url')) { Write-Host 'Секреты уже созданы (deploy\secrets). Удалите каталог, чтобы создать заново.'; exit 0 }

$admin = Ask 'Пароль администратора системы (логин admin)' 12
$pg = Ask 'Пароль базы данных PostgreSQL' 12
$analyst = Ask 'Пароль аналитика БД (ege_analyst, только чтение)' 12
Save 'admin_password' $admin
Save 'postgres_password' $pg
Save 'analyst_db_password' $analyst
Save 'database_url' ("postgres://ege:{0}@db:5432/ege" -f [Uri]::EscapeDataString($pg))
$key = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($key)
Save 'kim_master_key' (-join ($key | ForEach-Object { '{0:x2}' -f $_ }))

Write-Host 'Создаю сертификат стенда (через Docker)...'
docker run --rm -v "${dir}\tls:/tls" alpine/openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj '/CN=localhost' `
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -keyout /tls/server.key -out /tls/server.crt
Write-Host 'Готово. Запуск: docker compose up -d --build, затем https://localhost (логин admin).'
