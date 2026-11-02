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