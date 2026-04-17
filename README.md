# MESH Reports Toolkit

Проект состоит из 3 основных частей:
- `tools/download-reports.js` — основной API sync: получает отметки напрямую из МЭШ и сразу формирует аналитику.
- `web-service.js` — веб-интерфейс просмотра аналитики по ученикам.
- `tools/trace-api.js` — запись сетевого трейса (HAR/JSONL) для анализа API.

Legacy:
- `tools/parse-reports.js` — старый парсер XLSX (нужен только если есть уже скачанные xlsx-файлы).

## Установка

```bash
npm install
npx playwright install chromium
```

## Настройка

1. Скопируйте `.env.example` в `.env`.
2. Заполните обязательные поля:
- `API_CLASS_UNIT_IDS`
- `API_SCHOOL_ID`
- `API_ACADEMIC_YEAR_ID`

Для входа с 2FA рекомендуется:

```bash
MANUAL_LOGIN=true
HEADLESS=false
USE_PERSISTENT_PROFILE=true
```

## Запуск

### 1) Синхронизировать данные из API

```bash
npm run download
# или npm run sync
```

Скрипт сразу создает:
- `output/analytics-latest.json`
- `output/analytics-latest.csv`

При каждом запуске хранятся только актуальные файлы:
- `output/downloads-latest/*`
- `output/analytics-latest.json`
- `output/analytics-latest.csv`

### 2) Поднять веб-интерфейс

```bash
npm run start
```

`npm run start` теперь делает:
1. поднимает веб-сервис
2. открывает API-сессию (по `BROWSER_PROFILE_DIR`)
3. запускает API sync (`tools/download-reports.js`) для обновления `output/analytics-latest.*` через ту же сессию

Если sync не удался, веб всё равно стартует на последних сохранённых данных.

Управление через `.env`:
- `START_SYNC_ON_START=true|false` — включить/выключить авто-sync перед стартом.
- `START_SYNC_STRICT=true|false` — при `true` не запускать веб, если sync завершился ошибкой.
- `MARKING_PREOPEN_ON_START=true|false` — открывать API-сессию для режима проставления сразу при старте веба.

Откройте:

```text
http://localhost:8787
```

В интерфейсе доступны два режима:
- `Аналитика` — просмотр по ученикам/предметам.
- `Проставить отметки` — массовая постановка через API учителя (с предпросмотром и подтверждением).

Для режима проставления используется сессия из `BROWSER_PROFILE_DIR`, поэтому перед этим нужно хотя бы один раз пройти вход через:
- `npm run download` (или `npm run trace`) с `MANUAL_LOGIN=true` и `USE_PERSISTENT_PROFILE=true`.

## Выходные файлы

После `download`:
- `output/downloads-latest/marks-manifest.json`
- `output/analytics-latest.json`
- `output/analytics-latest.csv`

## Legacy режим XLSX

Если нужен старый режим через экспорт журналов в xlsx:
1. В `.env` поставьте:
```text
DOWNLOAD_MODE=api_export
```
2. Выполните:
```bash
npm run download
npm run parse:legacy
```
