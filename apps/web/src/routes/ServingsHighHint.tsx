/**
 * Why the "Up to" box will not be saved: it has to be above the servings to make a range (D53).
 * Shared by the recipe form and the import review screen, which ask the same question.
 */
export function ServingsHighHint({ servings }: { servings: number }) {
  return (
    <>Up to has to be more than {servings}, or empty. As it is, the recipe saves without a range.</>
  );
}
