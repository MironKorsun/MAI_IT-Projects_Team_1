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

  const startAttempt = useCallback(
    async (s: AttemptStateDto) => {
      setPhase('loading');
      const timer = setTimeout(() => setLoadingStep('Подготовка занимает больше обычного. Организатор уведомлён.'), 60_000);
      try {
        const v = await openVariant(s);
        if (s.state === 'loading') {
          setLoadingStep('Подтверждение готовности…');
          await examApi.post(`/attempts/${s.attemptId}/ready`, {}, { idempotencyKey: uuid(), retries: 3 });
        }
        const fresh = await fetchState(s.attemptId);
        // восстановление после перезагрузки (FR-12) + локальная очередь
        const snap = await loadSnapshot(s.attemptId);
        const restored: Record<string, string> = {};
        for (const [k, a] of Object.entries(fresh.answers)) restored[k] = a.value;
        if (snap) {
          seqRef.current = Math.max(seqRef.current, snap.seq);
          for (const [k, a] of Object.entries(snap.answers)) {
            restored[k] = a.value;
            dirty.current.set(k, { kind: a.kind, value: a.value, seq: a.seq, changedAt: serverIso(), key: uuid() });
          }
          queueRef.current = snap.queue;
        }
        setAnswers(restored);
        setNotes({ ...fresh.notes, ...(snap?.notes ?? {}) });
        setFlags(fresh.flags);
        setCurrentId(fresh.lastTaskId && v.tasks.some((t) => t.id === fresh.lastTaskId) ? fresh.lastTaskId : v.tasks[0]?.id);
        setNotice(undefined);
        setPhase('exam');
        if (dirty.current.size || queueRef.current.length) void flush();
      } catch (e) {
        setFatal(e instanceof ApiError ? e.problem.detail ?? e.problem.title : 'Не удалось подготовить вариант. Сообщите организатору.');
        setPhase('fatal');
      } finally {
        clearTimeout(timer);
      }
    },
    [fetchState, flush, openVariant, serverIso],
  );

  const route = useCallback(
    (s: AttemptStateDto) => {
      if (FINAL_STATES.includes(s.state)) {
        setPhase('final');
        setTimeout(() => void wipe(), 1000);
        return;
      }
      if (s.state === 'waiting' || s.state === 'assigned') setPhase('brief');
      else if (s.state === 'loading' || s.state === 'inProgress') void startAttempt(s);
    },
    [startAttempt],
  );

  // ---------- запуск: восстановление сеанса или проверка рабочего места ----------
  useEffect(() => {
    if (!secret) {
      setPhase('fatal');
      setFatal('Этот компьютер не подготовлен как рабочее место ППЭ. Экзамен проходит только на рабочем месте, которое подготовил технический специалист.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const info = await examApi.get<WorkstationInfo>('/workstations/self', { headers: wsHeaders, retries: 2 });
        if (cancelled) return;
        setWs(info);
        if (await examApi.refresh()) {
          const { attemptId } = jwtClaims(examApi.getToken());
          if (attemptId) {
            const s = await fetchState(attemptId);
            if (!cancelled) return route(s);
          }
        }
        setPhase('check');
      } catch {
        if (!cancelled) {
          setFatal('Рабочее место не найдено. Проверьте адрес или обратитесь к техническому специалисту.');
          setPhase('fatal');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [secret, wsHeaders, fetchState, route]);

  // ---------- проверка рабочего места (FR-01) ----------
  const runChecks = useCallback(async () => {
    if (!ws) return;
    const browser = detectBrowser();
    const base: CheckItem[] = [
      { id: 'browser', label: 'Версия браузера', status: 'pending', required: true, help: 'Используйте Яндекс Браузер или Chromium 120+.' },
      { id: 'screen', label: 'Разрешение экрана', status: 'pending', required: true, help: 'Нужно не менее 1280 × 720.' },
      { id: 'fullscreen', label: 'Полноэкранный режим', status: 'pending', required: ws.session.proctoring, help: 'Разрешите полноэкранный режим в настройках браузера.' },
      { id: 'latencyMs', label: 'Отклик сервера', status: 'pending', required: true, help: 'Проверьте подключение рабочего места к сети ППЭ.' },
      { id: 'kimPreloaded', label: 'Пакет заданий загружен', status: 'pending', required: true, help: 'Повторите проверку — загрузка продолжится с места обрыва.' },
    ];
    setChecks(base);
    const set = (id: CheckItem['id'], status: CheckItem['status'], detail?: string) =>
      setChecks((cs) => cs.map((c) => (c.id === id ? { ...c, status, detail } : c)));
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const result: WorkstationCheck = { browser: false, screen: false, fullscreen: false, latencyMs: -1, kimPreloaded: false, passed: false };

    await wait(350);
    result.browser = browser.ok;
    set('browser', browser.ok ? 'ok' : 'fail', browser.name);
    await wait(250);
    const w = window.screen.width * (window.devicePixelRatio > 1 ? 1 : 1);
    result.screen = window.screen.width >= 1280 && window.screen.height >= 720;
    set('screen', result.screen ? 'ok' : 'fail', `${w} × ${window.screen.height}`);
    await wait(250);
    result.fullscreen = !!document.documentElement.requestFullscreen && document.fullscreenEnabled;
    set('fullscreen', result.fullscreen ? 'ok' : 'fail', result.fullscreen ? 'доступен' : 'недоступен');
    try {
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        await examApi.get('/time', { retries: 0 });
        samples.push(performance.now() - t0);
      }
      result.latencyMs = Math.round(samples.sort((a, b) => a - b)[1]);
      set('latencyMs', result.latencyMs < 1000 ? 'ok' : 'fail', `${result.latencyMs} мс`);
    } catch {
      set('latencyMs', 'fail', 'нет ответа');
    }
    try {
      const pkg = await ensurePackage(ws.room.id);
      result.kimPreloaded = true;
      const kb = Math.round(JSON.stringify(pkg).length / 1024);
      set('kimPreloaded', 'ok', `${pkg.variants.length} вар., ${kb} КБ, зашифрован`);
    } catch {
      set('kimPreloaded', 'fail', 'ошибка загрузки');
    }
    const requiredOk = base.every((c) => !c.required || (c.id === 'latencyMs' ? result.latencyMs >= 0 && result.latencyMs < 1000 : !!result[c.id]));
    result.passed = requiredOk;
    try {
      await examApi.post(`/workstations/${ws.workstationId}/check`, result, { headers: wsHeaders });
    } catch {
      /* статус будет передан при следующей проверке */
    }
    return requiredOk;
  }, [ws, ensurePackage, wsHeaders]);

  // ---------- вход (FR-02) ----------
  const login = useCallback(
    async (participantCode: string, accessCode: string) => {
      setLoginError(undefined);
      try {
        const r = await examApi.login('/auth/participant/login', { participantCode, accessCode, workstationSecret: secret });
        const s = await fetchState(r.attemptId!);
        route(s);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'AUTH_LOCKED') {
          const until = (e.problem as { lockedUntil?: string }).lockedUntil;
          setLoginError(`Слишком много неудачных попыток. Ввод заблокирован до ${until ? new Date(until).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '…'}. Организатор уведомлён.`);
        } else if (e instanceof ApiError) setLoginError('Идентификатор участника или код аудитории не подходят. Проверьте данные и попробуйте ещё раз.');
        else setLoginError('Нет связи с сервером. Повторите попытку.');
      }
    },
    [secret, fetchState, route],
  );

  // ---------- канал событий ----------
  const attemptId = state?.attemptId;
  useEffect(() => {
    if (!attemptId) return;
    const ch = new EventChannel(examApi, {
      onEvent: (e: WsEvent) => {
        const s = stateRef.current;
        if (!s) return;
        if (e.type === 'room.started') {
          setState((x) => (x ? { ...x, roomStarted: true } : x));
          void fetchState(s.attemptId).then((ns) => ns.state === 'loading' && phaseRef.current === 'brief' && setNotice({ id: e.eventId, text: 'Экзамен начат организатором. Нажмите «Начать», когда будете готовы.', tone: 'info' }));
        }
        if (e.type === 'attempt.timeChanged') {
          void fetchState(s.attemptId);
          setNotice({ id: e.eventId, text: 'Время окончания экзамена изменено организатором.', tone: 'info' });
        }
        if (e.type === 'attempt.terminated') {
          void fetchState(s.attemptId).then(route);
        }
        if (e.type === 'room.message') {
          const m = e.data as { id: string; text: string; at: string };
          setMessages((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms, m]));
          setNotice({ id: e.eventId, text: m.text, tone: 'info' });
        }
      },
      onStatus: (c) => {
        if (c) lastOk.current = Date.now();
      },
      onReconnect: () => {
        const s = stateRef.current;
        if (s) void fetchState(s.attemptId).then((ns) => FINAL_STATES.includes(ns.state) && route(ns));
      },
    });
    return ch.start();
  }, [attemptId, fetchState, route]);

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // ---------- такт: таймер, автосохранение, обнаружение обрыва ----------
  useEffect(() => {
    if (phase !== 'exam' && phase !== 'brief') return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (phase === 'exam' && flushing.current && Date.now() - flushStarted.current > OFFLINE_AFTER_MS) setOnline(false);
    }, 250);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'exam') return;
    const save = setInterval(() => {
      if (dirty.current.size || queueRef.current.length) void flush();
    }, AUTOSAVE_MS);
    const retry = setInterval(() => {
      if (!online) {
        void examApi
          .get('/time', { retries: 0 })
          .then(() => {
            lastOk.current = Date.now();
            setOnline(true);
            void flush();
          })
          .catch(() => undefined);
      }
    }, 5_000);
    return () => {
      clearInterval(save);
      clearInterval(retry);
    };
  }, [phase, flush, online]);

  // При закрытии вкладки — последняя локальная копия
  useEffect(() => {
    const h = () => persistLocal();
    window.addEventListener('pagehide', h);
    return () => window.removeEventListener('pagehide', h);
  }, [persistLocal]);

  // ---------- истечение времени (FR-17) ----------
  const remainingMs = state?.endsAt ? new Date(state.endsAt).getTime() - (now + offsetRef.current) : undefined;
  useEffect(() => {
    if (phase !== 'exam' || remainingMs === undefined || remainingMs > 0 || expiredHandled.current) return;
    expiredHandled.current = true;
    (async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (dirty.current.size || queueRef.current.length)) {
        if (await flush()) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const s = stateRef.current!;
      for (let i = 0; i < 5; i++) {
        try {
          const ns = await fetchState(s.attemptId);
          if (FINAL_STATES.includes(ns.state)) return route(ns);
        } catch {
          /* сервер переведёт попытку сам */
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      setState((x) => (x ? { ...x, state: 'timeExpired' } : x));
      setPhase('final');
    })();
  }, [phase, remainingMs, flush, fetchState, route]);

  // ---------- контроль целостности (FR-18, FR-19) ----------
  useEffect(() => {
    if (phase !== 'exam' || !ws?.session.proctoring) return;
    const push = (type: string, text?: string) => {
      eventsBuf.current.push({ type, at: serverIso() });
      if (text) setNotice({ id: uuid(), text, tone: 'warn' });
    };
    const onFs = () => {
      if (!document.fullscreenElement) push('fullscreenExit', 'Работа продолжается. Рекомендуем вернуться в полноэкранный режим.');
    };
    const onVis = () => document.visibilityState === 'hidden' && push('visibilityHidden');
    const onBlur = () => push('windowBlur');
    const inKim = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('[data-kim]');
    const onCopy = (e: ClipboardEvent) => {
      if (inKim(e.target) || !(e.target as HTMLElement)?.closest?.('textarea, input')) {
        e.preventDefault();
        push('copy', 'Копирование текста заданий недоступно. Для заметок используйте черновик.');
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text') ?? '';
      const own = Object.values(answersRef.current).some((a) => a.includes(text)) || Object.values(notesRef.current).some((n) => n.includes(text));
      if (!own && text.length > 0) {
        e.preventDefault();
        push('paste', 'Вставка из внешнего источника недоступна.');
      }
    };
    const onPrint = () => push('print');
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        push('print', 'Печать во время экзамена недоступна.');
      }
    };
    const onCtx = (e: MouseEvent) => {
      if (inKim(e.target)) {
        e.preventDefault();
        push('contextMenu');
      }
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onBlur);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste, true);
    window.addEventListener('beforeprint', onPrint);
    window.addEventListener('keydown', onKey);
    document.addEventListener('contextmenu', onCtx);
    const sender = setInterval(() => {
      if (!eventsBuf.current.length) return;
      const events = eventsBuf.current.splice(0, 50);
      queueRef.current.push({ id: uuid(), type: 'events', idempotencyKey: uuid(), payload: { events } });
      void flush();
    }, EVENTS_MS);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste, true);
      window.removeEventListener('beforeprint', onPrint);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('contextmenu', onCtx);
      clearInterval(sender);
    };
  }, [phase, ws, serverIso, flush]);

  // ---------- действия участника ----------
  const localTimer = useRef<number>();
  const scheduleLocal = useCallback(() => {
    clearTimeout(localTimer.current);
    localTimer.current = window.setTimeout(persistLocal, LOCAL_MS / 3);
  }, [persistLocal]);

  const saveTimer = useRef<number>();
  const setAnswer = useCallback(
    (taskId: string, kind: 'short', value: string) => {
      setAnswers((a) => ({ ...a, [taskId]: value }));
      seqRef.current += 1;
      dirty.current.set(taskId, { kind, value, seq: seqRef.current, changedAt: serverIso(), key: uuid() });
      syncPending();
      scheduleLocal();
      clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flushRef.current?.(), ANSWER_DEBOUNCE_MS);
    },
    [serverIso, scheduleLocal],
  );

  const noteTimer = useRef<Record<string, number>>({});
  const setNote = useCallback(
    (taskId: string, text: string) => {
      setNotes((n) => ({ ...n, [taskId]: text }));
      notesRef.current = { ...notesRef.current, [taskId]: text };
      scheduleLocal();
      clearTimeout(noteTimer.current[taskId]);
      noteTimer.current[taskId] = window.setTimeout(() => {
        queueRef.current = queueRef.current.filter((q) => !(q.type === 'note' && q.taskId === taskId));
        queueRef.current.push({ id: uuid(), type: 'note', taskId, value: notesRef.current[taskId] ?? '', idempotencyKey: uuid() });
        syncPending();
        // черновик отправляется после паузы во вводе — состояние «Сохраняется…» не висит до автосохранения
        void flushRef.current?.();
      }, 1500);
    },
    [scheduleLocal],
  );

  const select = useCallback(
    (taskId: string) => {
      setCurrentId(taskId);
      queueRef.current = queueRef.current.filter((q) => q.type !== 'ui');
      queueRef.current.push({ id: uuid(), type: 'ui', idempotencyKey: uuid(), payload: { lastTaskId: taskId } });
      void flush();
    },
    [flush],
  );

  const toggleFlag = useCallback(
    (taskId: string) => {
      setFlags((f) => {
        const next = f.includes(taskId) ? f.filter((x) => x !== taskId) : [...f, taskId];
        queueRef.current = queueRef.current.filter((q) => q.type !== 'ui');
        queueRef.current.push({ id: uuid(), type: 'ui', idempotencyKey: uuid(), payload: { flags: next, lastTaskId: taskId } });
        void flush();
        return next;
      });
    },
    [flush],
  );

  const begin = useCallback(async () => {
    const s = stateRef.current;
    if (!s) return;
    if (ws?.session.proctoring && document.fullscreenEnabled && !document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen();
      } catch {
        /* продолжаем без полноэкранного режима */
      }
    }
    const fresh = await fetchState(s.attemptId);
    route(fresh);
  }, [ws, fetchState, route]);

  const finish = useCallback(async () => {
    const s = stateRef.current;
    if (!s) return false;
    const ok = await flush();
    if (!ok) return false;
    try {
      await examApi.post(`/attempts/${s.attemptId}/finish`, {}, { idempotencyKey: uuid(), retries: 3 });
      const ns = await fetchState(s.attemptId);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      route(ns);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const ns = await fetchState(s.attemptId);
        route(ns);
        return true;
      }
      setOnline(false);
      return false;
    }
  }, [flush, fetchState, route]);

  return {
    phase,
    ws,
    checks,
    runChecks,
    goLogin: () => setPhase('login'),
    login,
    loginError,
    state,
    variant,
    currentId,
    select,
    answers,
    setAnswer,
    notes,
    setNote,
    flags,
    toggleFlag,
    online,
    savedAt,
    pendingCount,
    dirtyIds,
    remainingMs,
    serverNow,
    notice,
    dismissNotice: () => setNotice(undefined),
    messages,
    begin,
    finish,
    flush,
    fatal,
    loadingStep,
  };
}

export type ExamEngine = ReturnType<typeof useExam>;
