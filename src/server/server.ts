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

export function buildServer(deps: AppDeps, webDistDir?: string) {
  // Default pino level is 'info', which logs every single request/response — drowns out
  // anything else printed to the console (e.g. invasion-cv.ts's detection diagnostics).
  // 'warn' keeps genuine problems (Fastify's own warnings, 5xx-triggered logs) visible.
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' ? { level: 'warn' } : false });

  app.register(fastifyMultipart, { limits: { fileSize: 20 * 1024 * 1024 } });

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
