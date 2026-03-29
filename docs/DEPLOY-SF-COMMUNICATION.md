# Обновление продакшена https://sf-communication.ru/

Пошаговая инструкция: от кода на GitHub до проверки в браузере. Репозиторий: `aserba93-lab/messenger`, типичный путь на VPS: **`/var/www/messenger`**.

---

## Текущая ветка `main` и опциональные фичи

**Сейчас в `main` после отката** нет набора ниже (прочтения, WebRTC в DM, поиск в чате из шапки и т.д.) — это отдельные коммиты (например `190ff18`). Чтобы снова включить их, можно `git cherry-pick 190ff18` в отдельной ветке или восстановить из истории.

**Если эти коммиты в вашей сборке**, в приложении есть:

1. **Прочитано / галочки / ошибка отправки** — `ThreadReadState`, API `markThreadRead`, `threadReadStates`, `messageReaders`, расширенный `searchMessages`, сокет `thread:read`, UI в `web/src/App.tsx`.
2. **Поиск в текущем чате** — поле в шапке чата, вызов `searchMessages` с ID канала/группы/DM.
3. **Звонки WebRTC (без Jitsi)** — `dist/server.js`: `call:signal`, `call:end`; клиент `web/src/webrtcDm.ts`; только DM.
4. **Оптимистичная отправка** — `_sendState`, индикаторы и красный `!` при ошибке.

Миграция БД (только при наличии фич): `prisma/migrations/20260329190000_thread_read_states/migration.sql`.

---

## Предварительные условия

| Что нужно | Зачем |
|-----------|--------|
| SSH-доступ на сервер (пользователь с правами `sudo` или root) | Выполнять команды и перезапускать сервисы |
| Установлены **Node.js** и **npm** | `npm ci`, сборка |
| Установлен **PostgreSQL**, переменная **`DATABASE_URL`** в `.env` в корне проекта | Prisma и приложение |
| Nginx отдаёт статику из **`/var/www/messenger/web/dist`** (или ваш `root`) | Иначе после сборки сайт не изменится |
| Юнит systemd **`messenger`** запускает `node dist/server.js` из корня репозитория | API и Socket.io |

Проверка пути к сайту в Nginx (пример):

```bash
grep -R "root\|alias" /etc/nginx/sites-enabled/ | head -20
```

Должно быть что-то вроде `root /var/www/messenger/web/dist;` для фронта и прокси на порт API (часто `3000`).

---

## Вариант A — один скрипт с сервера

Из корня клонированного репозитория на VPS:

```bash
cd /var/www/messenger
chmod +x scripts/deploy-on-server.sh   # один раз, если не исполняемый
./scripts/deploy-on-server.sh
```

С другим каталогом:

```bash
DEPLOY_ROOT=/путь/к/messenger ./scripts/deploy-on-server.sh
```

Скрипт делает: `git pull` → `npm ci` → `prisma migrate deploy` → сборка бэкенда → `cd web && npm ci && npm run build` → рестарт `messenger` и reload nginx.

---

## Вариант B — команды вручную (пошагово)

Подключитесь по SSH:

```text
ssh root@ВАШ_IP
# или ssh deploy@ВАШ_IP
```

### Шаг 1. Перейти в проект

```bash
cd /var/www/messenger
```

Если каталог другой — подставьте свой (тот же, где лежит `package.json` бэкенда и папка `web/`).

### Шаг 2. Получить последний код с GitHub

```bash
git fetch origin
git status
git pull --ff-only origin main
```

Ожидается: без конфликтов, ветка `main` совпадает с `origin/main`.

### Шаг 3. Зависимости бэкенда

```bash
npm ci
```

`postinstall` запустит `prisma generate`.

### Шаг 4. Миграции базы данных

```bash
npx prisma migrate deploy
```

Должна примениться миграция `20260329190000_thread_read_states` (таблица `ThreadReadState`), если ещё не была применена.

**Если команда падает** (например, «database is not empty» / baseline):

- либо настроить baseline по [документации Prisma](https://www.prisma.io/docs/guides/migrate/developing-and-prototyping/baselining);
- либо вручную выполнить SQL из файла  
  `prisma/migrations/20260329190000_thread_read_states/migration.sql`  
  в вашей БД `messenger`, затем снова `npx prisma migrate deploy` (или пометить миграцию применённой — осторожно, только если понимаете последствия).

### Шаг 5. Сборка бэкенда

```bash
npm run build
```

В этом проекте в проде часто используется уже собранный `dist/` из репозитория; скрипт всё равно стоит выполнять, если у вас так настроено в `package.json`.

### Шаг 6. Сборка фронта (обязательно для смены UI)

```bash
cd /var/www/messenger/web
npm ci
npm run build
```

Проверка артефактов:

```bash
cat /var/www/messenger/web/dist/build-info.json
ls -la /var/www/messenger/web/dist/assets/
```

В `build-info.json` должны быть свежие **`builtAt`** и **`gitSha`** (последний коммит `main`).

### Шаг 7. Перезапуск приложения и Nginx

```bash
sudo systemctl restart messenger
sudo systemctl reload nginx
```

Проверка статуса:

```bash
sudo systemctl status messenger --no-pager
```

Логи при ошибке:

```bash
journalctl -u messenger -n 80 --no-pager
```

---

## Проверка после деплоя

1. **Версия сборки (главная проверка)**  
   Откройте в браузере (лучше инкогнито):

   **https://sf-communication.ru/build-info.json**

   Сравните `gitSha` с выводом на сервере:

   ```bash
   cd /var/www/messenger && git log -1 --oneline
   ```

   Хеши должны совпадать (короткий формат в `build-info` — первые 7 символов коммита).

2. **Главная страница**  
   https://sf-communication.ru/ — сбросьте кэш (Ctrl+F5) или откройте в инкогнито.

3. **Если стоит Cloudflare**  
   Панель → Caching → **Purge Everything** (или только для нужного URL), иначе может отдаваться старый `index.html`.

4. **Nginx**  
   Убедитесь, что `root` указывает на **`.../web/dist`**, куда только что собрался Vite, а не на старую копию статики.

---

## Автодеплой из GitHub Actions

При push в `main` может срабатывать workflow `.github/workflows/deploy-sf-communication.yml`.  
Нужны секреты: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (+ при необходимости passphrase).  
Тогда после `git push` сервер обновится сам, если workflow зелёный.

---

## Откат на предыдущую версию сайта

Сохранён тег **`backup/sf-communication-pre-feature-2026-03-29`** (версия без набора фич прочтений/WebRTC/поиска в чате).

Просмотр:

```bash
git show backup/sf-communication-pre-feature-2026-03-29 --oneline -s
```

Временный откат на сервере (осторожно, отдельная ветка/чекаут):

```bash
cd /var/www/messenger
git fetch origin
git checkout backup/sf-communication-pre-feature-2026-03-29
# пересборка web + restart messenger как выше
```

Для постоянного отката лучше делать отдельный коммит/revert в `main` и снова `git pull`.

---

## Краткий чеклист

- [ ] `git pull` на сервере в `/var/www/messenger`
- [ ] `npm ci` в корне + `npx prisma migrate deploy`
- [ ] `npm run build` в корне (если используется)
- [ ] `cd web` → `npm ci` → `npm run build`
- [ ] `sudo systemctl restart messenger` и `sudo systemctl reload nginx`
- [ ] Проверка `https://sf-communication.ru/build-info.json`
- [ ] Проверка UI в инкогнито

---

## Ограничения

- Конференции «как Телемост» для **многих** участников в канале/группе **не** реализованы (нет SFU); в DM — **1:1 WebRTC**.
- Для стабильных звонков за NAT может понадобиться **TURN**; на клиенте можно задать список серверов через переменную окружения сборки **`VITE_ICE_SERVERS`** (JSON-массив `RTCIceServer[]`).
