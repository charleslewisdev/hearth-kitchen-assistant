import type { MeasureSystem } from '@hearth/shared';
import { amountText, type MeasuredIngredient } from './measure-system';
import { sourceSite } from './source-url';

/** A recipe as the recipe screen has it, cut down to what a copy for someone else carries. */
export interface ShareableRecipe {
  id: string;
  title: string;
  servings: number;
  prepMinutes: number | null;
  cookMinutes: number | null;
  description: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  ingredients: (MeasuredIngredient & {
    id: string;
    position: number;
    foodName: string | null;
    note: string | null;
    linkedRecipe: { title: string } | null;
  })[];
  steps: { id: string; position: number; text: string }[];
  /**
   * The household's own recipes this one's lines are made from (the tortillas in the tacos), so
   * someone without Hearth gets all of it. Each at its own servings; one level deep.
   */
  linkedRecipes?: ShareableRecipe[];
}

/** How the copy is read: the servings and measures the cook has on screen when they share. */
export interface ShareView {
  servings: number;
  system: MeasureSystem;
}

/** One ingredient line: "2 cups flour, sifted". The parser keeps a note without its comma. */
export function ingredientText(
  ingredient: ShareableRecipe['ingredients'][number],
  baseServings: number,
  view: ShareView,
): string {
  const amount = amountText(ingredient, view.system, { from: baseServings, to: view.servings });
  const what = ingredient.foodName ?? ingredient.linkedRecipe?.title ?? '';
  // "flour, sifted"; a line with only an amount and a note reads "2 cups optional".
  const described = [what, ingredient.note].filter(Boolean).join(what ? ', ' : ' ');
  return [amount, described].filter(Boolean).join(' ');
}

/** "Serves 4 · Prep 10 min · Cook 30 min", from what the recipe states. */
export function recipeMeta(recipe: ShareableRecipe, view: ShareView): string {
  return [
    `Serves ${view.servings}`,
    recipe.prepMinutes != null ? `Prep ${recipe.prepMinutes} min` : null,
    recipe.cookMinutes != null ? `Cook ${recipe.cookMinutes} min` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Lines in the order the recipe keeps them. */
export const byPosition = <T extends { position: number }>(items: T[]) =>
  [...items].sort((a, b) => a.position - b.position);

/**
 * "Grandma, https://…": the name the cook gave the source, then its link, when the recipe screen
 * would show that link (`sourceSite` refuses anything but http). Null when there is neither.
 */
export function sourceLine(recipe: ShareableRecipe): string | null {
  return [recipe.sourceName, sourceSite(recipe.sourceUrl)?.href].filter(Boolean).join(', ') || null;
}

/** One recipe as text, without the recipes it links to. */
function oneRecipeText(recipe: ShareableRecipe, view: ShareView): string {
  const sections: string[] = [`${recipe.title}\n${recipeMeta(recipe, view)}`];
  if (recipe.description) sections.push(recipe.description);
  if (recipe.ingredients.length > 0) {
    const lines = byPosition(recipe.ingredients).map(
      (ing) => `- ${ingredientText(ing, recipe.servings, view)}`,
    );
    sections.push(['Ingredients', ...lines].join('\n'));
  }
  if (recipe.steps.length > 0) {
    const lines = byPosition(recipe.steps).map((step, i) => `${i + 1}. ${step.text}`);
    sections.push(['Steps', ...lines].join('\n'));
  }
  const source = sourceLine(recipe);
  if (source) sections.push(`Source: ${source}`);
  return sections.join('\n\n');
}

/**
 * The recipe as plain text, for a message or an email to someone with no Hearth account. Plain
 * text because it is what every messaging app shows as it is; scaled and measured the way the
 * cook has it on screen, so what they send is what they see. The recipes it links to follow,
 * each after a rule, at their own servings.
 */
export function recipeText(recipe: ShareableRecipe, view: ShareView): string {
  return [
    oneRecipeText(recipe, view),
    ...(recipe.linkedRecipes ?? []).map((linked) =>
      oneRecipeText(linked, { servings: linked.servings, system: view.system }),
    ),
  ].join('\n\n---\n\n');
}
