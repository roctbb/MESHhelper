const NETWORK_MESSAGE = 'Сервер не смог подключиться к Telegram. Проверьте доступ сервера к сети Telegram или настройте SOCKS5-прокси. Повторный запрос кода автоматически не выполняется.';

// A timed-out connection must never be reused or proceed to request a login code.
// Cleanup is best effort: an unresponsive SDK destroy() must not hold the HTTP response.
function withTelegramDeadlines(raw, { timeoutMs = 20000 } = {}) {
  let unavailable = false;
  const dispose = () => { try { Promise.resolve(raw.disconnect()).catch(() => {}); } catch (_) {} };
  const wrapped = { ...raw, get unavailable() { return unavailable; },
    disconnect: async () => { unavailable = true; dispose(); } };
  for (const method of ['connect', 'sendCode', 'signIn', 'password', 'contacts', 'send', 'logout', 'me']) {
    if (typeof raw[method] !== 'function') continue;
    wrapped[method] = async (...args) => {
      if (unavailable) throw Object.assign(new Error('Соединение с Telegram закрыто. Начните вход заново.'), { status: 504, restartLogin: true });
      let timer;
      const operation = Promise.resolve().then(() => raw[method](...args));
      // If a socket finishes connecting after its deadline, dispose of it again.
      operation.then(() => { if (unavailable) dispose(); }, () => {});
      try {
        return await Promise.race([operation, new Promise((_, reject) => {
          timer = setTimeout(() => {
            unavailable = true;
            const err = Object.assign(new Error(method === 'connect' ? NETWORK_MESSAGE :
              'Telegram не ответил вовремя. Проверьте соединение сервера с Telegram. Действие автоматически не повторяется.'),
            { status: 504, errorMessage: 'TELEGRAM_TIMEOUT', stage: method, restartLogin: ['connect', 'sendCode', 'signIn', 'password'].includes(method) });
            reject(err); dispose();
          }, timeoutMs);
        })]);
      } catch (err) {
        if (method === 'connect' && !err.status && !err.errorMessage) {
          unavailable = true; dispose();
          throw Object.assign(new Error(NETWORK_MESSAGE), { status: 502, errorMessage: 'TELEGRAM_CONNECT_FAILED', stage: method, restartLogin: true });
        }
        throw err;
      } finally { clearTimeout(timer); }
    };
  }
  return wrapped;
}

module.exports = { withTelegramDeadlines };
