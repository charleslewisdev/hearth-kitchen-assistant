import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server';
import { resetDb } from '../test/db';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
});
afterAll(async () => {
  await app.close();
});

describe('health', () => {
  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('auth', () => {
  beforeAll(async () => {
    await resetDb();
  });
  it('signs up a user and returns a session cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'a@test.dev', password: 'password1234', name: 'A' },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers['set-cookie']).toBeDefined();
  });
});
