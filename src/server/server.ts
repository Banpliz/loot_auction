import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'node:path';
import type { AppDeps } from './types';
import { registerAuth } from './auth';

export function buildServer(deps: AppDeps, webDistDir?: string) {
  const app = Fastify();

  app.register(fastifyMultipart);

  app.register(
    async (api) => {
      registerAuth(api, deps);
      api.get('/me', async () => ({ ok: true })); // replaced in Task 9
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
