import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';

export * from './auth-schema';

export const recipes = pgTable('recipes', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: text('household_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  slug: text('slug').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type Recipe = typeof recipes.$inferSelect;
export type NewRecipe = typeof recipes.$inferInsert;
