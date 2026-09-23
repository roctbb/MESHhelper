const { TelegramClient, Api } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { computeCheck } = require('teleproto/Password');
const bigInt = require('big-integer');
const { telegramWebSocket } = require('./telegram-websocket.cjs');

function telegramProxy(env) {
  const value = String(env.TELEGRAM_PROXY_URL || '').trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    if (!['socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname || !url.port || !Number.isInteger(port) || port < 1 || port > 65535
      || (url.pathname && url.pathname !== '/') || url.search || url.hash) throw new Error('Invalid proxy');
    return { ip: url.hostname.replace(/^\[|\]$/g, ''), port, socksType: 5, timeout: 8,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined };
  } catch (_) {
    // Never echo the URL: it can contain credentials.
    throw Object.assign(new Error('Проверьте TELEGRAM_PROXY_URL: нужен socks5:// или socks5h://логин:пароль@хост:порт (логин и пароль необязательны).'), { status: 503 });
  }
}

function telegramTransport(env) {
  const proxy = telegramProxy(env);
  const transport = String(env.TELEGRAM_TRANSPORT || 'auto').trim().toLowerCase();
  if (!['auto', 'tcp', 'wss'].includes(transport)) {
    throw Object.assign(new Error('TELEGRAM_TRANSPORT: допустимы auto, tcp или wss.'), { status: 503 });
  }
  if (transport === 'wss' || (transport === 'auto' && proxy)) {
    return { networkSocket: telegramWebSocket(String(env.TELEGRAM_PROXY_URL || '').trim()) };
  }
  return { proxy };
}

function createTelegramAdapter(session, apiId, apiHash, env = process.env) {
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 2, reconnectRetries: 2, timeout: 8, requestRetries: 3, floodSleepThreshold: 0,
    ...telegramTransport(env),
    deviceModel: 'MESH Assistant', appVersion: '1.0.0',
    // Suppress SDK logs, which may include request details.
    baseLogger: new (require('teleproto/extensions/Logger').Logger)('none')
  });
  return {
    connect: () => client.connect(),
    disconnect: () => client.destroy(),
    save: () => client.session.save(),
    me: () => client.getMe(),
    sendCode: (phone) => client.sendCode({ apiId, apiHash }, phone),
    signIn: async (phone, hash, code) => {
      const result = await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: hash, phoneCode: code }));
      if (!result.user) throw Object.assign(new Error('ACCOUNT_REQUIRED'), { errorMessage: 'ACCOUNT_REQUIRED' });
      return result.user;
    },
    password: async (password) => {
      const parameters = await client.invoke(new Api.account.GetPassword());
      return (await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(parameters, password) }))).user;
    },
    contacts: async () => {
      const result = await client.invoke(new Api.contacts.GetContacts({ hash: bigInt.zero }));
      return (result.users || []).filter((user) => !user.bot && !user.deleted && !user.self && user.accessHash != null)
        .map((user) => ({ id: user.id.toString(), accessHash: user.accessHash.toString(),
          name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || user.id.toString(),
          username: user.username || '', mutual: Boolean(user.mutualContact) }));
    },
    send: (recipient, message) => client.invoke(new Api.messages.SendMessage({
      peer: new Api.InputPeerUser({ userId: bigInt(recipient.id), accessHash: bigInt(recipient.accessHash) }),
      message, randomId: bigInt(recipient.randomId), noWebpage: true
    })),
    logout: () => client.invoke(new Api.auth.LogOut())
  };
}

module.exports = { createTelegramAdapter, telegramProxy, telegramTransport };
