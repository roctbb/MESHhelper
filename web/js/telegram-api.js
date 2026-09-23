export async function telegramRequest(action, body, token, { timeoutMs = 50000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`/api/telegram/${action}`, { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    let result;
    try { result = await response.json(); }
    catch (err) {
      if (controller.signal.aborted) throw err;
      throw new Error(`Сервер вернул некорректный ответ (HTTP ${response.status}). Проверьте соединение и журналы сервера.`);
    }
    if (!response.ok) throw Object.assign(new Error(result.error || 'Ошибка соединения с сервером.'),
      { status: response.status, restartLogin: result.restartLogin === true });
    return result;
  } catch (err) {
    if (controller.signal.aborted) throw new Error(action === 'send'
      ? 'Сервер не ответил вовремя. Рассылка могла запуститься — проверьте историю перед повторной отправкой.'
      : 'Сервер не ответил вовремя. Проверьте его соединение с Telegram. Не запрашивайте код многократно подряд.');
    throw err;
  } finally { clearTimeout(timer); }
}
