# Памятка по коду

Как устроен репозиторий, куда что дописывать и что легко сломать.
Про «почему именно так» — [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Путь запроса

```
HTTP / WS
  └─ src/server.js        роутер, CORS, аборт, graceful shutdown
      └─ src/auth.js      ключ, сравнение за константное время
      └─ src/ratelimit.js лимит на ключ (rpm + суточный)
      └─ src/messages.js  OpenAI/Anthropic → блоки контента
      └─ src/engine.js    ОБЩИЙ конвейер для всех эндпоинтов
           ├─ страж окна подписки
           ├─ src/queue.js          FIFO, ограниченный параллелизм
           ├─ src/claude/manager.js диалог → процесс, прогрев, вытеснение
           └─ src/claude/process.js один процесс, один ход
                └─ claude CLI (stream-json на stdin/stdout)
```

## Карта файлов

| Файл | За что отвечает | Когда трогать |
|---|---|---|
| `src/server.js` | Роуты, аборт запроса, остановка. | Новый эндпоинт. |
| `src/engine.js` | Конвейер: лимиты → очередь → диалог → ход. | Правила поверх всех эндпоинтов. |
| `src/config.js` | ENV + `config/agents.json` → один объект. | Новая настройка. |
| `src/messages.js` | Форматы протоколов ⇄ блоки, склейка истории. | Новый тип контента. |
| `src/claude/args.js` | argv для CLI, включая флаги блокировки. | Новый флаг CLI. |
| `src/claude/process.js` | Жизнь одного процесса и одного хода. | Работа с CLI, ошибки, таймауты. |
| `src/claude/manager.js` | Прогрев, привязка диалогов, resume, вытеснение. | Политика жизни процессов. |
| `src/queue.js`, `src/ratelimit.js` | Пропускная способность. | Новые ограничения. |
| `src/ws.js` | Кодек кадров RFC 6455 + соединение. | Только при багах WS. |
| `src/routes/openai.js` | `/v1/chat/completions`, `/v1/models`. | Совместимость с OpenAI. |
| `src/routes/anthropic.js` | `/v1/messages`. | Совместимость с Anthropic. |
| `src/routes/simple.js` | `/v1/ask` + разбиение на предложения. | Устройства, TTS. |
| `src/routes/wsapi.js` | Протокол поверх WebSocket. | Сообщения очков. |
| `src/routes/admin.js` | `usage`, `agents`, `sessions`, `metrics`. | Эксплуатация. |
| `src/metrics.js` | Prometheus. | Новая метрика. |
| `src/types.js` | JSDoc-типы. | Новые поля. |

---

## Рецепты

### Добавить агента

Только `config/agents.json`, кода не надо. Длинный промпт — в
`config/prompts/*.md` через `system_prompt_file` (путь от папки с конфигом).

```json
{ "support-en": {
    "description": "…", "model": "sonnet",
    "system_prompt_file": "prompts/support-en.md",
    "max_reply_chars": 2000, "prewarm": 1, "allow_images": true } }
```

### Добавить эндпоинт

1. Функция-хендлер в `src/routes/*.js`: `(req, res, ctx) => Promise<void>`,
   где `ctx = { key, url, params, signal, ip }`.
2. Строка в массиве `routes` в `src/server.js`: метод, путь, `auth`, `style`
   (`openai` | `anthropic` | `plain` — только формат ошибки).
3. Тратит модель? Добавьте путь в `isModelCall()`, иначе он пройдёт мимо
   лимитера.
4. Тест в `test/e2e.test.js`.

Всю модельную работу гоняйте через `engine.run()` — там страж окна, очередь,
привязка диалога, метрики и ретрай на потерянном процессе.

### Добавить настройку

`src/config.js`: хелперы `str/num/bool/list`. Затем строка в `.env.example`
с комментарием — файл читают как документацию.

### Отладить против настоящего CLI

```bash
API_KEYS=t:t DATA_DIR=/tmp/cca PORT=8790 LOG_LEVEL=debug node src/server.js
CCA_URL=http://127.0.0.1:8790 CCA_KEY=t node scripts/smoke-test.mjs
```

Сомневаетесь в поведении CLI — проверьте его напрямую, а не через гейтвей:

```bash
claude --print --input-format stream-json --output-format stream-json --verbose \
  --tools "" --permission-prompts none --safe-mode --model sonnet
```

---

## Инварианты: это уже ломалось

Каждый пункт — реальный баг, найденный при разработке. Проверьте себя, если
правите рядом.

1. **`start()` не ждёт `system:init`.** С `--input-format stream-json` CLI
   отдаёт `init` только *после* первого сообщения на stdin. Ожидание init до
   записи — дедлок. `start()` резолвится по первому признаку жизни.
   Сторож: `test/fake-claude.mjs` воспроизводит этот тайминг, плюс тест
   «start() does not wait for system:init».

2. **Обрыв клиента ловим на `res`, не на `req`.** `req.on('close')` в Node
   срабатывает, как только дочитано тело запроса, — для любого POST это задолго
   до ответа. Условие — `res.on('close')` + `!res.writableEnded`.

3. **WebSocket закрываем до `server.close()`.** Апгрейднутый сокет отцеплен от
   учёта `http.Server`, его не закроют ни `close()`, ни
   `closeAllConnections()`. `engine.stop()` рассылает по ним 1001 — иначе
   рестарт висит, пока очки сами не отвалятся.

4. **`tailTurn()` берёт только хвост user-реплик.** Если последняя реплика
   ассистентская — новых входных данных нет, шлём «Continue.», а не старый
   вопрос повторно.

5. **System-промпт из запроса — только на первом ходе диалога.** CLI фиксирует
   системный промпт при старте сессии; SDK шлёт `system` каждый раз. Фильтр —
   `engine.isFreshConversation()`.

6. **`release()` только в `finally`.** Потерянный слот — это навсегда
   заклиненный параллелизм. Там же — `sessions.drop()` для одноразовых диалогов.

7. **Статус 499 ничего не пишет в сокет.** Клиент уже ушёл: `sendError()`
   делает `destroy()`. При стриминге ошибку шлём внутрь потока, но не при 499.

8. **`id` диалога всегда через `sanitizeConversationId()`.** Он приходит от
   клиента и становится ключом Map, ключом в файле сессий и полем лога.

---

## Правила, которые не обсуждаются

* **Инструменты выключены по умолчанию.** `--tools ""`, `--safe-mode`,
  `--strict-mcp-config` в `src/claude/args.js`. Гейтвей смотрит в интернет —
  он не раздаёт шелл. Включение — только явным списком в профиле агента.
* **`--dangerously-skip-permissions` не появляется никогда.** На это есть тест.
* **Картинки только `data:`.** Гейтвей не ходит по ссылкам от клиента — это
  закрытый SSRF. Ослабите — откроете.
* **Промпты не в логах.** `LOG_PROMPTS=0` по умолчанию; в `log.info` не должно
  попадать содержимое сообщений.
* **Ноль рантайм-зависимостей.** `dependencies` в `package.json` пустой и таким
  остаётся: проект раздаёт доступ к аккаунту Claude, дерево зависимостей — это
  поверхность атаки. Нужна библиотека — сначала спросите, нельзя ли без неё.
* **Ключи сравниваются за константное время.** `timingSafeEqual` в `src/auth.js`,
  не `===`.

---

## Команды

```bash
npm test           # 65 тестов: юниты + E2E против поддельного CLI
npm run typecheck  # TypeScript по JSDoc, без сборки
npm run dev        # автоперезапуск
npm run smoke      # против настоящего CLI (тратит немного плана)

node --test --test-reporter=spec --test-name-pattern="websocket" test/e2e.test.js
```

## Поддельный CLI

`test/fake-claude.mjs` говорит на том же stream-json. Режим — через
`FAKE_CLAUDE_MODE`:

| Режим | Что изображает |
|---|---|
| `ok` | Эхо промпта по словам. |
| `memory` | Считает ходы — проверка состояния диалога. |
| `slow` | Секунда между токенами: таймауты, отмена, очередь. |
| `crash-startup` | Падает до `init`. |
| `crash-midturn` | Падает посреди ответа. |
| `error` | `result` с `is_error`. |
| `ratelimit` | Окно плана заполнено на 99.5 %. |

Меняете взаимодействие с CLI — сначала приведите фейк в соответствие с
реальностью, иначе тесты будут зелёными на неправильном поведении. Ровно так
и спрятался баг №1.

## Стиль

Plain ESM + JSDoc-типы, без сборки. Комментарий объясняет **почему**, а не
пересказывает код: «`req` закрывается после чтения тела» — полезно,
«присваиваем переменную» — нет.
