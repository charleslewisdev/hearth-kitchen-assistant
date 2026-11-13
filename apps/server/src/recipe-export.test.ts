import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { unzipSync, strFromU8 } from 'fflate';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

// Building a session sends a verification mail; keep it in memory.
vi.mock('./mail', async () => {
  const actual = await vi.importActual<typeof import('./mail/mailer')>('./mail/mailer');
  return { mailer: new actual.MemoryMailer() };
});

const { buildServer } = await import('./server');
const { createLogger } = await import('./log');
const { resetDb } = await import('../test/db');
const { ownerWithHousehold } = await import('../test/session');
const { liftHouseholdCap, createHousehold, householdWithOwner } = await import('../test/factories');
const { testContext } = await import('../test/trpc');
const { appRouter } = await import('./trpc/routers');
const { draftToCreateInput } = await import('@hearth/enrichment');
const { exportRecipes } = await import('./repo/recipe-export');
const { capture } = await import('../test/logs');
const { addRecipeFile, setRecipeCover } = await import('./repo/recipe-files');
const { filesRoot } = await import('./files');

type Caller = ReturnType<typeof appRouter.createCaller>;
type Assembled = NonNullable<Awaited<ReturnType<Caller['recipe']['get']>>>;

async function callerIn(householdId?: string) {
  const id = householdId ?? (await householdWithOwner()).householdId;
  return {
    householdId: id,
    caller: appRouter.createCaller(
      testContext({ householdId: id, session: { userId: 'u' } as never }),
    ),
  };
}

/** An invented recipe that a second one links to. */
const STOCK = {
  title: 'House Stock',
  servings: 8,
  mealTypes: ['base' as const],
  ingredientLines: ['2 kg chicken wings', '1 onion, halved'],
  steps: ['Cover with water and simmer for three hours.'],
};

/** An invented recipe that uses every field Hearth keeps on one. */
const RICH = {
  title: 'Charred Fennel & "Smoky" Barley: Take 2',
  servings: 6,
  servingsHigh: 8,
  mealTypes: ['dinner' as const, 'side' as const],
  tags: ['weeknight', 'Make Ahead', 'grains'],
  ingredientLines: [
    '3 cups (360g) pearl barley',
    '1 litre stock [[House Stock]]',
    '2 tbsp olive oil, plus more for the pan',
    '1/2 tsp salt',
    '1 fennel bulb, thinly sliced',
  ],
  steps: [
    'Heat the oven to 220°C.',
    'Toast the barley.\nThen add the stock a ladle at a time.\n  Keep stirring.',
    'Rest it.\n\nA blank line inside this step stays inside it.',
    '10. Rest for ten minutes.',
  ],
  description: 'Notes, line one.\n\n## A heading inside the notes\n- not an ingredient',
  sourceName: 'Aunt Wren’s card box, card 7',
  sourceUrl: 'https://example.com/recipes/barley?x=1&y=2',
  prepMinutes: 15,
  cookMinutes: 40,
  rating: 4,
};

/** Every field an export carries, off an assembled recipe, in a form two recipes compare on. */
function exported(recipe: Assembled) {
  return {
    title: recipe.title,
    servings: recipe.servings,
    servingsHigh: recipe.servingsHigh,
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
    mealTypes: recipe.mealTypes,
    tags: [...recipe.tags].sort(),
    rating: recipe.rating,
    sourceName: recipe.sourceName,
    sourceUrl: recipe.sourceUrl,
    description: recipe.description,
    ingredients: recipe.ingredients.map((i) => ({
      position: i.position,
      rawText: i.rawText,
      quantity: i.quantity,
      unit: i.unit,
      altQuantity: i.altQuantity,
      altUnit: i.altUnit,
      note: i.note,
      foodName: i.foodName,
      scalingMode: i.scalingMode,
      linkedTitle: i.linkedRecipe?.title ?? null,
    })),
    steps: recipe.steps.map((s) => ({ position: s.position, text: s.text })),
  };
}

/** Import one exported file the way the review screen does: through import.fromText, then create. */
async function importMarkdown(caller: Caller, markdown: string) {
  const draft = await caller.import.fromText({ text: markdown });
  expect(draft.source.kind).toBe('markdown');
  const { slug } = await caller.recipe.create(draftToCreateInput(draft));
  return (await caller.recipe.get({ idOrSlug: slug }))!;
}

describe('Markdown export and import', () => {
  beforeEach(resetDb);

  it('round-trips a rich recipe into another household with every exported field equal', async () => {
    const from = await callerIn();
    await from.caller.recipe.create(STOCK);
    const { slug } = await from.caller.recipe.create(RICH);
    const original = (await from.caller.recipe.get({ idOrSlug: slug }))!;
    expect(original.ingredients.some((i) => i.altQuantity === 360)).toBe(true);
    expect(original.ingredients[1]?.linkedRecipe?.title).toBe('House Stock');
    expect(original.servingsHigh).toBe(8);

    const files = await exportRecipes(from.householdId);
    const byTitle = new Map(files.map((f) => [f.title, f.markdown]));

    await liftHouseholdCap();
    const to = await callerIn(await createHousehold());
    // The recipe a line links to goes in first, as it would have to in any household.
    await importMarkdown(to.caller, byTitle.get('House Stock')!);
    const copy = await importMarkdown(to.caller, byTitle.get(RICH.title)!);

    expect(exported(copy)).toEqual(exported(original));
    expect(copy.id).not.toBe(original.id);
    // And the link points at the new household's own stock, not across.
    const stock = await to.caller.recipe.get({ idOrSlug: copy.ingredients[1]!.linkedRecipe!.id });
    expect(stock?.title).toBe('House Stock');
  });

  it('exports what it imported, byte for byte', async () => {
    const { caller, householdId } = await callerIn();
    await caller.recipe.create(STOCK);
    await caller.recipe.create(RICH);
    const first = await exportRecipes(householdId);
    const rich = first.find((f) => f.title === RICH.title)!;

    await caller.recipe.delete({ id: rich.id });
    await importMarkdown(caller, rich.markdown);
    const second = await exportRecipes(householdId);
    expect(second.find((f) => f.title === RICH.title)!.markdown).toBe(rich.markdown);
  });

  it('exports only the household’s own recipes', async () => {
    const mine = await callerIn();
    await mine.caller.recipe.create({ title: 'Mine' });
    await liftHouseholdCap();
    const theirs = await callerIn(await createHousehold());
    await theirs.caller.recipe.create({ title: 'Theirs' });

    expect((await exportRecipes(mine.householdId)).map((f) => f.title)).toEqual(['Mine']);
  });

  it('tells the cook to import a linked recipe first, naming only the line', async () => {
    const from = await callerIn();
    await from.caller.recipe.create(STOCK);
    await from.caller.recipe.create(RICH);
    const files = await exportRecipes(from.householdId);
    await liftHouseholdCap();
    const to = await callerIn(await createHousehold());
    const draft = await to.caller.import.fromText({
      text: files.find((f) => f.title === RICH.title)!.markdown,
    });
    await expect(to.caller.recipe.create(draftToCreateInput(draft))).rejects.toThrow(
      'Ingredient 2 links to a recipe that is not in your library.',
    );
  });
});

describe('the export downloads', () => {
  let server: FastifyInstance;
  const { sink, lines } = capture();
  beforeAll(async () => {
    server = await buildServer({
      logger: createLogger({ level: 'info', pretty: false, destination: sink }),
    });
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(resetDb);

  it('sends the whole library as a zip of one Markdown file per recipe', async () => {
    const owner = await ownerWithHousehold();
    const cookie = owner.headers.get('cookie') ?? '';
    const { caller } = await callerIn(owner.householdId);
    await caller.recipe.create(STOCK);
    await caller.recipe.create(RICH);
    await caller.recipe.create({ title: 'House stock!' });

    const res = await server.inject({ url: '/api/export/recipes.zip', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="hearth-recipes-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    expect(res.headers['cache-control']).toBe('private, no-store');

    const entries = unzipSync(new Uint8Array(res.rawPayload));
    const names = Object.keys(entries)
      .filter((name) => !name.endsWith('/'))
      .sort();
    expect(names).toEqual([
      expect.stringMatching(
        /^hearth-recipes-\d{4}-\d{2}-\d{2}\/charred-fennel-smoky-barley-take-2\.md$/,
      ),
      expect.stringMatching(/\/house-stock-2\.md$/),
      expect.stringMatching(/\/house-stock\.md$/),
    ]);
    const rich = strFromU8(entries[names[0]!]!);
    expect(rich).toContain('title: "Charred Fennel & \\"Smoky\\" Barley: Take 2"');
    expect(rich).toContain('- 1 litre stock [[House Stock]]');

    // D38: the request is logged by id and path, never by what the recipes say.
    expect(lines().length).toBeGreaterThan(0);
    expect(JSON.stringify(lines())).not.toContain('Fennel');
  });

  it('puts each recipe’s photos, pages and PDF in its own folder, listed in its front matter', async () => {
    const owner = await ownerWithHousehold();
    const cookie = owner.headers.get('cookie') ?? '';
    const { caller } = await callerIn(owner.householdId);
    const { id: stewId } = await caller.recipe.create({ title: 'Stew' });
    await caller.recipe.create({ title: 'Toast' });
    const photo1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
    const photo2 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 2]);
    const page = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 3]);
    const pdf = Buffer.from('%PDF-1.4 x');
    const add = (kind: 'photo' | 'source_page' | 'source_pdf', full: Buffer) =>
      addRecipeFile(owner.householdId, owner.userId, {
        recipeId: stewId,
        kind,
        full,
        thumb: kind === 'source_pdf' ? undefined : full,
      });
    await add('photo', photo1);
    const second = await add('photo', photo2);
    await add('source_page', page);
    await add('source_pdf', pdf);
    await setRecipeCover(owner.householdId, stewId, second.id);

    const res = await server.inject({ url: '/api/export/recipes.zip', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const entries = unzipSync(new Uint8Array(res.rawPayload));
    const folder = Object.keys(entries)
      .find((name) => name.endsWith('/stew.md'))!
      .split('/')[0]!;
    const bytes = (name: string) => Buffer.from(entries[`${folder}/${name}`] ?? []);
    expect(bytes('stew/photo-1.jpg').equals(photo1)).toBe(true);
    expect(bytes('stew/photo-2.jpg').equals(photo2)).toBe(true);
    expect(bytes('stew/page-1.jpg').equals(page)).toBe(true);
    expect(bytes('stew/source.pdf').equals(pdf)).toBe(true);

    const stew = strFromU8(entries[`${folder}/stew.md`]!);
    expect(stew).toContain('photos: ["stew/photo-1.jpg", "stew/photo-2.jpg"]');
    expect(stew).toContain('cover: "stew/photo-2.jpg"');
    expect(stew).toContain('source_pages: ["stew/page-1.jpg"]');
    expect(stew).toContain('source_pdf: "stew/source.pdf"');

    // A recipe with no files has no folder and no file keys.
    const toast = strFromU8(entries[`${folder}/toast.md`]!);
    expect(toast).not.toMatch(/^(photos|cover|source_pages|source_pdf):/m);
    expect(Object.keys(entries).some((name) => name.startsWith(`${folder}/toast/`))).toBe(false);
  });

  it('leaves out a file whose bytes are missing, and logs only its id', async () => {
    const owner = await ownerWithHousehold();
    const cookie = owner.headers.get('cookie') ?? '';
    const { caller } = await callerIn(owner.householdId);
    const { id: stewId } = await caller.recipe.create({ title: 'Secret Stew' });
    const kept = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
    const lost = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 2]);
    await addRecipeFile(owner.householdId, owner.userId, {
      recipeId: stewId,
      kind: 'photo',
      full: kept,
      thumb: kept,
    });
    const gone = await addRecipeFile(owner.householdId, owner.userId, {
      recipeId: stewId,
      kind: 'photo',
      full: lost,
      thumb: lost,
    });
    await rm(join(filesRoot(), owner.householdId, `${gone.id}-full`));
    const before = lines().length;

    const res = await server.inject({ url: '/api/export/recipes.zip', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const entries = unzipSync(new Uint8Array(res.rawPayload));
    const files = Object.keys(entries).filter((name) => name.includes('/secret-stew/'));
    expect(files).toEqual([expect.stringMatching(/\/secret-stew\/photo-1\.jpg$/)]);
    expect(Buffer.from(entries[files[0]!]!).equals(kept)).toBe(true);
    const md = strFromU8(
      entries[Object.keys(entries).find((n) => n.endsWith('/secret-stew.md'))!]!,
    );
    expect(md).toContain('photos: ["secret-stew/photo-1.jpg"]');
    expect(md).not.toContain('photo-2');

    const warns = lines()
      .slice(before)
      .filter((line) => line.level === 40);
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns[0])).toContain(gone.id);
    expect(JSON.stringify(lines())).not.toContain('Secret');
  });

  it('sends one recipe as a Markdown file', async () => {
    const owner = await ownerWithHousehold();
    const cookie = owner.headers.get('cookie') ?? '';
    const { caller } = await callerIn(owner.householdId);
    await caller.recipe.create(STOCK);
    const { id } = await caller.recipe.create(RICH);

    const res = await server.inject({ url: `/api/export/recipes/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="charred-fennel-smoky-barley-take-2.md"',
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toBe((await exportRecipes(owner.householdId, id))[0]!.markdown);
  });

  it('sends an empty library as a zip with nothing in it but its folder', async () => {
    const owner = await ownerWithHousehold();
    const cookie = owner.headers.get('cookie') ?? '';
    const res = await server.inject({ url: '/api/export/recipes.zip', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const names = Object.keys(unzipSync(new Uint8Array(res.rawPayload)));
    expect(names.filter((name) => !name.endsWith('/'))).toEqual([]);
  });

  it('refuses anyone signed out, and another household’s recipe is a 404', async () => {
    const owner = await ownerWithHousehold();
    const cookie = owner.headers.get('cookie') ?? '';
    expect((await server.inject({ url: '/api/export/recipes.zip' })).statusCode).toBe(401);

    await liftHouseholdCap();
    const other = await createHousehold();
    const { caller } = await callerIn(other);
    const { id } = await caller.recipe.create({ title: 'Theirs' });
    expect((await server.inject({ url: `/api/export/recipes/${id}` })).statusCode).toBe(401);
    expect(
      (await server.inject({ url: `/api/export/recipes/${id}`, headers: { cookie } })).statusCode,
    ).toBe(404);
    expect(
      (await server.inject({ url: '/api/export/recipes/not-a-uuid', headers: { cookie } }))
        .statusCode,
    ).toBe(404);
  });
});
