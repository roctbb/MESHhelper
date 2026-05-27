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
2. DevTools -> Console.
3. Вставить команду:

```js
(() => {
  const readJson = (raw) => {
    try { return JSON.parse(raw || 'null'); } catch (_) { return null; }
  };
  const session = readJson(localStorage.getItem('sessions')) || readJson(sessionStorage.getItem('sessions'));
  const teacher = (session?.profiles || []).find((profile) => {
    const roles = Array.isArray(profile.roles) ? profile.roles : [];
    return profile.type === 'teacher' || roles.includes('teacher');
  }) || session?.profiles?.[0];

  const candidates = [];
  const scan = (storeName, storage) => {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      const value = String(storage.getItem(key) || '');
      const token = value.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      if (token || /token|jwt|auth|profile/i.test(key)) {
        candidates.push({ store: storeName, key, value, token: token ? token[0] : '' });
      }
    }
  };

  scan('localStorage', localStorage);
  scan('sessionStorage', sessionStorage);

  console.table(candidates.map(({ store, key, value, token }) => ({
    store,
    key,
    hasJwt: Boolean(token),
    preview: value.slice(0, 80)
  })));

  const token = candidates.find((x) => x.token)?.token || '';
  const profile = localStorage.getItem('profile_id')
    || sessionStorage.getItem('profile_id')
    || candidates.find((x) => /profile/i.test(x.key) && /^\d+$/.test(x.value))?.value
    || '';

  console.log('Для MESH Assistant:');
  console.log(JSON.stringify({
    token: session?.authentication_token || token,
    profile_id: teacher?.id || profile
  }, null, 2));
})();
```

4. Скопировать JSON из консоли в поле `Token`. `profile_id` заполнится автоматически.

Можно также скопировать значение ключа `sessions` целиком и вставить его в поле `Token`: приложение само возьмет `authentication_token` и teacher-профиль.

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
