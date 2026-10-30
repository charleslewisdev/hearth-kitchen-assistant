-- Custom SQL migration file, put your code below! --
-- Defense-in-depth tenant isolation (Decision 31) for the recipe-core + shopping-list tables.
--
-- The `hearth_app` role already exists (created in 0001). For each tenant-scoped
-- table we GRANT DML to that unprivileged role, ENABLE + FORCE Row-Level Security,
-- and CREATE a household-isolation policy keyed on the `app.current_household` GUC.
-- The final block adds the recipe full-text-search column and query indexes.

GRANT SELECT, INSERT, UPDATE, DELETE ON food TO hearth_app;
--> statement-breakpoint
ALTER TABLE food ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE food FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY food_household_isolation ON food
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON recipe TO hearth_app;
--> statement-breakpoint
ALTER TABLE recipe ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recipe FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY recipe_household_isolation ON recipe
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON recipe_ingredient TO hearth_app;
--> statement-breakpoint
ALTER TABLE recipe_ingredient ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recipe_ingredient FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY recipe_ingredient_household_isolation ON recipe_ingredient
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON recipe_step TO hearth_app;
--> statement-breakpoint
ALTER TABLE recipe_step ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recipe_step FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY recipe_step_household_isolation ON recipe_step
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON tag TO hearth_app;
--> statement-breakpoint
ALTER TABLE tag ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tag FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tag_household_isolation ON tag
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON recipe_tags TO hearth_app;
--> statement-breakpoint
ALTER TABLE recipe_tags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recipe_tags FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY recipe_tags_household_isolation ON recipe_tags
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON shopping_list TO hearth_app;
--> statement-breakpoint
ALTER TABLE shopping_list ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE shopping_list FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY shopping_list_household_isolation ON shopping_list
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON shopping_list_item TO hearth_app;
--> statement-breakpoint
ALTER TABLE shopping_list_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE shopping_list_item FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY shopping_list_item_household_isolation ON shopping_list_item
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
--> statement-breakpoint
ALTER TABLE recipe
  ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;
--> statement-breakpoint
CREATE INDEX recipe_search_tsv_idx ON recipe USING gin (search_tsv);
--> statement-breakpoint
CREATE INDEX recipe_meal_types_idx ON recipe USING gin (meal_types);
--> statement-breakpoint
CREATE INDEX recipe_ingredient_food_idx ON recipe_ingredient (food_id);
--> statement-breakpoint
CREATE INDEX recipe_ingredient_recipe_idx ON recipe_ingredient (recipe_id);