import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  primaryKey,
  index,
  pgEnum,
  boolean,
  date,
  smallint,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { RECIPE_TYPES, TAG_COLORS } from '@hearth/shared';
import { organization, user } from './auth-schema';

export * from './auth-schema';

// A plan entry's meal slot. Recipes are filed by `recipeType`, a separate and wider list, so a
// plan slot can never be "sauce".
export const mealType = pgEnum('meal_type', ['breakfast', 'lunch', 'dinner', 'snack', 'dessert']);
export const recipeType = pgEnum('recipe_type', RECIPE_TYPES);
export const scalingMode = pgEnum('scaling_mode', ['linear', 'fixed', 'sublinear', 'manual']);

const household = () =>
  text('household_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' });

export const food = pgTable(
  'food',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: household(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    department: text('department'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    byHouseholdNorm: index('food_household_norm_idx').on(t.householdId, t.normalizedName),
  }),
);

export const recipe = pgTable(
  'recipe',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: household(),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    servings: integer('servings').notNull().default(1),
    prepMinutes: integer('prep_minutes'),
    cookMinutes: integer('cook_minutes'),
    sourceUrl: text('source_url'),
    sourceName: text('source_name'),
    // The recipe's types (`RECIPE_TYPES`). The column keeps its first name, from when the only
    // types were meals.
    mealTypes: recipeType('meal_types').array().notNull().default([]),
    // The photo shown on the card and at the top of the recipe: one of its own `recipe_file` rows.
    coverFileId: uuid('cover_file_id').references((): AnyPgColumn => recipeFile.id, {
      onDelete: 'set null',
    }),
    // The household's verdict, 1 to 5, set by hand. The cook log's own ratings sit beside it on
    // the recipe screen as a trend; they are not averaged into this.
    rating: smallint('rating'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    ratingRange: check('recipe_rating_range', sql`${t.rating} between 1 and 5`),
  }),
);

// A photo in the recipe's gallery, or what an import was read from: a page photo or the PDF.
export const recipeFileKind = pgEnum('recipe_file_kind', ['photo', 'source_page', 'source_pdf']);

/**
 * A file that belongs to a recipe. The bytes live on disk under `DATA_DIR/files/<household>/`,
 * named by this row's id (`files.ts`); this row is what says they exist and who may see them.
 * An image has a `full` copy and a `thumb`; a PDF has only `full`.
 */
export const recipeFile = pgTable(
  'recipe_file',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: household(),
    recipeId: uuid('recipe_id')
      .notNull()
      .references((): AnyPgColumn => recipe.id, { onDelete: 'cascade' }),
    kind: recipeFileKind('kind').notNull(),
    contentType: text('content_type').notNull(),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes').notNull(),
    // Order within its kind: source pages in reading order, photos oldest first.
    position: integer('position').notNull().default(0),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    // A photo taken for one cook-log entry. It stays in the recipe's gallery if the entry goes.
    cookLogId: uuid('cook_log_id').references((): AnyPgColumn => cookLogEntry.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRecipe: index('recipe_file_recipe_idx').on(t.recipeId, t.kind, t.position),
    byCookLog: index('recipe_file_cook_log_idx').on(t.cookLogId),
  }),
);

/**
 * One time a recipe was cooked, logged by hand: when, by whom, how many it fed, how it went.
 * `cooked_on` is the household's calendar day, with no zone, like a plan entry's date.
 */
export const cookLogEntry = pgTable(
  'cook_log_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: household(),
    recipeId: uuid('recipe_id')
      .notNull()
      .references((): AnyPgColumn => recipe.id, { onDelete: 'cascade' }),
    cookedOn: date('cooked_on', { mode: 'string' }).notNull(),
    loggedBy: text('logged_by').references(() => user.id, { onDelete: 'set null' }),
    servings: integer('servings'),
    rating: smallint('rating'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRecipe: index('cook_log_entry_recipe_idx').on(t.recipeId, t.cookedOn),
    ratingRange: check('cook_log_entry_rating_range', sql`${t.rating} between 1 and 5`),
    servingsPositive: check('cook_log_entry_servings_positive', sql`${t.servings} > 0`),
  }),
);

export const recipeIngredient = pgTable(
  'recipe_ingredient',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: household(),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipe.id, { onDelete: 'cascade' }),
    foodId: uuid('food_id').references(() => food.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    quantity: numeric('quantity'),
    unit: text('unit'),
    // The same amount in the other system when the recipe prints one: the 360 g of "3 cups
    // (360g) flour" (`measure-system.ts`). The cook picks which system to read in.
    altQuantity: numeric('alt_quantity'),
    altUnit: text('alt_unit'),
    note: text('note'),
    rawText: text('raw_text').notNull(),
    scalingModeValue: scalingMode('scaling_mode').notNull().default('linear'),
    // The household's own recipe this line is made from ("1 pizza dough" → the dough recipe). The
    // shopping list adds that recipe's ingredients in its place. Deleting the linked recipe leaves
    // the line as plain text. The repo only ever resolves a link inside the line's own household.
    linkedRecipeId: uuid('linked_recipe_id').references(() => recipe.id, { onDelete: 'set null' }),
  },
  (t) => ({
    // For the SET NULL when a linked recipe is deleted, and for "Used in" on the linked recipe.
    byLinkedRecipe: index('recipe_ingredient_linked_recipe_idx').on(t.linkedRecipeId),
  }),
);

export const recipeStep = pgTable('recipe_step', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: household(),
  recipeId: uuid('recipe_id')
    .notNull()
    .references(() => recipe.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  text: text('text').notNull(),
});

// A tag chip's colour, by name (`TAG_COLORS`). Null means the colour derived from the tag's name.
export const tagColor = pgEnum('tag_color', TAG_COLORS);

export const tag = pgTable(
  'tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: household(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    color: tagColor('color'),
  },
  (t) => ({ byHouseholdNorm: index('tag_household_norm_idx').on(t.householdId, t.normalizedName) }),
);

export const recipeTags = pgTable(
  'recipe_tags',
  {
    householdId: household(),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipe.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.recipeId, t.tagId] }) }),
);

export const itemSource = pgEnum('item_source', ['recipe', 'manual']);

export const shoppingList = pgTable('shopping_list', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: household(),
  name: text('name').notNull().default('Shopping list'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const shoppingListItem = pgTable(
  'shopping_list_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: household(),
    listId: uuid('list_id')
      .notNull()
      .references(() => shoppingList.id, { onDelete: 'cascade' }),
    foodId: uuid('food_id').references(() => food.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    quantity: numeric('quantity'),
    unit: text('unit'),
    note: text('note'),
    department: text('department'),
    checked: boolean('checked').notNull().default(false),
    source: itemSource('source').notNull(),
    sourceRecipeId: uuid('source_recipe_id').references(() => recipe.id, { onDelete: 'set null' }),
    position: integer('position').notNull().default(0),
  },
  (t) => ({ byList: index('shopping_list_item_list_idx').on(t.listId, t.position) }),
);

// One recipe planned for one meal on one day (D44). A slot may hold several entries.
// `plan_date` is the household's calendar day, with no zone. `added_to_list_at` is set when
// Build shopping list adds the entry, so a second build adds only what is new.
export const mealPlanEntry = pgTable(
  'meal_plan_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: household(),
    planDate: date('plan_date', { mode: 'string' }).notNull(),
    meal: mealType('meal').notNull(),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipe.id, { onDelete: 'cascade' }),
    servings: integer('servings').notNull(),
    addedToListAt: timestamp('added_to_list_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byHouseholdDate: index('meal_plan_entry_household_date_idx').on(t.householdId, t.planDate),
    servingsPositive: check('meal_plan_entry_servings_positive', sql`${t.servings} > 0`),
  }),
);

// Per-household preferences Hearth owns (D45). A table of its own rather than columns on Better
// Auth's `organization`, whose shape belongs to the auth library. No row means the defaults.
export const householdSettings = pgTable(
  'household_settings',
  {
    householdId: text('household_id')
      .primaryKey()
      .references(() => organization.id, { onDelete: 'cascade' }),
    // 0 is Sunday, as Date.getUTCDay() numbers days.
    weekStart: smallint('week_start').notNull().default(0),
  },
  (t) => ({
    weekStartRange: check(
      'household_settings_week_start_range',
      sql`${t.weekStart} between 0 and 6`,
    ),
  }),
);

// What an import was read by: OCR of photos, a PDF's text layer, or OCR of a scanned PDF.
export const importReading = pgEnum('import_reading', ['photo_ocr', 'pdf_text', 'pdf_ocr']);
// A draft field's confidence, as the importer reports it (`Confidence` in @hearth/enrichment).
export const draftConfidence = pgEnum('draft_confidence', ['high', 'low']);

/**
 * What the importer made of a photo or PDF, kept as it was before the cook edited anything, so
 * a bad import can be studied beside the recipe the cook saved without reading the files again.
 * Written by the import itself; `recipe_id` and `saved_at` are set when the cook saves, and stay
 * null for an import the cook abandoned. Nothing in the app reads these yet (`repo/import-drafts.ts`).
 */
export const importDraft = pgTable(
  'import_draft',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: household(),
    recipeId: uuid('recipe_id').references((): AnyPgColumn => recipe.id, { onDelete: 'set null' }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    reading: importReading('reading').notNull(),
    // The text the parser was given, OCR's or the text layer's. Provenance, like `raw_text`: it
    // is what the parser can be run over again.
    sourceText: text('source_text').notNull(),
    title: text('title').notNull(),
    titleConfidence: draftConfidence('title_confidence').notNull(),
    // The line the title was taken from, before it was tidied and title-cased.
    titleRaw: text('title_raw'),
    servings: integer('servings').notNull(),
    servingsConfidence: draftConfidence('servings_confidence').notNull(),
    servingsRaw: text('servings_raw'),
    ingredientsConfidence: draftConfidence('ingredients_confidence').notNull(),
    stepsConfidence: draftConfidence('steps_confidence').notNull(),
    description: text('description'),
    prepMinutes: integer('prep_minutes'),
    cookMinutes: integer('cook_minutes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // When the cook saved a recipe from it. Stays set if that recipe is deleted later, so a
    // draft that was saved is never mistaken for an abandoned one.
    savedAt: timestamp('saved_at', { withTimezone: true }),
  },
  (t) => ({
    byHousehold: index('import_draft_household_idx').on(t.householdId, t.createdAt),
    byRecipe: index('import_draft_recipe_idx').on(t.recipeId),
  }),
);

export const importDraftIngredient = pgTable(
  'import_draft_ingredient',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: household(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => importDraft.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    // The importer guessed this line's amount from a garbled OCR fraction (`amountsToCheck`).
    amountToCheck: boolean('amount_to_check').notNull().default(false),
  },
  (t) => ({ byDraft: index('import_draft_ingredient_draft_idx').on(t.draftId, t.position) }),
);

export const importDraftStep = pgTable(
  'import_draft_step',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: household(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => importDraft.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    text: text('text').notNull(),
  },
  (t) => ({ byDraft: index('import_draft_step_draft_idx').on(t.draftId, t.position) }),
);

export type Recipe = typeof recipe.$inferSelect;
export type NewRecipe = typeof recipe.$inferInsert;
export type Food = typeof food.$inferSelect;
export type RecipeIngredient = typeof recipeIngredient.$inferSelect;
export type RecipeStep = typeof recipeStep.$inferSelect;
export type RecipeFile = typeof recipeFile.$inferSelect;
export type ShoppingList = typeof shoppingList.$inferSelect;
export type ShoppingListItem = typeof shoppingListItem.$inferSelect;
export type MealPlanEntry = typeof mealPlanEntry.$inferSelect;
