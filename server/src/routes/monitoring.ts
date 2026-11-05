import type { FastifyInstance } from 'fastify';
import type { AuditEventDto } from '../../../shared/types';
import { db, byId, type AuditEvent } from '../db';
import { requireStaff } from '../auth';
import { audit, verifyChain } from '../audit';
import { sessionTitle } from '../views';
import { wsStats } from '../events';

/** Компонент С5 «События» для модуля М5 (ТЗ СЧ FR-40–FR-42). */

function toDto(e: AuditEvent): AuditEventDto {
  return {
    id: e.id,
    type: e.type,
    category: e.category,
    at: e.at,
    actorRole: e.actorRole,
    actorId: e.actorId ? e.actorId.slice(0, 8) : undefined,
    object: e.object,
    ppeCode: byId(db.ppes, e.ppeId)?.code,
    roomNumber: byId(db.rooms, e.roomId)?.number,
    requestId: e.requestId,
    result: e.result,
    details: e.details,
    hash: e.hash,
  };
}

interface Filter { ppe?: string; room?: string; category?: string; type?: string; from?: string; to?: string; cursor?: string; limit?: number }

function filtered(q: Filter) {
  return db.audit.filter((e) => {
    if (q.ppe && byId(db.ppes, e.ppeId)?.code !== q.ppe) return false;
    if (q.room && e.roomId !== q.room) return false;
    if (q.category && e.category !== q.category) return false;
    if (q.type && !e.type.startsWith(q.type)) return false;
    if (q.from && e.at < q.from) return false;
    if (q.to && e.at > q.to) return false;
    return true;
  });
}

export default async function monitoringRoutes(app: FastifyInstance) {
  const observer = { preHandler: requireStaff('observer', 'admin') };

  /** Сводные показатели по ППЭ и аудиториям (FR-42). */
  app.get('/monitoring/summary', observer, async () => {
    const ppes = db.ppes.map((ppe) => {
      const rooms = db.rooms
        .filter((r) => r.ppeId === ppe.id)
        .filter((r) => byId(db.sessions, r.sessionId)?.status !== 'completed')
        .map((r) => {
          const attempts = db.attempts.filter((a) => a.roomId === r.id);
          const states: Record<string, number> = {};
          for (const a of attempts) states[a.state] = (states[a.state] ?? 0) + 1;
          const session = byId(db.sessions, r.sessionId)!;
          return {
            id: r.id,
            number: r.number,
            session: sessionTitle(session),
            startedAt: r.startedAt,
            states,
            participants: attempts.length,
            integrity: attempts.reduce((s, a) => s + a.integrity.length, 0),
            incidents: attempts.filter((a) => a.incident).length,
            offline: attempts.filter((a) => a.state === 'inProgress' && (!a.lastSeenAt || Date.now() - new Date(a.lastSeenAt).getTime() > 60_000)).length,
          };
        });
      return { id: ppe.id, code: ppe.code, name: ppe.name, region: ppe.region, tz: ppe.tz, rooms };
    });
    const timeline: { minute: string; count: number }[] = [];
    const since = Date.now() - 60 * 60_000;
    const buckets = new Map<string, number>();
    for (const e of db.audit) {
      if (e.category !== 'Целостность' || new Date(e.at).getTime() < since) continue;
      const m = e.at.slice(0, 16);
      buckets.set(m, (buckets.get(m) ?? 0) + 1);
    }
    for (let t = since; t <= Date.now(); t += 5 * 60_000) {
      const key = new Date(t).toISOString().slice(0, 16);
      let c = 0;
      for (const [k, v] of buckets) if (k >= key && k < new Date(t + 5 * 60_000).toISOString().slice(0, 16)) c += v;
      timeline.push({ minute: key, count: c });
    }
    return { generatedAt: new Date().toISOString(), ppes, timeline, connections: wsStats().connections };
  });

  /** Журнал событий с фильтрами и курсорной выборкой (FR-41). */
  app.get<{ Querystring: Filter }>('/audit-events', observer, async (req) => {
    const list = filtered(req.query).reverse();
    const start = req.query.cursor ? list.findIndex((e) => e.id === req.query.cursor) + 1 : 0;
    const limit = Math.min(Number(req.query.limit ?? 50), 100);
    const page = list.slice(start, start + limit);
    return {
      items: page.map(toDto),
      nextCursor: start + limit < list.length ? page.at(-1)?.id : undefined,
      total: list.length,
      categories: [...new Set(db.audit.map((e) => e.category))],
    };
  });

  app.get<{ Querystring: Filter }>('/audit-events/export', observer, async (req, reply) => {
    const rows = ['time;category;type;actor_role;object;ppe;room;result;request_id;hash'];
    for (const e of filtered(req.query).map(toDto))
      rows.push([e.at, e.category, e.type, e.actorRole, e.object ?? '', e.ppeCode ?? '', e.roomNumber ?? '', e.result, e.requestId ?? '', e.hash].map((v) => String(v).replace(/;/g, ',')).join(';'));
    audit({ type: 'data.exported', category: 'Администрирование', actorRole: 'observer', actorId: req.principal!.sub, object: 'audit-events' });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="audit-events.csv"')
      .send('﻿' + rows.join('\n') + '\n');
  });

  app.get('/audit-events/verify', observer, async () => ({ ...verifyChain(), records: db.audit.length }));
}
