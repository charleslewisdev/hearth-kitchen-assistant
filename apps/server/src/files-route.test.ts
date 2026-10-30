import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Building a session sends a verification mail; keep it in memory.
vi.mock('./mail', async () => {
  const actual = await vi.importActual<typeof import('./mail/mailer')>('./mail/mailer');
  return { mailer: new actual.MemoryMailer() };
});

const { buildServer } = await import('./server');
const { createLogger } = await import('./log');
const { resetDb } = await import('../test/db');
const { ownerWithHousehold } = await import('../test/session');
const { liftHouseholdCap, createHousehold } = await import('../test/factories');
const { createRecipe } = await import('./repo/recipes');
const { addRecipeFile } = await import('./repo/recipe-files');

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe('GET /api/files/:id/:variant', () => {
  let server: FastifyInstance;
  beforeAll(async () => {
    server = await buildServer({ logger: createLogger({ level: 'silent', pretty: false }) });
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(resetDb);

  it('serves a household’s own file to a member, cacheably, and nothing to anyone else', async () => {
    const owner = await ownerWithHousehold();
    const cookie = owner.headers.get('cookie') ?? '';
    const { id: recipeId } = await createRecipe(owner.householdId, { title: 'Soup' });
    const file = await addRecipeFile(owner.householdId, owner.userId, {
      recipeId,
      kind: 'photo',
      full: jpeg,
      thumb: jpeg,
    });

    const ok = await server.inject({ url: `/api/files/${file.id}/thumb`, headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.rawPayload.equals(jpeg)).toBe(true);

    expect((await server.inject({ url: `/api/files/${file.id}/thumb` })).statusCode).toBe(401);
    expect(
      (await server.inject({ url: `/api/files/${file.id}/huge`, headers: { cookie } })).statusCode,
    ).toBe(404);

    // Another household's file with this household's session: a 404, not the bytes.
    await liftHouseholdCap();
    const other = await createHousehold();
    const { id: otherRecipe } = await createRecipe(other, { title: 'Theirs' });
    const theirs = await addRecipeFile(other, null, {
      recipeId: otherRecipe,
      kind: 'photo',
      full: jpeg,
      thumb: jpeg,
    });
    expect(
      (await server.inject({ url: `/api/files/${theirs.id}/full`, headers: { cookie } }))
        .statusCode,
    ).toBe(404);
  });

  it('sends a PDF as a download, never rendered on this origin', async () => {
    const owner = await ownerWithHousehold();
    const cookie = owner.headers.get('cookie') ?? '';
    const { id: recipeId } = await createRecipe(owner.householdId, { title: 'Soup' });
    const file = await addRecipeFile(owner.householdId, owner.userId, {
      recipeId,
      kind: 'source_pdf',
      full: Buffer.from('%PDF-1.7 x'),
    });
    const res = await server.inject({ url: `/api/files/${file.id}/full`, headers: { cookie } });
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
  });
});
