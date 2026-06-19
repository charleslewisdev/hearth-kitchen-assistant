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

describe('trpc recipe', () => {
  beforeAll(async () => {
    await resetDb();
  });

  it('rejects recipe.list without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/trpc/recipe.list' });
    expect(res.statusCode).toBe(401);
  });

  it('authed user creates then lists a recipe', async () => {
    // sign up, capture cookie
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'b@test.dev', password: 'password1234', name: 'B' },
      headers: { 'content-type': 'application/json' },
    });
    const cookie = signup.headers['set-cookie'] as string;

    // create the household (organization) and make it active
    const created = await app.inject({
      method: 'POST',
      url: '/api/auth/organization/create',
      payload: { name: 'Home', slug: `home-${Date.now()}` },
      headers: { 'content-type': 'application/json', cookie },
    });
    expect(created.statusCode).toBeLessThan(400);
    const org = created.json() as { id?: string; organization?: { id: string } };
    const orgId = org.id ?? org.organization?.id;
    expect(orgId).toBeTruthy();
    await app.inject({
      method: 'POST',
      url: '/api/auth/organization/set-active',
      payload: { organizationId: orgId },
      headers: { 'content-type': 'application/json', cookie },
    });

    // create a recipe via tRPC
    const create = await app.inject({
      method: 'POST',
      url: '/trpc/recipe.create',
      payload: { title: 'White Bean Soup' },
      headers: { 'content-type': 'application/json', cookie },
    });
    expect(create.statusCode).toBe(200);

    // list it back
    const list = await app.inject({
      method: 'GET',
      url: '/trpc/recipe.list',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).toContain('White Bean Soup');
  });
});
