import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin, PreviewServer, ViteDevServer } from 'vite';

const PREFIX = '/api/lottery';

let handlerPromise: Promise<typeof import('./lottery-proxy')> | null = null;

function loadHandler() {
  if (!handlerPromise) {
    handlerPromise = import('./lottery-proxy');
  }
  return handlerPromise;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function handleNodeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
  const url = new URL(req.url ?? '/', origin);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const method = req.method ?? 'GET';
  const rawBody = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
  const request = new Request(url, {
    method,
    headers,
    body: rawBody ? new Uint8Array(rawBody) : undefined,
  });
  const { handleLotteryProxy } = await loadHandler();
  const response = await handleLotteryProxy(request);

  res.statusCode = response.status;
  response.headers.forEach((value: string, key: string) => {
    if (key.toLowerCase() === 'content-length') return;
    res.setHeader(key, value);
  });
  res.end(Buffer.from(await response.arrayBuffer()));
}

function attach(server: ViteDevServer | PreviewServer) {
  server.middlewares.use(((req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== PREFIX) {
      next();
      return;
    }
    void handleNodeRequest(req, res).catch((err: unknown) => {
      console.error('[lottery-proxy] middleware error:', err);
      if (res.headersSent) return;
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  }) as Connect.NextHandleFunction);
}

export function lotteryProxyPlugin(): Plugin {
  return {
    name: 'lottery-proxy-local',
    configureServer(server) {
      attach(server);
    },
    configurePreviewServer(server) {
      attach(server);
    },
  };
}
