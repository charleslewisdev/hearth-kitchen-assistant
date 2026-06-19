import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { env } from './env';
import { auth } from './auth';
import { appRouter } from './trpc/routers';
import { createContext } from './trpc/context';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  app.get('/health', async () => ({ status: 'ok' }));

  // Convert Fastify's raw req into a web Request and delegate to Better Auth.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(req, reply) {
      const url = new URL(req.url, env.BETTER_AUTH_URL);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
      }
      const request = new Request(url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
      });
      const res = await auth.handler(request);
      reply.status(res.status);
      // A Web `Headers` object merges multiple Set-Cookie values into one comma-joined
      // string, which corrupts the session cookie. Forward them explicitly.
      for (const cookie of res.headers.getSetCookie()) reply.header('set-cookie', cookie);
      res.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'set-cookie') reply.header(key, value);
      });
      reply.send(res.body ? await res.text() : null);
    },
  });

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: appRouter, createContext },
  });

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
