import { Env } from './types';

interface PendingRequest {
  resolve: (res: Response) => void;
  reject: (err: any) => void;
  timer: any;
}

export class DeviceTunnel {
  state: DurableObjectState;
  env: Env;
  deviceWs: WebSocket | null = null;
  operatorSockets: Set<WebSocket> = new Set();
  pendingRequests: Map<string, PendingRequest> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 1. Подключение десктопного приложения по WebSocket
    if (url.pathname === '/tunnel/device-ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.setupDeviceWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Статус подключения устройства
    if (url.pathname === '/tunnel/status') {
      return new Response(JSON.stringify({
        is_connected: this.deviceWs !== null,
        operator_clients: this.operatorSockets.size,
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. Запрос от браузера оператора
    if (!this.deviceWs) {
      const accept = request.headers.get('Accept') || '';
      if (accept.includes('application/json')) {
        return new Response(JSON.stringify({
          error: 'device_offline',
          message: 'Хост-программа сейчас не в сети или прямое соединение с хабом не установлено.'
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(`
        <!DOCTYPE html>
        <html lang="ru">
        <head><meta charset="utf-8"><title>Хост не в сети</title>
        <style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
        .card{background:#1e293b;padding:32px;border-radius:12px;border:1px solid #334155;text-align:center;max-width:440px;}
        h1{font-size:20px;color:#ef4444;margin:0 0 12px;}p{font-size:14px;color:#94a3b8;line-height:1.5;margin:0;}
        </style></head>
        <body><div class="card"><h1>Хост не подключен</h1><p>Хост-программа сейчас не в сети или не установила защищенный канал с облачным хабом. Запустите программу и убедитесь, что включена связь с хабом.</p></div></body></html>
      `, {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // А) WebSocket от оператора (живая телеметрия / live HMI)
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.setupOperatorWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Б) Обычный HTTP запрос (HTML, JSON, commands)
    const reqId = 'req_' + Math.random().toString(36).slice(2, 10);
    const method = request.method;
    const path = url.pathname + url.search;

    const reqHeaders: Record<string, string> = {};
    request.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (!['host', 'connection', 'upgrade', 'cf-connecting-ip', 'cf-ray', 'cf-visitor'].includes(lower)) {
        reqHeaders[key] = val;
      }
    });

    let bodyText: string | null = null;
    if (!['GET', 'HEAD'].includes(method)) {
      try {
        bodyText = await request.text();
      } catch (_) {}
    }

    const payload = JSON.stringify({
      type: 'http_request',
      id: reqId,
      method,
      path,
      headers: reqHeaders,
      body: bodyText,
    });

    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        resolve(new Response(JSON.stringify({ error: 'gateway_timeout', message: 'Хост-программа не ответила за 15 секунд' }), {
          status: 504,
          headers: { 'Content-Type': 'application/json' }
        }));
      }, 15000);

      this.pendingRequests.set(reqId, { resolve, reject, timer });

      try {
        this.deviceWs!.send(payload);
      } catch (err: any) {
        clearTimeout(timer);
        this.pendingRequests.delete(reqId);
        resolve(new Response(JSON.stringify({ error: 'device_send_failed', message: err?.message || 'Ошибка передачи' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    });
  }

  private setupDeviceWebSocket(ws: WebSocket) {
    // @ts-ignore
    ws.accept();

    if (this.deviceWs) {
      try {
        this.deviceWs.close(1000, 'Replaced by new connection');
      } catch (_) {}
    }
    this.deviceWs = ws;

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'http_response' && msg.id) {
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(msg.id);
            const headers = new Headers(msg.headers || {});
            pending.resolve(new Response(msg.body ?? null, {
              status: msg.status || 200,
              headers,
            }));
          }
        } else if (msg.type === 'ws_broadcast') {
          // Рассылка живых событий HMI всем открытым вкладкам операторов
          const dataStr = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data);
          for (const opWs of this.operatorSockets) {
            try {
              opWs.send(dataStr);
            } catch (_) {
              this.operatorSockets.delete(opWs);
            }
          }
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (_) {}
    });

    const cleanup = () => {
      if (this.deviceWs === ws) {
        this.deviceWs = null;
        for (const [id, pending] of this.pendingRequests.entries()) {
          clearTimeout(pending.timer);
          pending.resolve(new Response(JSON.stringify({ error: 'device_disconnected' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          }));
        }
        this.pendingRequests.clear();
      }
    };

    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
  }

  private setupOperatorWebSocket(ws: WebSocket) {
    // @ts-ignore
    ws.accept();
    this.operatorSockets.add(ws);

    ws.addEventListener('message', (event) => {
      // Команды или сообщения от оператора пробрасываем в десктоп
      if (this.deviceWs) {
        try {
          this.deviceWs.send(JSON.stringify({
            type: 'ws_operator_message',
            data: event.data,
          }));
        } catch (_) {}
      }
    });

    const cleanup = () => {
      this.operatorSockets.delete(ws);
    };

    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
  }
}
