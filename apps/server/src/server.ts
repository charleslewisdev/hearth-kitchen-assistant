import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { env } from './env';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  app.get('/health', async () => ({ status: 'ok' }));
  return app;
}

// Entry point (not run during tests)
if (process.env.NODE_ENV !== 'test' && process.argv[1]?.endsWith('server.ts')) {
  buildServer().then((app) =>
    app.listen({ port: env.PORT, host: '0.0.0.0' }).then(() => {
      // eslint-disable-next-line no-console -- startup log
      console.log(`server on :${env.PORT}`);
    }),
  );
}
