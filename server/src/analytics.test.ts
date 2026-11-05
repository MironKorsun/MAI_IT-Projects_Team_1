import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.STORAGE = 'memory';
const { seedStaging } = await import('./fixtures');
const { buildApp } = await import('./app');
const dbm = await import('./db');

const STAFF_PASSWORD = 'test-staff-password-2026';
seedStaging({ staffPassword: STAFF_PASSWORD, participantPin: '123456', accessCode: '482915' });
const app = await buildApp();

async function staff(login: string) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/staff/login', payload: { login, password: STAFF_PASSWORD } });
  assert.equal(r.statusCode, 200);
  return { authorization: `Bearer ${r.json().accessToken}` };
}

const analyst = await staff('analyst');
const overview = async () => (await app.inject({ method: 'GET', url: '/api/v1/analytics/overview', headers: analyst })).json();

test('сводка: есть записи, среднее и медиана в 0–100, доля порога в 0–100', async () => {
  const { summary } = await overview();
  assert.ok(summary.count > 0);
  for (const k of ['mean', 'median', 'min', 'max'] as const) assert.ok(summary[k] >= 0 && summary[k] <= 100, k);
  assert.ok(summary.thresholdRate >= 0 && summary.thresholdRate <= 100);
});

test('гистограмма: сумма столбцов равна числу результатов', async () => {
  const d = await overview();
  assert.equal(d.distribution.length, 10);
  assert.equal(d.distribution.reduce((s: number, b: { count: number }) => s + b.count, 0), d.summary.count);
});

test('статистика заданий: 12 заданий, процент выполнения в 0–100', async () => {
  const { tasks } = await overview();
  assert.equal(tasks.length, 12);
  assert.deepEqual(tasks.map((t: { number: number }) => t.number), Array.from({ length: 12 }, (_, i) => i + 1));
  for (const t of tasks) assert.ok(t.correctRate >= 0 && t.correctRate <= 100, `задание ${t.number}`);
});

test('воспроизводимость: два расчёта дают одинаковые версию набора и показатели', async () => {
  const a = await overview();
  const b = await overview();
  assert.equal(a.meta.datasetVersion, b.meta.datasetVersion);
  assert.deepEqual(a.summary, b.summary);
  assert.deepEqual(a.tasks, b.tasks);
  assert.deepEqual(a.distribution, b.distribution);
});

test('доступ: без токена 401, организатор 403, аналитик 200', async () => {
  for (const url of ['/api/v1/analytics/overview', '/api/v1/analytics/export?set=task_statistics']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url, headers: await staff('org1') })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url, headers: analyst })).statusCode, 200);
  }
});

test('выгрузка CSV: BOM, заголовок с «;», 12 строк заданий и строка dataset', async () => {
  const d = await overview();
  const r = await app.inject({ method: 'GET', url: '/api/v1/analytics/export?set=task_statistics', headers: analyst });
  assert.match(String(r.headers['content-type']), /text\/csv/);
  assert.ok(r.body.startsWith('﻿'));
  const lines = r.body.slice(1).trimEnd().split('\n');
  assert.equal(lines[0], 'task;part;difficulty;max_score;correct_rate;full_rate;status');
  assert.equal(lines.length, 1 + 12 + 1);
  assert.match(lines.at(-1)!, new RegExp(`^# dataset=${d.meta.datasetVersion}; methodology=`));
});

test('выгрузка флагов и регионов: свои заголовки и строка dataset', async () => {
  for (const [set, header] of [['anomaly_flags', 'flag_id;type;object;metric;value;threshold;severity;decision'], ['regions', 'region;count;mean;median;threshold_rate']]) {
    const r = await app.inject({ method: 'GET', url: `/api/v1/analytics/export?set=${set}`, headers: analyst });
    const lines = r.body.slice(1).trimEnd().split('\n');
    assert.equal(lines[0], header);
    assert.ok(lines.at(-1)!.startsWith('# dataset='));
  }
});

test('персональные данные: в ответах нет фамилий, имён и кодов участников', async () => {
  const bodies = [
    (await app.inject({ method: 'GET', url: '/api/v1/analytics/overview', headers: analyst })).body,
    ...(await Promise.all(['task_statistics', 'anomaly_flags', 'regions'].map((s) => app.inject({ method: 'GET', url: `/api/v1/analytics/export?set=${s}`, headers: analyst })))).map((r) => r.body),
  ];
  assert.ok(dbm.db.participants.length > 0);
  for (const body of bodies)
    for (const p of dbm.db.participants) {
      assert.ok(!body.includes(p.lastName), `фамилия ${p.lastName}`);
      assert.ok(!body.includes(p.code), `код ${p.code}`);
    }
});
