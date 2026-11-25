import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, zipSync } from 'fflate';
import type { VariantContent } from '../../../shared/types';
import { buildApp } from '../app';
import { db } from '../db';
import { seedStaging } from '../fixtures';
import { localDate } from '../routes/exam';
import { uuid, sha256 } from '../util';
import { buildBankSelection, kimBank } from './bank';
import { open } from './crypto';
import { readKimArchive } from './package';

const password = 'test-staff-password-2026';
const demo = kimBank().info.demo;

test('экспорт № 666 проходит обратный импорт, сохраняет SVG и ссылки на формулы', async () => {
  const selection = buildBankSelection(demo);
  const result = await readKimArchive(selection.archive());
  assert.equal(result.variant.variant, 666);
  assert.equal(result.variant.tasks.length, 12);
  assert.equal(result.images.size, 4);
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].latex?.length, 4);
  assert.doesNotMatch(JSON.stringify(selection.preview), /"correct"/);
  assert.equal(result.digest, (await readKimArchive(selection.archive())).digest);
});

test('валидация отклоняет отсутствующий чертёж, подмену файла и неверную позицию', async () => {
  const archive = buildBankSelection(demo).archive();
  const files = unzipSync(archive);
  const name = Object.keys(files).find(f => f.startsWith('media/'))!;
  const tampered = { ...files, [name]: Buffer.from('изменённый рисунок') };
  await assert.rejects(readKimArchive(Buffer.from(zipSync(tampered))), /IMPORT_INVALID/);
  delete files[name];
  await assert.rejects(readKimArchive(Buffer.from(zipSync(files))), /IMPORT_INVALID/);
  assert.throws(() => buildBankSelection({ ...demo, taskIds: [...demo.taskIds].reverse() }), /IMPORT_INVALID/);
});

test('пакет № 666 проходит назначение, выдачу, оценивание и попадает в аналитическую выборку', async (t) => {
  seedStaging({ staffPassword: password, participantPin: '123456' });
  const app = await buildApp();
  t.after(() => app.close());

  async function auth(login: string) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/staff/login', payload: { login, password } });
    assert.equal(res.statusCode, 200, res.body);
    return { authorization: `Bearer ${res.json().accessToken}` };
  }

  const admin = await auth('admin');
  const observer = await auth('observer');
  const catalog = await app.inject({ method: 'GET', url: '/api/v1/kim/editor', headers: observer });
  assert.equal(catalog.json().taskCount, 6000);
  const blocked = await app.inject({ method: 'POST', url: '/api/v1/kim/editor/export', headers: observer, payload: demo });
  assert.equal(blocked.statusCode, 403);
  const download = await app.inject({ method: 'POST', url: '/api/v1/kim/editor/export', headers: admin, payload: demo });
  assert.equal(download.statusCode, 200, download.body.slice(0, 500));
  assert.equal(download.headers['x-checksum-sha256'], sha256(download.rawPayload));
  const payload = { archive: download.rawPayload.toString('base64') };
  const checked = await app.inject({ method: 'POST', url: '/api/v1/kim/packages/validate', headers: admin, payload });
  assert.equal(checked.json().valid, true);
  const imports = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/v1/kim/packages/imports', headers: admin, payload })));
  assert.ok(imports.every(r => r.statusCode === 200));
  assert.equal(imports[0].json().id, imports[1].json().id);
  assert.equal(db.variants.filter(v => v.number === 666).length, 1);
  const alternate = { ...demo, taskIds: ['v2-01', ...demo.taskIds.slice(1)] };
  const conflict = await app.inject({
    method: 'POST', url: '/api/v1/kim/packages/imports', headers: admin,
    payload: { archive: buildBankSelection(alternate).archive().toString('base64') },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().code, 'VERSION_MISMATCH');
  const revised = await app.inject({
    method: 'POST', url: '/api/v1/kim/packages/imports', headers: admin,
    payload: { archive: buildBankSelection({ ...alternate, version: '1.0.1' }).archive().toString('base64') },
  });
  assert.equal(revised.statusCode, 200, revised.body);
  assert.equal(revised.json().version, '1.0.1');


  const variant = db.variants.find(v => v.number === 666)!;
  const ppe = db.ppes[0];
  const date = localDate(ppe.tz);
  const year = Number(date.slice(0, 4));
  const orgId = db.staff.find(s => s.login === 'org1')!.id;
  const oldScale = db.scales.find(s => s.examCode === 'math-profile')!;
  if (oldScale.year !== year) db.scales.push({ ...oldScale, year });
  const draft = {
    examCode: variant.examCode, date, startLocal: '10:00', variantIds: [variant.id], proctoring: false,
    rooms: [{ ppeId: ppe.id, number: '666', seats: 1, organizerIds: [orgId] }],
  };
  const noScale = await app.inject({ method: 'POST', url: '/api/v1/exam-sessions', headers: admin, payload: draft });
  assert.equal(noScale.statusCode, 422);
  const created = await app.inject({
    method: 'POST', url: '/api/v1/exam-sessions', headers: admin, payload: { ...draft, scaleVersion: oldScale.version },
  });
  assert.equal(created.statusCode, 200, created.body);
  const session = created.json();
  const room = session.rooms[0];
  const participant = db.participants.find(p => !db.attempts.some(a => a.participantId === p.id && db.sessions.find(s => s.id === a.sessionId)?.date === date))!;
  assert.ok(participant);
  const allocation = await app.inject({
    method: 'POST', url: `/api/v1/exam-sessions/${session.id}/allocation/validate`, headers: admin,
    payload: { csv: `${participant.code};${ppe.code};666;1` },
  });
  const { validationId, hash } = allocation.json();
  assert.ok(validationId, allocation.body);
  const applied = await app.inject({
    method: 'POST', url: `/api/v1/exam-sessions/${session.id}/allocation`, headers: admin, payload: { validationId, hash },
  });
  assert.equal(applied.json().applied, 1);
  const org = await auth('org1');
  const access = await app.inject({ method: 'POST', url: `/api/v1/rooms/${room.id}/access-code`, headers: org });
  assert.equal(access.statusCode, 200, access.body);
  const workstationSecret = db.workstations.find(w => w.roomId === room.id)!.secret;
  const login = await app.inject({
    method: 'POST', url: '/api/v1/auth/participant/login',
    payload: { participantCode: participant.code, accessCode: access.json().accessCode, workstationSecret },
  });
  assert.equal(login.statusCode, 200, login.body);
  const { accessToken, attemptId } = login.json();
  const headers = { authorization: `Bearer ${accessToken}` };
  const attempt = `/api/v1/attempts/${attemptId}`;
  const instruction = await app.inject({ method: 'GET', url: `${attempt}/state`, headers });
  assert.match(instruction.json().instruction, /Черновик/);
  const beforeStart = await app.inject({ method: 'GET', url: `${attempt}/kim-key`, headers });
  assert.equal(beforeStart.statusCode, 403);
  const sealed = await app.inject({
    method: 'GET', url: `/api/v1/rooms/${room.id}/kim-package`, headers: { 'x-workstation-secret': workstationSecret },
  });
  assert.equal(sealed.statusCode, 200);
  assert.doesNotMatch(sealed.body, /imageData|correct/);
  await app.inject({ method: 'POST', url: `/api/v1/rooms/${room.id}/start`, headers: org });
  const issued = await app.inject({ method: 'GET', url: `${attempt}/kim-key`, headers });
  assert.equal(issued.statusCode, 200, issued.body);
  const plain = open(Buffer.from(issued.json().key, 'base64'), sealed.json().variants[0]).toString('utf8');
  assert.doesNotMatch(plain, /"correct"/);
  const content = JSON.parse(plain) as VariantContent;
  assert.equal(content.tasks.filter(task => task.imageData).length, 4);
  const changed = () => ({ ...headers, 'idempotency-key': uuid() });
  const ready = await app.inject({ method: 'POST', url: `${attempt}/ready`, headers: changed(), payload: {} });
  assert.equal(ready.json().state, 'inProgress');
  const task = variant.keys.find(k => k.format === 'decimal' && k.correct![0].values[0].includes('.'))!;
  const answer = await app.inject({
    method: 'PUT', url: `${attempt}/answers/${task.id}`, headers: changed(),
    payload: { kind: 'short', seq: 1, value: task.correct![0].values[0].replace('.', ','), changedAtServerClock: new Date().toISOString() },
  });
  assert.equal(answer.statusCode, 200, answer.body);
  const newer = await app.inject({
    method: 'PUT', url: `/api/v1/subjects/math-profile/scales/${year}`, headers: admin,
    payload: { values: [0, 7, 15, 22, 29, 36, 43, 50, 58, 66, 74, 87, 100], threshold: 27 },
  });
  assert.equal(newer.statusCode, 200, newer.body);
  const finished = await app.inject({ method: 'POST', url: `${attempt}/finish`, headers: changed(), payload: {} });
  assert.equal(finished.json().state, 'finished');
  const result = db.results.find(r => r.attemptId === attemptId)!;
  assert.equal(result.primaryScore, 1);
  assert.equal(result.testScore, oldScale.values[1]);
  assert.equal(result.scaleVersion, oldScale.version);
  const stats = await app.inject({ method: 'GET', url: `/api/v1/analytics/overview?sessionId=${session.id}`, headers: admin });
  assert.equal(stats.statusCode, 200, stats.body);
  assert.equal(stats.json().meta.scaleVersion, oldScale.version);
});
