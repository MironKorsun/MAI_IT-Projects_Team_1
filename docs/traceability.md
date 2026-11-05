# Трассируемость требований (ТЗ КЧ, приложение А; ТЗ СЧ, приложение А)

Статусы: **реализовано** — код и автотест/сценарий; **реализовано (Д)** — проверено демонстрацией (Playwright-сценарий);
**частично** — ограничение учебного стенда описано в ADR.

## Клиентская часть (ТЗ КЧ)

| Требование | Пр. | Реализация | Проверка | Статус |
|---|---|---|---|---|
| FR-01 Проверка рабочего места | M | `modules/exam/useExam.ts#runChecks`, `ExamApp.tsx#CheckScreen` | ТС-01 (Д) | реализовано (Д) |
| FR-02 Вход, блокировка 5/10 мин | M | `useExam.ts#login`; СЧ `routes/auth.ts` | `api.test.ts` | реализовано |
| FR-03 Инструктаж, «Начать» после старта | M | `ExamApp.tsx#BriefScreen` (инструкция из `kim/…/instruction.md`) | ТС-01 (Д) | реализовано (Д) |
| FR-04 Предзагрузка зашифрованного КИМ, ключ по старту | M | `exam/crypto.ts`, `useExam.ts#startAttempt` | `api.test.ts` | реализовано |
| FR-05 Таймер по серверному времени | M | `useExam.ts#fetchState`, `TaskScreen.tsx#ExamTopBar` | ТС-01 (Д) | реализовано (Д) |
| FR-06 Навигация и статусы заданий | M | `TaskScreen.tsx` | ТС-01 (Д) | реализовано (Д) |
| FR-07 Формат краткого ответа | M | `shared/format.ts`, `ShortAnswer` | `client.test.ts` | реализовано |
| FR-08, FR-09 Развёрнутый ответ, формулы в ответе | M/S | вне охвата: КИМ только с кратким ответом (ТЗ СЧ 3.1, 3.4 п. 1); формулы в условиях — KaTeX | — | не требуется |
| FR-10 Автосохранение 30 с и при переходе | M | `useExam.ts#flush` | ТС-02 (Д) | реализовано (Д) |
| FR-11 Офлайн-очередь, идемпотентность | M | `useExam.ts`, `secureQueue.ts` | ТС-02: обрыв → досылка (Д) | реализовано (Д) |
| FR-12 Восстановление после перезагрузки | M | `useExam.ts` (refresh-cookie → state → snapshot) | ТС-03 (Д) | реализовано (Д) |
| FR-13 Черновик участника | S | `TaskCard` | — | реализовано |
| FR-14 Аудио с лимитом | M | вне охвата: КИМ математики без аудирования (ТЗ СЧ 3.4 п. 1) | — | не требуется |
| FR-15 Отметка для возврата | S | `toggleFlag`, `PATCH /attempts/{id}/ui` | ТС-01 (Д) | реализовано |
| FR-16 Сводка и двухшаговое завершение | M | `TaskScreen.tsx#Summary` | ТС-01 (Д) | реализовано (Д) |
| FR-17 Истечение времени | M | `useExam.ts` (досылка ≤ 10 с) | `api.test.ts` (ТС-08) | реализовано |
| FR-18/19 Контроль целостности | M/S | `useExam.ts` | — | реализовано |
| FR-20 Особые условия | M | `ExamApp.tsx` (масштаб, контраст), сервер +90 мин | ТС (Д) | реализовано (Д) |
| FR-21 Сообщения организатора | C | `room.message`, `ExamNotices` | — | реализовано |
| FR-22–FR-29 Модуль М2 | M/S | `modules/room/RoomPage.tsx` | ТС-01 (Д) | реализовано |
| FR-30–FR-37 Модуль М3 | M/S/C | вне охвата: нет заданий для экспертной проверки (ТЗ СЧ 3.4 п. 1) | — | не требуется |
| FR-38–FR-42 Модуль М4 | M | `modules/admin/*` | — | реализовано |
| FR-43–FR-45 Модуль М5 | M/S | `modules/monitor/*`, карточка аудитории без управления | — | реализовано |
| FR-46–FR-49 Модуль М6 | M/S/C | `modules/results/ResultsApp.tsx` | `api.test.ts` | реализовано |
| FR-50 Завершение сеанса по бездействию во всех вкладках | M | `components/StaffSession.tsx` | — | реализовано |
| FR-51 Единый формат ошибок с кодом обращения | M | `components/ui.tsx#ErrorBox`, `lib/api.ts#describeError` | — | реализовано |
| NFR-06 Бюджет JS М1 ≤ 250 КБ | — | `vite build`: ≈ 160 КБ gzip | сборка | реализовано |
| NFR-14 Повторы 1 с × 2ⁿ ± 20 %, Retry-After | — | `lib/api.ts#backoffDelay` | `client.test.ts` | реализовано |
| NFR-15 Маркеры только в памяти / HttpOnly | — | `lib/api.ts`, СЧ `auth.ts` | `api.test.ts` | реализовано |
| NFR-16 CSP | — | `server/src/app.ts`, `docs/deploy/nginx.conf` | — | реализовано |
| NFR-17 Нет внешних ресурсов | — | шрифт и иконки в сборке | — | реализовано |
| NFR-18 Санитайзер HTML | — | `lib/richtext.tsx#SafeHtml` | — | реализовано |
| NFR-19 Шифрование локального хранилища | — | `secureQueue.ts` | — | реализовано |
| NFR-24–28 Доступность | — | фокус, live-регионы таймера и сохранения, клавиатура М1, контрастная тема | — | частично (axe/NVDA — ручная проверка) |
| NFR-40 RUM | — | `lib/telemetry.ts` | — | реализовано |

## Серверная часть (ТЗ СЧ)

| Требование | Реализация | Проверка |
|---|---|---|
| FR-01–FR-08 Доступ | `auth.ts`, `routes/auth.ts` | `api.test.ts`: блокировка, ротация refresh |
| FR-09–FR-27 Попытки | `routes/exam.ts`, `routes/rooms.ts` | `api.test.ts`: ТС-01, ТС-08 |
| FR-28–FR-31 КИМ | `kim/loader.ts`, `kim/crypto.ts` | `npm run kim:validate`, `api.test.ts` |
| FR-32–FR-38 Оценивание | `grading.ts` | `grading.test.ts` |
| FR-39–FR-42 События | `events.ts`, `audit.ts`, `routes/monitoring.ts` | `grading.test.ts` (цепочка хэшей) |
| FR-43–FR-50 Администрирование | `routes/admin.ts`, `routes/results.ts` | `api.test.ts` (апелляция) |
| FR-51–FR-54 Данные | `routes/analytics.ts`, выгрузки CSV, `/telemetry` | — |

## Аналитика (ТЗ АО)

| Требование | Реализация |
|---|---|
| FR-01–FR-05 Перевод баллов, версии шкал, пересчёт | `grading.ts#validateScale`, `PUT /subjects/{code}/scales/{year}`, `/analytics/scales/check` |
| FR-10–FR-16 Статистика | `computeAnalytics`: среднее, медиана, σ, распределение, порог, выполнение заданий по группам, регионы, динамика |
| FR-20–FR-26 Аномалии | технические, диапазонные, дубликаты, задания, регионы (± 2σ без учёта самого региона), временные, сдвиг распределения |
| FR-30–FR-34 Отчётность | выгрузки `task_statistics`, `anomaly_flags`, `regions` с версиями данных/методики/шкалы |

## Пакет КИМ (ТЗ РКИМ)

`kim/math-profile-2026`: `manifest.json`, `variant_plan.json` (12 позиций с кратким ответом, макс. 12 баллов), `branching_tree.json`
(глубина 2, 4 пути), `tasks/variant-*.json`, `reference_materials/references.json`, `instruction.md`;
схема `kim/schema/kim.schema.json` (JSON Schema 2020-12).
