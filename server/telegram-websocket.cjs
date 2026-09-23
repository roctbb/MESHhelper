const { PromisedWebSockets } = require('teleproto/extensions/PromisedWebSockets');
const WebSocket = require('ws');

async function createProxyAgent(url) {
  // Dynamic import also works on Node 20 releases without require(ESM).
  const { SocksProxyAgent } = await import('socks-proxy-agent');
  return new SocksProxyAgent(url, { timeout: 8000 });
}

function telegramWebSocket(proxyUrl, { WebSocketImpl = WebSocket, agentFactory = createProxyAgent } = {}) {
  return class TelegramWebSocket extends PromisedWebSockets {
    constructor() {
      // The SDK's default WebSocket constructor rejects SOCKS. Our agent handles it.
      super();
      this.generation = 0;
    }

    async connect(port, host, testServers = false) {
      await this.close();
      const generation = this.generation;
      if (port !== 443 || !/^(pluto|venus|aurora|vesta|flora)\.web\.telegram\.org$/.test(host)) {
        throw new Error('Invalid Telegram WebSocket endpoint');
      }
      const agent = proxyUrl ? await agentFactory(proxyUrl) : undefined;
      if (generation !== this.generation) {
        agent?.destroy();
        throw new Error('Telegram WebSocket closed');
      }
      this.agent = agent;
      this.chunks = [];
      this.headOffset = 0;
      this.available = 0;
      this.canRead = new Promise((resolve) => { this.resolveRead = resolve; });
      try {
        const socket = new WebSocketImpl(`wss://${host}:443/apiws${testServers ? '_test' : ''}`, 'binary', {
          agent, handshakeTimeout: 8000, perMessageDeflate: false
        });
        this.client = socket;
        socket.binaryType = 'arraybuffer';
        this.closed = false;
        await new Promise((resolve, reject) => {
          this.rejectConnect = reject;
          socket.onopen = resolve;
          socket.onmessage = ({ data }) => {
            if (this.closed || this.client !== socket) return;
            const chunk = Buffer.from(data);
            if (!chunk.length) return;
            this.chunks.push(chunk);
            this.available += chunk.length;
            this.resolveRead(true);
          };
          // Don't expose underlying proxy errors, which may include credentials.
          socket.onerror = socket.onclose = () => {
            if (this.client === socket) void this.close();
            reject(new Error('Telegram WebSocket connection closed'));
          };
        });
        this.rejectConnect = undefined;
        return this;
      } catch (_) {
        await this.close();
        throw new Error('Telegram WebSocket connection failed');
      }
    }

    async close() {
      this.generation++;
      this.closed = true;
      this.resolveRead?.(false);
      this.rejectConnect?.(new Error('Telegram WebSocket closed'));
      this.rejectConnect = undefined;
      const socket = this.client;
      this.client = undefined;
      socket?.terminate();
      this.agent?.destroy();
      this.agent = undefined;
    }
  };
}

module.exports = { telegramWebSocket };
