#!/bin/sh
# Создаёт секреты развёртывания в deploy/secrets (каталог не попадает в git и в образ).
# Существующие файлы не перезаписываются.
set -eu
cd "$(dirname "$0")"
[ -f ../.env ] && . ../.env
DB=${POSTGRES_DB:-ege}; USER=${POSTGRES_USER:-ege}; CN=${SERVER_NAME:-localhost}
mkdir -p secrets/tls && chmod 700 secrets
gen() { [ -f "secrets/$1" ] || { sh -c "$2" > "secrets/$1"; chmod 600 "secrets/$1"; echo "создан secrets/$1"; }; }
rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
gen postgres_password "printf %s $(rand 32)"
gen analyst_db_password "printf %s $(rand 32)"
gen kim_master_key "openssl rand -hex 32 | tr -d '\n'"
gen admin_password "printf %s $(rand 20)"
[ -f secrets/database_url ] || { printf 'postgres://%s:%s@db:5432/%s' "$USER" "$(cat secrets/postgres_password)" "$DB" > secrets/database_url; chmod 600 secrets/database_url; echo "создан secrets/database_url"; }
if [ ! -f secrets/tls/server.crt ]; then
    MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=$CN" \
    -addext "subjectAltName=DNS:$CN,DNS:localhost,IP:127.0.0.1" \
    -keyout secrets/tls/server.key -out secrets/tls/server.crt 2>/dev/null
  chmod 644 secrets/tls/server.crt secrets/tls/server.key
  echo "создан самоподписанный сертификат secrets/tls/server.crt (для стенда; в эксплуатации — сертификат УЦ)"
fi
echo "Пароль первичного администратора: deploy/secrets/admin_password"