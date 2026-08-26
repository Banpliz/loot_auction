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

export function buildServer(deps: AppDeps, webDistDir?: string) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.register(fastifyMultipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  app.register(
    async (api) => {
      registerAuth(api, deps);
      registerUserRoutes(api, deps);
      registerEventRoutes(api, deps);
      registerScreenshotRoutes(api, deps);
      registerItemRoutes(api, deps);
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
