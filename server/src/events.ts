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