const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// One server process owns this store. Nothing here is served by the web root.
class TelegramStore {
  constructor(directory, suppliedKey) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'state.enc');
    const keyFile = path.join(directory, 'key');
    if (suppliedKey) {
      this.key = Buffer.from(suppliedKey, 'base64');
    } else {
      if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
      this.key = fs.readFileSync(keyFile);
    }
    if (this.key.length !== 32) throw new Error('TELEGRAM_SESSION_KEY must contain 32 bytes in base64');
    this.data = { sessions: {}, accounts: {} };
    if (fs.existsSync(this.file)) {
      const raw = fs.readFileSync(this.file);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      this.data = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString());
    }
    for (const account of Object.values(this.data.accounts)) {
      for (const job of account.jobs) {
        if (['running', 'waiting'].includes(job.status)) {
          job.status = 'paused';
          job.note = 'Сервер перезапущен. Проверьте результат перед продолжением.';
        }
        for (const recipient of job.recipients) {
          if (recipient.status === 'sending') recipient.status = 'unknown';
        }
      }
    }
    this.save();
  }

  save() {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(this.data)), cipher.final()]);
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

module.exports = { TelegramStore };
