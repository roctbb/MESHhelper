const { TelegramClient, Api } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { computeCheck } = require('teleproto/Password');
const bigInt = require('big-integer');

function createTelegramAdapter(session, apiId, apiHash) {
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3, requestRetries: 3, floodSleepThreshold: 0,
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

module.exports = { createTelegramAdapter };
