import { db, persist, type AuditEvent } from './db';
import { nowIso, sha256, uuid } from './util';

/**
 * Журнал событий с контролем целостности (ТЗ СЧ FR-40, NFR-25): хэш SHA-256 записи включает хэш предыдущей.
 * Приложение только дописывает журнал — операций изменения и удаления нет.
 */
export const GENESIS = '0'.repeat(64);

export function audit(e: Omit<AuditEvent, 'id' | 'at' | 'prevHash' | 'hash' | 'result'> & { result?: 'ok' | 'error' }) {
  const prevHash = db.audit.at(-1)?.hash ?? GENESIS;
  const base = { id: uuid(), at: nowIso(), result: e.result ?? 'ok', ...e, prevHash };
  const hash = sha256(prevHash + JSON.stringify({ ...base, prevHash: undefined }));
  const rec: AuditEvent = { ...base, hash } as AuditEvent;
  db.audit.push(rec);
  persist();
  return rec;
}

export function verifyChain(events: AuditEvent[] = db.audit): { ok: boolean; brokenAt?: number } {
  let prev = GENESIS;
  for (let i = 0; i < events.length; i++) {
    const { hash, ...rest } = events[i];
    if (rest.prevHash !== prev) return { ok: false, brokenAt: i };
    const expected = sha256(prev + JSON.stringify({ ...rest, prevHash: undefined }));
    if (expected !== hash) return { ok: false, brokenAt: i };
    prev = hash;
  }
  return { ok: true };
}
