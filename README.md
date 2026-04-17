# MESH Reports Toolkit

Проект состоит из 3 частей:
- `tools/download-reports.js` — скачивание XLSX отчетов из МЭШ (API).
- `tools/parse-reports.js` — парсинг XLSX в единую аналитику.
- `web-service.js` — веб-интерфейс просмотра аналитики по ученикам.

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

### 1) Скачать отчеты

```bash
npm run download
```

### 2) Распарсить отчеты

По умолчанию берется последняя папка `output/downloads-*`:

```bash
npm run parse
```

Или конкретная папка:

```bash
REPORTS_DIR="/abs/path/to/downloads-dir" npm run parse
```

### 3) Поднять веб-интерфейс

```bash
npm run start
```

Откройте:

```text
http://localhost:8787
```

## Выходные файлы

После `download`:
- `output/downloads-<timestamp>/...xlsx`
- `output/downloads-<timestamp>/manifest.json`

После `parse`:
- `output/analytics-<timestamp>.json`
- `output/analytics-<timestamp>.csv`
- `output/analytics-latest.json`
- `output/analytics-latest.csv`
