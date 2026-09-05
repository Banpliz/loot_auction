import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'node:path';
import type { AppDeps } from './types';
import { registerAuth } from './auth';
import { registerUserRoutes } from './routes/users';
import { registerEventRoutes } from './routes/events';
import { registerScreenshotRoutes } from './routes/screenshots';
import { registerItemRoutes } from './routes/items';
import { registerParticipantRoutes } from './routes/participants';
import { subscribeToChanges } from './pubsub';

const SSE_HEARTBEAT_MS = 20_000;

export function buildServer(deps: AppDeps, webDistDir?: string) {
  // Default pino level is 'info', which logs every single request/response — drowns out
  // anything else printed to the console (e.g. invasion-cv.ts's detection diagnostics).
  // 'warn' keeps genuine problems (Fastify's own warnings, 5xx-triggered logs) visible.
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' ? { level: 'warn' } : false });

  app.register(fastifyMultipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  // Outside the /api prefix (and its auth hook, see auth.ts) on purpose: this stream never
  // carries any actual data, just a "something changed" ping — see pubsub.ts — so there's
  // nothing here worth authenticating. Real data still only ever comes from the fully
  // authenticated GET /api/events/current a client re-fetches in response to the ping.
  // EventSource (the browser API this feeds) can't send custom headers anyway, which is
  // the usual reason SSE endpoints end up unauthenticated like this.
  app.get('/stream', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.raw.write('\n');

    const unsubscribe = subscribeToChanges(() => reply.raw.write('data: changed\n\n'));
    // Keeps intermediary proxies (nginx, ngrok, Telegram's own webview) from treating the
    // connection as idle and silently closing it.
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), SSE_HEARTBEAT_MS);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.register(
    async (api) => {
      registerAuth(api, deps);
      registerUserRoutes(api, deps);
      registerEventRoutes(api, deps);
      registerScreenshotRoutes(api, deps);
      registerItemRoutes(api, deps);
      registerParticipantRoutes(api, deps);
    },
    { prefix: '/api' }
  );

  app.register(fastifyStatic, {
    root: path.join(deps.dataDir, 'uploads'),
    prefix: '/uploads/',
    decorateReply: false,
  });

  if (webDistDir) {
    app.register(fastifyStatic, {
      root: webDistDir,
      prefix: '/',
      decorateReply: false,
    });
  }

  return app;
}
