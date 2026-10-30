import { router } from '../trpc';
import { cookLogRouter } from './cook-log';
import { foodRouter } from './food';
import { householdRouter } from './household';
import { importRouter } from './import';
import { planRouter } from './plan';
import { recipeRouter } from './recipe';
import { recipeFileRouter } from './recipe-file';
import { shoppingRouter } from './shopping';
import { tagRouter } from './tag';

export const appRouter = router({
  cookLog: cookLogRouter,
  food: foodRouter,
  household: householdRouter,
  import: importRouter,
  plan: planRouter,
  recipe: recipeRouter,
  recipeFile: recipeFileRouter,
  shoppingList: shoppingRouter,
  tag: tagRouter,
});
export type AppRouter = typeof appRouter;
