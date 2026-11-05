#!/bin/sh
# Роль аналитиков только для чтения витрин схемы analytics (ТЗ СЧ FR-51, ТЗ АО 6.4).
# Выполняется один раз при инициализации тома PostgreSQL; права на витрины выдаёт миграция приложения.
set -eu
PW=$(cat "$ANALYST_DB_PASSWORD_FILE")
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE ege_analyst LOGIN PASSWORD '$PW' NOSUPERUSER NOCREATEDB NOCREATEROLE;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO ege_analyst;
SQL
