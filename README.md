# MESH Assistant

Веб-приложение для двух задач:
- аналитика по отметкам/рискам учеников;
- массовая проставка отметок (через API учителя, с предпросмотром).

## Архитектура

- Фронтенд разбит на модули и компоненты (`web/js/*`).
- Используется Vite для разработки и сборки.
- Бэкенд (`web-service.js`) отвечает за:
  - статику;
  - `/api/config`;
  - прокси `/api/mesh` -> `https://school.mos.ru/api/...`.
- Авторизация хранится в браузере (`localStorage`): `token`, `profile_id` (+ role/host/aid).

## Запуск

### Продакшен-режим (без Vite)

```bash
npm install
npm run start
```

Открыть: [http://localhost:8787](http://localhost:8787)

### Режим разработки (Vite + автообновление)

```bash
npm install
npm run dev
```

Открыть: [http://localhost:5173](http://localhost:5173)

## Где взять token/profile_id

1. Войти в [school.mos.ru](https://school.mos.ru).
2. DevTools -> Application -> Local Storage -> `https://school.mos.ru`.
3. Скопировать:
   - `aupd_token` -> в поле `token`;
   - `profile_id`.

## Docker

Сборка:

```bash
docker build -t mesh-assistant .
```

Запуск:

```bash
docker run --rm -p 8787:8787 mesh-assistant
```

Или через Docker Compose:

```bash
docker compose up -d --build
```

Остановить:

```bash
docker compose down
```

## Источники данных

- `Аналитика`: автоматически определяются доступные классы, есть выбор класса в UI.
- Для совместимости можно задать `API_CLASS_UNIT_IDS` (через запятую), тогда аналитика фиксируется по этим классам.
- `Проставить отметки`: группы учителя (`assigned_group_ids`).
