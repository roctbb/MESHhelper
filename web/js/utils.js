export function norm(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeName(v) {
  return norm(v).toLowerCase().replace(/ё/g, 'е');
}

export function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function parseJwt(token) {
  try {
    const raw = token.split('.')[1];
    if (!raw) return null;
    return JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
  } catch (_) {
    return null;
  }
}

export function isTokenExpired(token) {
  const payload = parseJwt(token);
  if (!payload || !Number.isFinite(payload.exp)) return true;
  const now = Math.floor(Date.now() / 1000);
  return payload.exp <= now + 60;
}

export function parseIsoDate(raw) {
  const m = String(raw || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export function toRuDate(raw) {
  const src = String(raw || '').trim();
  if (!src) return '';
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(src)) return src;
  const isoHead = src.match(/^(\d{4}-\d{2}-\d{2})/);
  const p = parseIsoDate(isoHead ? isoHead[1] : src);
  if (!p) return '';
  return `${String(p.d).padStart(2, '0')}.${String(p.m).padStart(2, '0')}.${p.y}`;
}

export function parseRuDate(raw) {
  const m = String(raw || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  return { d: Number(m[1]), m: Number(m[2]), y: Number(m[3]) };
}

export function monthShortRu(month) {
  const arr = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return arr[month - 1] || '';
}

export function badgeClass(mark) {
  const n = Number.parseFloat(String(mark).replace(',', '.'));
  if (!Number.isFinite(n)) return 'text-bg-secondary';
  if (n >= 9) return 'text-bg-success';
  if (n >= 7) return 'text-bg-primary';
  if (n >= 5) return 'text-bg-warning';
  return 'text-bg-danger';
}

export async function parallelMap(items, concurrency, task) {
  const result = [];
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }).map(async () => {
    while (idx < items.length) {
      const my = idx;
      idx += 1;
      result[my] = await task(items[my], my);
    }
  });
  await Promise.all(workers);
  return result;
}
