-- Физическая модель данных Серверной части (ТЗ СЧ, разделы 3.3 и 5; ADR-002).
-- PostgreSQL 16. Внешние ключи отложенные: запись изменений выполняется одной транзакцией.
-- row_no сохраняет порядок вставки записей для детерминированного чтения.

CREATE TABLE ppes (
  row_no      bigserial,
  id          uuid PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  region      text NOT NULL,
  region_code text NOT NULL,
  tz          text NOT NULL
);

CREATE TABLE schools (
  row_no      bigserial,
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  region_code text NOT NULL
);

CREATE TABLE staff_users (
  row_no        bigserial,
  id            uuid PRIMARY KEY,
  login         text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  -- NFR-20: только хэш (scrypt), открытых паролей нет
  password_hash text NOT NULL,
  roles         jsonb NOT NULL,
  blocked       boolean NOT NULL DEFAULT false,
  subjects      jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL
);

-- ПДн участников (152-ФЗ): доступны только компонентам С1–С6; аналитике — через представление с псевдонимами
CREATE TABLE participants (
  row_no             bigserial,
  id                 uuid PRIMARY KEY,
  code               text NOT NULL UNIQUE,
  last_name          text NOT NULL,
  first_name         text NOT NULL,
  middle_name        text NOT NULL,
  document_number    text NOT NULL,
  birth_date         date NOT NULL,
  pin_hash           text NOT NULL DEFAULT '',
  school_id          uuid NOT NULL REFERENCES schools (id) DEFERRABLE INITIALLY DEFERRED,
  region_code        text NOT NULL,
  special_conditions jsonb NOT NULL
);

CREATE TABLE kim_variants (
  row_no      bigserial,
  id          uuid PRIMARY KEY,
  exam_code   text NOT NULL,
  number      integer NOT NULL,
  title       text NOT NULL,
  -- NFR-21: содержимое только в зашифрованном виде (AES-256-GCM), ключ варианта обёрнут мастер-ключом
  encrypted   jsonb NOT NULL,
  wrapped_key jsonb NOT NULL,
  keys        jsonb NOT NULL,
  imported_at timestamptz NOT NULL,
  checksum    text NOT NULL,
  UNIQUE (exam_code, number, checksum)
);

CREATE TABLE exam_sessions (
  row_no         bigserial,
  id             uuid PRIMARY KEY,
  exam_code      text NOT NULL,
  date           date NOT NULL,
  start_local    text NOT NULL,
  tz             text NOT NULL,
  duration_min   integer NOT NULL,
  variant_ids    jsonb NOT NULL,
  room_ids       jsonb NOT NULL,
  proctoring     boolean NOT NULL,
  status         text NOT NULL CHECK (status IN ('preparation', 'active', 'completed')),
  results_status text NOT NULL,
  created_at     timestamptz NOT NULL,
  published_at   timestamptz,
  appeal_window  jsonb,
  scale_version  text
);

CREATE TABLE rooms (
  row_no                 bigserial,
  id                     uuid PRIMARY KEY,
  session_id             uuid NOT NULL REFERENCES exam_sessions (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ppe_id                 uuid NOT NULL REFERENCES ppes (id) DEFERRABLE INITIALLY DEFERRED,
  number                 text NOT NULL,
  access_code            text,
  access_code_issued_at  timestamptz,
  started_at             timestamptz,
  organizer_ids          jsonb NOT NULL DEFAULT '[]',
  messages               jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX rooms_session_idx ON rooms (session_id);

CREATE TABLE workstations (
  row_no  bigserial,
  id      uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  label   text NOT NULL,
  secret  text NOT NULL UNIQUE,
  "check" jsonb
);
CREATE INDEX workstations_room_idx ON workstations (room_id);

CREATE TABLE attempts (
  row_no              bigserial,
  id                  uuid PRIMARY KEY,
  session_id          uuid NOT NULL REFERENCES exam_sessions (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  participant_id      uuid NOT NULL REFERENCES participants (id) DEFERRABLE INITIALLY DEFERRED,
  room_id             uuid NOT NULL REFERENCES rooms (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  workstation_id      uuid NOT NULL REFERENCES workstations (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  state               text NOT NULL,
  variant_id          uuid REFERENCES kim_variants (id) DEFERRABLE INITIALLY DEFERRED,
  logged_in_at        timestamptz,
  t0                  timestamptz,
  base_ends_at        timestamptz,
  compensation_min    integer NOT NULL DEFAULT 0,
  compensations       jsonb NOT NULL DEFAULT '[]',
  last_seq            integer NOT NULL DEFAULT 0,
  notes               jsonb NOT NULL DEFAULT '{}',
  flags               jsonb NOT NULL DEFAULT '[]',
  last_task_id        text,
  last_seen_at        timestamptz,
  last_seen_in_time   timestamptz,
  downtime_sec        double precision NOT NULL DEFAULT 0,
  finished_at         timestamptz,
  termination_message text,
  incident            jsonb,
  early_finish_reason text,
  integrity           jsonb NOT NULL DEFAULT '[]',
  ready_at            timestamptz,
  graded              boolean
);
CREATE INDEX attempts_session_idx ON attempts (session_id);
CREATE INDEX attempts_participant_idx ON attempts (participant_id);
CREATE INDEX attempts_room_idx ON attempts (room_id);

-- Версии ответов: только добавление (ТЗ СЧ FR-14–17, NFR-30: до 300 млн версий)
CREATE TABLE answer_versions (
  row_no                  bigserial,
  attempt_id              uuid NOT NULL REFERENCES attempts (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  task_id                 text NOT NULL,
  version                 integer NOT NULL,
  seq                     integer NOT NULL,
  kind                    text NOT NULL,
  value                   text NOT NULL,
  saved_at                timestamptz NOT NULL,
  changed_at_server_clock timestamptz NOT NULL,
  late                    boolean,
  PRIMARY KEY (attempt_id, task_id, version)
);

CREATE TABLE results (
  row_no        bigserial,
  attempt_id    uuid PRIMARY KEY REFERENCES attempts (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  session_id    uuid NOT NULL REFERENCES exam_sessions (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  participant_id uuid NOT NULL REFERENCES participants (id) DEFERRABLE INITIALLY DEFERRED,
  primary_score integer NOT NULL,
  max_primary   integer NOT NULL,
  test_score    integer,
  grade         integer,
  passed        boolean NOT NULL,
  tasks         jsonb NOT NULL,
  scale_version text NOT NULL,
  status        text NOT NULL CHECK (status IN ('calculated', 'approved', 'published')),
  calculated_at timestamptz NOT NULL,
  history       jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX results_session_idx ON results (session_id);

CREATE TABLE scales (
  row_no    bigserial,
  exam_code text NOT NULL,
  year      integer NOT NULL,
  version   text NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('test', 'grade')),
  "values"  jsonb NOT NULL,
  threshold double precision NOT NULL,
  loaded_at timestamptz NOT NULL,
  PRIMARY KEY (exam_code, year, version, kind)
);

CREATE TABLE appeals (
  row_no         bigserial,
  id             uuid PRIMARY KEY,
  number         text NOT NULL UNIQUE,
  participant_id uuid NOT NULL REFERENCES participants (id) DEFERRABLE INITIALLY DEFERRED,
  session_id     uuid NOT NULL REFERENCES exam_sessions (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  task_numbers   jsonb NOT NULL,
  text           text NOT NULL,
  status         text NOT NULL,
  created_at     timestamptz NOT NULL,
  history        jsonb NOT NULL DEFAULT '[]'
);

-- Журнал событий с цепочкой SHA-256 (ТЗ СЧ NFR-25): изменение и удаление записей запрещены
CREATE TABLE audit_events (
  row_no     bigserial,
  id         uuid PRIMARY KEY,
  type       text NOT NULL,
  category   text NOT NULL,
  at         timestamptz NOT NULL,
  actor_role text NOT NULL,
  actor_id   text,
  object     text,
  ppe_id     uuid,
  room_id    uuid,
  request_id text,
  result     text NOT NULL CHECK (result IN ('ok', 'error')),
  details    text,
  prev_hash  text NOT NULL,
  hash       text NOT NULL UNIQUE
);
CREATE INDEX audit_events_at_idx ON audit_events (at);

CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events: запись журнала не может быть изменена или удалена';
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

CREATE TABLE telemetry (
  row_no bigserial PRIMARY KEY,
  at     timestamptz NOT NULL,
  size   integer NOT NULL,
  kind   text NOT NULL
);

CREATE FUNCTION audit_events_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events: очистка журнала запрещена';
END $$;
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_no_truncate();

-- Аналитические витрины (ТЗ СЧ FR-51, ТЗ АО 7.4): отдельная схема, без ПДн и без идентификаторов участников.
-- Учитываются только утверждённые и опубликованные результаты. Доступ аналитиков — роль только для чтения
-- на схему analytics (создаётся при развёртывании, см. deploy/postgres/init-roles.sql).
CREATE SCHEMA analytics;

CREATE VIEW analytics.dm_exam_results AS
SELECT
  r.attempt_id      AS result_id,
  s.id              AS session_id,
  s.exam_code,
  extract(year FROM s.date)::int AS year,
  s.date            AS exam_date,
  p.region_code,
  a.variant_id,
  r.primary_score,
  r.max_primary,
  r.test_score,
  r.grade,
  r.passed,
  r.scale_version,
  r.status
FROM results r
JOIN exam_sessions s ON s.id = r.session_id
JOIN participants p ON p.id = r.participant_id
JOIN attempts a ON a.id = r.attempt_id
WHERE r.status IN ('approved', 'published');

CREATE VIEW analytics.dm_task_results AS
SELECT
  d.result_id,
  d.session_id,
  d.exam_code,
  d.year,
  d.region_code,
  t.value ->> 'taskId'               AS task_id,
  (t.value ->> 'number')::int        AS task_number,
  (t.value ->> 'score')::int         AS score,
  (t.value ->> 'maxScore')::int      AS max_score
FROM analytics.dm_exam_results d
JOIN results r ON r.attempt_id = d.result_id
CROSS JOIN LATERAL jsonb_array_elements(r.tasks) AS t (value);

CREATE VIEW analytics.dm_task_stats AS
SELECT exam_code, year, task_number, count(*) AS n,
       round(avg(score::numeric / NULLIF(max_score, 0)) * 100, 1) AS correct_rate
FROM analytics.dm_task_results
GROUP BY exam_code, year, task_number;

CREATE VIEW analytics.dm_regions AS
SELECT exam_code, year, region_code, count(*) AS n,
       round(avg(test_score), 1) AS mean_test_score,
       round(avg(passed::int) * 100, 1) AS threshold_rate
FROM analytics.dm_exam_results
GROUP BY exam_code, year, region_code;

-- Права роли аналитиков (создаётся при развёртывании): только чтение витрин
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ege_analyst') THEN
    GRANT USAGE ON SCHEMA analytics TO ege_analyst;
    GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO ege_analyst;
  END IF;
END $$;
