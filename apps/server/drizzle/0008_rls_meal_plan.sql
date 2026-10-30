-- Tenant isolation (D31) for the meal planner's tables, in the shape of 0003.
GRANT SELECT, INSERT, UPDATE, DELETE ON meal_plan_entry TO hearth_app;
--> statement-breakpoint
ALTER TABLE meal_plan_entry ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE meal_plan_entry FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY meal_plan_entry_household_isolation ON meal_plan_entry
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON household_settings TO hearth_app;
--> statement-breakpoint
ALTER TABLE household_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE household_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY household_settings_household_isolation ON household_settings
  USING (household_id = current_setting('app.current_household', true))
  WITH CHECK (household_id = current_setting('app.current_household', true));
