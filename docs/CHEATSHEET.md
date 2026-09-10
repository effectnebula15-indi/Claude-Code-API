# Памятка по API

Шпаргалка на одну страницу. Полные форматы — в [API.md](API.md).

```bash
export CCA=http://127.0.0.1:8787
export KEY=cca_ваш_ключ
```

Все `/v1/*` требуют `Authorization: Bearer $KEY`.
Anthropic-SDK шлёт `x-api-key` — тоже принимается.

---

## Эндпоинты

| | Путь | Когда |
|---|---|---|
| `POST` | `/v1/chat/completions` | Чужой софт: всё, что говорит по OpenAI. |
| `POST` | `/v1/messages` | Официальные SDK Anthropic. |
| `POST` | `/v1/ask` | **Свои устройства и боты.** Проще всего. |
| `WS` | `/v1/ws` | Очки, постоянное соединение, отмена. |
| `GET` | `/v1/usage` | Сколько окна подписки съедено. Без лимитов. |
| `GET` | `/v1/models` · `/v1/agents` | Что можно звать. |
| `DELETE` | `/v1/sessions/{id}` | Сбросить диалог. |
| `GET` | `/healthz` · `/readyz` | Мониторинг. Без ключа. |
| `GET` | `/metrics` | Prometheus. Нужен `ADMIN_KEY`. |

## Выбор агента: поле `model`

| Значение | Что будет |
|---|---|
| `glasses` | Агент `glasses`. |
| `agent:glasses` | То же, строго. Нет такого — `404`. |
| `sonnet`, `opus`, `haiku` | Агент по умолчанию, но на этой модели. |
| не указано | `DEFAULT_AGENT`. |

## Диалог (контекст на сервере)

Любой из четырёх способов, id — `[A-Za-z0-9._:-]`, до 128 символов:

```
заголовок   X-Conversation-Id: glasses-1
тело        {"conversation_id": "..."} | {"session_id": "..."} | {"conversation": "..."}
websocket   /v1/ws?conversation=glasses-1
поле user   {"user": "..."}   ← только при CONVERSATION_FROM_USER_FIELD=1
```

**С id** — историю помнит Claude, по сети едет только новая реплика, процесс остаётся тёплым, работает кеш промпта. **Без id** — клиент шлёт всю историю сам, она склеивается в один промпт.

> Для очков и ботов всегда передавайте id. Это главный способ не спалить окно подписки.

---

## Готовые команды

```bash
# простой вопрос
curl -s $CCA/v1/ask -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"Скажи привет"}'

# с диалогом и агентом
curl -s $CCA/v1/ask -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"А теперь короче","agent":"glasses","conversation":"glasses-1"}'

# стрим по предложениям (для синтеза речи)
curl -sN $CCA/v1/ask -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"Почему небо голубое?","stream":true}'

# картинка с камеры
curl -s $CCA/v1/ask -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"Что это?","image":"data:image/jpeg;base64,'"$(base64 -w0 frame.jpg)"'"}'

# сбросить диалог
curl -s -X DELETE $CCA/v1/sessions/glasses-1 -H "Authorization: Bearer $KEY"

# сколько осталось от подписки
curl -s $CCA/v1/usage -H "Authorization: Bearer $KEY"
```

## Стрим `/v1/ask` (SSE)

```
data: {"type":"delta","text":"Небо "}          ← по токенам, для экрана
data: {"type":"sentence","text":"Небо голубое из-за рассеяния."}   ← для TTS
data: {"type":"done","text":"…","ms":1840}
data: {"type":"error","message":"…","code":"…"}
```

Строки `: ping` каждые 15 с — heartbeat, игнорируйте.
Берите `sentence`, а не `delta`: это законченные фразы, их можно сразу озвучивать.

## WebSocket `/v1/ws`

```
ws://host:8787/v1/ws?key=$KEY&conversation=glasses-1&agent=glasses
```

Браузер не умеет слать заголовки в handshake — отсюда `?key=`. Остальным можно `Authorization`.

```jsonc
// клиент → сервер
{"type":"ask","id":"1","prompt":"…","image":"data:…"}
{"type":"cancel","id":"1"}     // носитель заговорил — заткнуть ассистента
{"type":"reset"}               // новый диалог
{"type":"ping","id":"p"}

// сервер → клиент
{"type":"ready","agents":[…]}
{"type":"delta","id":"1","text":"…"}
{"type":"sentence","id":"1","text":"…"}
{"type":"done","id":"1","text":"…","ms":1840}
{"type":"error","id":"1","code":"busy","message":"…","retry_after":12}
```

Один вопрос на сокет за раз: второй `ask` во время работы → `code: "busy"`.
Нужен параллелизм — второй сокет.
Сервер сам пингует каждые 25 с, свой keepalive не нужен.

## Картинки

Только `data:`-URL — гейтвей принципиально не ходит по чужим ссылкам.

```jsonc
{"image": "data:image/jpeg;base64,/9j/4AAQ…"}          // одна
{"image": "/9j/4AAQ…", "image_media_type": "image/jpeg"} // голый base64
{"images": ["data:…", "data:…"]}                        // несколько
```

Форматы: `jpeg`, `png`, `gif`, `webp`. Лимит — `MAX_IMAGES_PER_REQUEST` (4).
640×480 JPEG q60 ≈ 30 КБ — этого хватает, чтобы прочитать вывеску.

---

## Ошибки

| Код | `code` | Что делать |
|---|---|---|
| 400 | `invalid_request_error` | Чинить запрос: тело, картинка, длина промпта. |
| 401 | `authentication_error` | Ключ не тот или не передан. |
| 403 | `agent_forbidden` | Ключу не разрешён этот агент. |
| 404 | `unknown_agent` | Нет такого профиля в `config/agents.json`. |
| 409 | `conversation_busy` | По этому id уже идёт ход. Сериализуйте. |
| 429 | `rate_limit_exceeded` | Лимит **гейтвея** на ключ. |
| 429 | `plan_window_guard` | Кончается окно **подписки**. |
| 429 | `upstream_rate_limited` | Отказал сам Anthropic. |
| 503 | `queue_full` · `queue_timeout` | Перегрузка. Отступить и повторить. |
| 504 | `turn_timeout` | Ход не уложился в `TURN_TIMEOUT_MS`. |
| 503 | `not_authenticated` | `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`. |
| 503 | `cli_missing` | `npm i -g @anthropic-ai/claude-code`. |

**Все 429 и 503 несут `Retry-After` в секундах — уважайте его.** Клиент, который
ретраит без паузы, превращает один отказ в сотню.

При стриминге ошибка приходит **внутри** потока (заголовки уже ушли):
SSE — `{"type":"error",…}`, OpenAI — `{"error":{…}}`, Anthropic — событие `error`.

## Ручки, которые крутят чаще всего

```ini
MAX_CONCURRENCY=2        # ходов к модели одновременно
RATE_LIMIT_RPM=30        # на ключ, в минуту
USAGE_GUARD=0.98         # стоп при заполнении 5-часового окна
SESSION_IDLE_MS=600000   # сколько тёплый процесс живёт без дела
TURN_TIMEOUT_MS=300000   # потолок на один ответ
DEFAULT_AGENT=default
```

Полный список с комментариями — в `.env.example`.
Не заводится — [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
