import type { WebSocket } from 'ws';
import type { WsEvent } from '../../shared/types';
import { nowIso, uuid } from './util';
import type { Principal } from './auth';

/**
 * Канал событий реального времени (ТЗ СЧ FR-39, раздел 7.4): доставка «не менее одного раза»,
 * подписка только на ресурсы, доступные роли.
 */
interface Client {
  socket: WebSocket;
  principal?: Principal;
  lastPing: number;
}

const clients = new Set<Client>();

export interface Audience {
  attemptId?: string;
  roomId?: string;
  ppeId?: string;
  staffWide?: boolean;
}

function matches(c: Client, type: WsEvent['type'], aud: Audience): boolean {
  const p = c.principal;
  if (!p) return false;
  if (p.kind === 'participant') {
    if (['room.started', 'room.message'].includes(type)) return !!aud.roomId && p.roomId === aud.roomId;
    if (['attempt.timeChanged', 'attempt.terminated'].includes(type)) return p.attemptId === aud.attemptId;
    return false;
  }
  if (p.kind !== 'staff') return false;
  if (['participant.statusChanged', 'integrity.event', 'workstation.checked', 'auth.lockout'].includes(type)) {
    if (p.roles.includes('observer') || p.roles.includes('admin')) return true;
    if (p.roles.includes('organizer')) return !!aud.roomId && (p.roomIds ?? []).includes(aud.roomId);
  }
  return false;
}

export function emit<T>(type: WsEvent['type'], resourceId: string, data: T, aud: Audience) {
  const ev: WsEvent<T> = { eventId: uuid(), type, occurredAt: nowIso(), resourceId, data };
  const msg = JSON.stringify({ type: 'event', event: ev });
  for (const c of clients) {
    if (matches(c, type, aud) && c.socket.readyState === 1) c.socket.send(msg);
  }
}

export function registerSocket(
  socket: WebSocket,
  authenticate: (token: string) => Promise<Principal | undefined>,
  onPing?: (p: Principal) => void,
) {
  const client: Client = { socket, lastPing: Date.now() };
  clients.add(client);
  const authTimer = setTimeout(() => {
    if (!client.principal) socket.close(4401, 'auth timeout');
  }, 10_000);
  socket.on('message', async (raw) => {
    let msg: { type?: string; token?: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    client.lastPing = Date.now();
    if (msg.type === 'auth' && msg.token) {
      const p = await authenticate(msg.token);
      if (!p) return socket.close(4401, 'unauthorized');
      // У сеанса участника одно соединение: новое закрывает прежнее.
      if (p.kind === 'participant') {
        for (const c of clients) if (c !== client && c.principal?.attemptId === p.attemptId) c.socket.close(4000, 'replaced');
      }
      client.principal = p;
      clearTimeout(authTimer);
      socket.send(JSON.stringify({ type: 'ready', serverTime: nowIso() }));
    } else if (msg.type === 'ping') {
      if (client.principal) onPing?.(client.principal);
      socket.send(JSON.stringify({ type: 'pong', serverTime: nowIso() }));
    }
  });
  socket.on('close', () => {
    clearTimeout(authTimer);
    clients.delete(client);
  });
}
setInterval(() => {
  const now = Date.now();
  for (const c of clients) if (now - c.lastPing > 60_000) c.socket.close(4408, 'idle');
}, 15_000).unref();

export const wsStats = () => ({ connections: clients.size });