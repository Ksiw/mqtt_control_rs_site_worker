# site_worker (Cloud Hub & Reverse Proxy for mqtt_control_rs)

Бессерверный сервис на базе **Cloudflare Workers + D1 Database** для объединения распределённых установок `mqtt_control_rs` в защищённую промышленную экосистему с единой точкой входа.

## Что реализовано в каркасе:
1. **База данных Cloudflare D1:**
   - Таблицы пользователей (`users`), сессий (`user_sessions`), организаций (`organizations`), подписок (`subscriptions`), рабочих пространств (`workspaces`), узлов программы (`devices`), дашбордов (`dashboards`), прав доступа (`dashboard_permissions`) и журнала аудита (`audit_logs`).
   - Миграция: `migrations/0001_initial_schema.sql`.
2. **Протокол Heartbeat программы (REST API):**
   - `POST /api/v1/device/heartbeat` — приём регулярных запросов состояния программы (каждые 30 сек).
   - Защита от replay-атак (контроль меток времени).
   - Автоматическая регистрация и обновление дашбордов рабочего пространства в базе данных D1.
3. **Отказоустойчивый шлюз (Reverse Proxy Gateway):**
   - `GET /view/:org_slug/:ws_slug/:dash_id` — единый красивый URL для браузера оператора без раскрытия адреса `trycloudflare.com`.
   - Автоматическое горячее переключение (Failover): направление трафика на узел `primary`, а при сбое — на `standby`.
   - Прозрачное проксирование дуплексных соединений WebSocket (`Upgrade: websocket`).
4. **Фоновый планировщик (Cron Trigger):**
   - Выполняется каждую 1 минуту (`* * * * *`).
   - Автоматически переводит зависшие или отключённые узлы в статус оффлайн (`is_online = 0`).

## Команды разработчика:

```bash
# Локальная проверка компиляции TypeScript
./node_modules/.bin/tsc --noEmit

# Применение миграций базы данных D1 локально
npm run d1:local

# Локальный запуск эмулятора воркера
npm run dev

# Публикация в облако Cloudflare
npm run deploy
```
