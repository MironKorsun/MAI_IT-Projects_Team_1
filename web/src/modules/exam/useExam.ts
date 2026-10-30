import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttemptStateDto, VariantContent, WorkstationCheck, WsEvent } from '../../../../shared/types';
import { FINAL_STATES } from '../../../../shared/types';
import { ApiError, NetworkError, examApi, uuid } from '../../lib/api';
import { EventChannel } from '../../lib/ws';
import { decryptVariant, type KimPackage } from './crypto';
import { loadSnapshot, saveSnapshot, wipe, type QueueItem } from './secureQueue';

/**
 * Движок модуля М1 «Экзамен»: машина состояний попытки (таблица 5.2 ТЗ КЧ), серверное время,
 * очередь сохранения с идемпотентностью и seq, работа без связи, контроль целостности.
 */

export type Phase = 'boot' | 'check' | 'login' | 'brief' | 'loading' | 'exam' | 'final' | 'fatal';

export interface WorkstationInfo {
  workstationId: string;
  label: string;
  room: { id: string; number: string; ppeCode: string; ppeName: string; tz: string };
  session: { title: string; date: string; startLocal: string; proctoring: boolean };
  check?: { passed: boolean; at: string };
}

export interface CheckItem {
  id: keyof Omit<WorkstationCheck, 'passed'>;
  label: string;
  status: 'pending' | 'ok' | 'fail';
  detail?: string;
  help?: string;
  required: boolean;
}

interface LocalAnswer {
  kind: 'short';
  value: string;
  seq: number;
  changedAt: string;
  key: string;
}

const AUTOSAVE_MS = 30_000;
/** Отправка ответа после паузы во вводе: индикатор «Сохраняется…» не висит до автосохранения */
const ANSWER_DEBOUNCE_MS = 2_000;
const LOCAL_MS = 1_500;
const EVENTS_MS = 10_000;
const OFFLINE_AFTER_MS = 10_000;

function jwtClaims(token?: string): { attemptId?: string } {
  try {
    return JSON.parse(atob(token!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

function detectBrowser(): { ok: boolean; name: string } {
  const ua = navigator.userAgent;
  const chrome = /Chrom(e|ium)\/(\d+)/.exec(ua);
  const ff = /Firefox\/(\d+)/.exec(ua);
  if (/YaBrowser/.test(ua)) return { ok: true, name: 'Яндекс Браузер' };
  if (chrome) return { ok: Number(chrome[2]) >= 120, name: `Chromium ${chrome[2]}` };
  if (ff) return { ok: Number(ff[1]) >= 128, name: `Firefox ${ff[1]}` };
  return { ok: false, name: 'Неподдерживаемый браузер' };
}

export function useExam(secret: string | null) {
  const [phase, setPhase] = useState<Phase>('boot');
  const [ws, setWs] = useState<WorkstationInfo>();
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [state, setState] = useState<AttemptStateDto>();
  const [variant, setVariant] = useState<VariantContent>();
  const [currentId, setCurrentId] = useState<string>();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState<string[]>([]);
  const [online, setOnline] = useState(true);
  const [savedAt, setSavedAt] = useState<string>();
  const [pendingCount, setPendingCount] = useState(0);
  // задания, чьи ответы ещё не подтверждены сервером (для отметки «Ответ сохранён» и сетки заданий)
  const [dirtyIds, setDirtyIds] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState<{ id: string; text: string; tone: 'info' | 'warn' }>();
  const [messages, setMessages] = useState<{ id: string; text: string; at: string }[]>([]);
  const [fatal, setFatal] = useState<string>();
  const [loginError, setLoginError] = useState<string>();
  const [loadingStep, setLoadingStep] = useState('');

    const pkgRef = useRef<KimPackage>();
  const offsetRef = useRef(0);
  const seqRef = useRef(0);
  const dirty = useRef(new Map<string, LocalAnswer>());
  const versions = useRef(new Map<string, number>());
  const queueRef = useRef<QueueItem[]>([]);
  const flushing = useRef(false);
  const flushStarted = useRef(0);
  const flushAgain = useRef(false);
  const pending = () => dirty.current.size + queueRef.current.filter((q) => q.type === 'note').length;
  const syncPending = () => {
    setPendingCount(pending());
    setDirtyIds([...dirty.current.keys()]);
  };
  const flushRef = useRef<() => Promise<boolean>>();
  const lastOk = useRef(Date.now());
  const eventsBuf = useRef<{ type: string; at: string }[]>([]);
  const stateRef = useRef<AttemptStateDto>();
  const answersRef = useRef<Record<string, string>>({});
  const notesRef = useRef<Record<string, string>>({});
  const expiredHandled = useRef(false);
  stateRef.current = state;
  answersRef.current = answers;
  notesRef.current = notes;

    const wsHeaders = useMemo(() => (secret ? { 'x-workstation-secret': secret } : undefined), [secret]);
  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);
  const serverIso = useCallback(() => new Date(serverNow()).toISOString(), [serverNow]);

  // ---------- серверное время (FR-05): смещение с поправкой на половину RTT ----------
  const fetchState = useCallback(async (attemptId: string) => {
    const t0 = performance.now();
    const s = await examApi.get<AttemptStateDto>(`/attempts/${attemptId}/state`, { retries: 1 });
    const rtt = performance.now() - t0;
    offsetRef.current = new Date(s.serverTime).getTime() + rtt / 2 - Date.now();
    seqRef.current = Math.max(seqRef.current, s.lastSeq);
    for (const [k, v] of Object.entries(s.answers)) versions.current.set(k, v.version);
    lastOk.current = Date.now();
    setOnline(true);
    setState(s);
    setMessages(s.messages);
    return s;
  }, []);

    // ---------- локальная копия (NFR-10: не реже 1 раза в 2 с) ----------
  const persistLocal = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    const snapAnswers: Record<string, { kind: 'short'; value: string; seq: number }> = {};
    for (const [k, v] of dirty.current) snapAnswers[k] = { kind: v.kind, value: v.value, seq: v.seq };
    void saveSnapshot({ attemptId: s.attemptId, answers: snapAnswers, notes: notesRef.current, queue: queueRef.current, seq: seqRef.current, savedAt: Date.now() });
  }, []);

    // ---------- отправка очереди (FR-10, FR-11) ----------
  const flush = useCallback(async (): Promise<boolean> => {
    const s = stateRef.current;
    if (!s) return dirty.current.size === 0;
    if (flushing.current) {
      // изменение пришло во время отправки — повторить сразу после неё
      flushAgain.current = true;
      return false;
    }
    flushing.current = true;
    flushAgain.current = false;
    flushStarted.current = Date.now();

        try {
      const items = [...dirty.current.entries()].sort((a, b) => a[1].seq - b[1].seq);
      for (const [taskId, a] of items) {
        const v = versions.current.get(taskId);
        try {
          const res = await examApi.put<{ version: number; savedAt: string; status: string }>(
            `/attempts/${s.attemptId}/answers/${taskId}`,
            { kind: a.kind, value: a.value, seq: a.seq, changedAtServerClock: a.changedAt },
            { idempotencyKey: a.key, retries: 0, headers: v ? { 'if-match': `"v${v}"` } : undefined },
          );
          versions.current.set(taskId, res.version);
          if (dirty.current.get(taskId)?.seq === a.seq) dirty.current.delete(taskId);
          setSavedAt(res.savedAt);
          lastOk.current = Date.now();
          setOnline(true);

                  } catch (e) {
          if (e instanceof ApiError && e.status === 412) {
            // Автор ответа один: берём текущую версию и применяем локальное изменение поверх неё (7.5 ТЗ КЧ)
            versions.current.set(taskId, (e.problem as { currentVersion?: number }).currentVersion ?? 0);
            a.key = uuid();
            continue;
          }
          if (e instanceof ApiError && e.status === 409) {
            dirty.current.clear();
            await fetchState(s.attemptId).catch(() => undefined);
            return false;
          }
          if (e instanceof ApiError && e.status === 401) return false;
          if (e instanceof ApiError && e.status < 500 && e.status !== 429) {
            dirty.current.delete(taskId);
            continue;
          }
          setOnline(false);
          return false;
        }
      }

            // заметки и служебные операции
      const q = [...queueRef.current];
      for (const item of q) {
        try {
          if (item.type === 'note') await examApi.put(`/attempts/${s.attemptId}/notes/${item.taskId}`, { text: item.value }, { idempotencyKey: item.idempotencyKey, retries: 0 });
          else if (item.type === 'ui') await examApi.patch(`/attempts/${s.attemptId}/ui`, item.payload, { idempotencyKey: item.idempotencyKey, retries: 0 });
          else if (item.type === 'events') await examApi.post(`/attempts/${s.attemptId}/events`, item.payload, { idempotencyKey: item.idempotencyKey, retries: 0 });
          queueRef.current = queueRef.current.filter((x) => x.id !== item.id);
          lastOk.current = Date.now();
          setOnline(true);
        } catch (e) {
          if (e instanceof NetworkError || (e instanceof ApiError && e.status >= 500) || (e instanceof ApiError && e.status === 429)) {
            setOnline(false);
            return false;
          }
          queueRef.current = queueRef.current.filter((x) => x.id !== item.id);
        }
      }
      return dirty.current.size === 0;
    } finally {
      flushing.current = false;
      syncPending();
      persistLocal();
      if (flushAgain.current) setTimeout(() => void flushRef.current?.(), 0);
    }
  }, [fetchState, persistLocal]);
  flushRef.current = flush;

    // ---------- КИМ: ключ, расшифровка, готовность (FR-04) ----------
  const ensurePackage = useCallback(
    async (roomId: string) => {
      if (pkgRef.current) return pkgRef.current;
      pkgRef.current = await examApi.get<KimPackage>(`/rooms/${roomId}/kim-package`, { headers: wsHeaders, retries: 5, timeoutMs: 60_000 });
      return pkgRef.current;
    },
    [wsHeaders],
  );

  const openVariant = useCallback(
    async (s: AttemptStateDto) => {
      setLoadingStep('Получение ключа варианта…');
      const pkg = await ensurePackage(s.room.id);
      const key = await examApi.get<{ variantId: string; key: string }>(`/attempts/${s.attemptId}/kim-key`, { retries: 3 });
      setLoadingStep('Расшифровка заданий…');
      const v = await decryptVariant(pkg, key.variantId, key.key);
      setVariant(v);
      return v;
    },
    [ensurePackage],
  );

  