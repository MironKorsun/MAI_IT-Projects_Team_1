import type { WsEvent } from '../../../shared/types';
import type { ApiClient } from './api';

/**
 * Канал событий реального времени (ТЗ КЧ 7.4): контрольное сообщение каждые 25 с, обрыв — 10 с без ответа,
 * переподключение со случайной задержкой 0–10 с (NFR-32), повторные eventId игнорируются,
 * после переподключения — запрос актуального состояния через REST.
 */
export class EventChannel {
  private ws?: WebSocket;
  private seen = new Set<string>();
  private pingTimer?: number;
  private pongTimer?: number;
  private reconnectTimer?: number;
  private closed = false;
  private everConnected = false;
  connected = false;

  constructor(
    private api: ApiClient,
    private handlers: {
      onEvent: (e: WsEvent) => void;
      onStatus?: (connected: boolean) => void;
      onReconnect?: () => void;
    },
  ) {}

  start() {
    this.closed = false;
    this.connect();
    return () => this.stop();
  }

  stop() {
    this.closed = true;
    this.clearTimers();
    this.ws?.close();
  }

  private clearTimers() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    clearTimeout(this.reconnectTimer);
  }

  private setConnected(v: boolean) {
    if (this.connected === v) return;
    this.connected = v;
    this.handlers.onStatus?.(v);
  }

  private async connect() {
    if (this.closed) return;
    if (!this.api.hasToken()) await this.api.refresh();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws/v1`);
    } catch {
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.api.getToken() }));
    ws.onmessage = (m) => {
      let msg: { type: string; event?: WsEvent };
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      clearTimeout(this.pongTimer);
      if (msg.type === 'ready') {
        this.setConnected(true);
        if (this.everConnected) this.handlers.onReconnect?.();
        this.everConnected = true;
        clearInterval(this.pingTimer);
        this.pingTimer = window.setInterval(() => this.ping(), 25_000);
      } else if (msg.type === 'event' && msg.event) {
        if (this.seen.has(msg.event.eventId)) return;
        this.seen.add(msg.event.eventId);
        if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
        this.handlers.onEvent(msg.event);
      }
    };
    ws.onclose = (ev) => {
      this.setConnected(false);
      clearInterval(this.pingTimer);
      if (ev.code === 4401) this.api.refresh();
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private ping() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'ping' }));
    clearTimeout(this.pongTimer);
    this.pongTimer = window.setTimeout(() => this.ws?.close(), 10_000);
  }

  private scheduleReconnect() {
    if (this.closed) return;
    clearTimeout(this.reconnectTimer);
    const delay = this.everConnected ? Math.random() * 10_000 : 1500 + Math.random() * 2000;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }
}
