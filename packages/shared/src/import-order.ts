/**
 * The order a bulk import (a recipe zip) creates its recipes in.
 *
 * `recipe.create` refuses a recipe whose `[[Title]]` link matches no recipe in the household, so a
 * recipe has to be created after every recipe it links to. This plans that: titles already in the
 * library (and repeats inside the zip) are skipped, linked recipes come before the recipes that
 * link them, and a link that can never resolve (its title is nowhere, or it closes a cycle) is
 * written back as plain words so the line still reads right and the recipe can be created.
 */
import { recipeTitleKey, splitRecipeLink } from './recipe-link';

export interface ImportPlan<T> {
  /** The recipes to create, in creation order, with their ingredient lines as they should be sent. */
  create: { item: T; ingredientLines: string[] }[];
  /** Titles already in the library or earlier in the zip, in input order. */
  skipped: string[];
  /** Titles of recipes that had a link written back as text, in input order. */
  unlinked: string[];
}

interface Node<T> {
  item: T;
  title: string;
  lines: string[];
  /** 0 not visited, 1 on the current depth-first path, 2 done. */
  state: 0 | 1 | 2;
  unlinked: boolean;
}

/** The line with its link token replaced by the linked title as plain words. */
function unlinkLine(text: string, linkTitle: string): string {
  return text === '' ? linkTitle : `${text} ${linkTitle}`;
}

/**
 * An ingredient line with its `[[Title]]` link written back as plain words, as `planImport` does
 * for a link that cannot resolve. A line without a link comes back as it is.
 */
export function unlinkRecipeLine(line: string): string {
  const { text, linkTitle } = splitRecipeLink(line);
  return linkTitle === null ? line : unlinkLine(text, linkTitle);
}

export function planImport<T>(
  items: readonly T[],
  read: (item: T) => { title: string; ingredientLines: string[] },
  libraryKeys: ReadonlySet<string>,
): ImportPlan<T> {
  const skipped: string[] = [];
  const nodes: Node<T>[] = [];
  const byKey = new Map<string, Node<T>>();
  for (const item of items) {
    const { title, ingredientLines } = read(item);
    const key = recipeTitleKey(title);
    if (libraryKeys.has(key) || byKey.has(key)) {
      skipped.push(title);
      continue;
    }
    const node: Node<T> = { item, title, lines: [...ingredientLines], state: 0, unlinked: false };
    nodes.push(node);
    byKey.set(key, node);
  }

  // Depth-first, post-order, with an explicit stack so a long chain of links cannot overflow.
  const create: ImportPlan<T>['create'] = [];
  for (const root of nodes) {
    if (root.state !== 0) continue;
    root.state = 1;
    const stack: { node: Node<T>; line: number }[] = [{ node: root, line: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const { node } = frame;
      if (frame.line >= node.lines.length) {
        stack.pop();
        node.state = 2;
        create.push({ item: node.item, ingredientLines: node.lines });
        continue;
      }
      const index = frame.line++;
      const { text, linkTitle } = splitRecipeLink(node.lines[index]!);
      if (linkTitle === null) continue;
      const key = recipeTitleKey(linkTitle);
      if (libraryKeys.has(key)) continue;
      const target = byKey.get(key);
      if (target === undefined || target.state === 1) {
        // Found nowhere, or on the current path, so this link closes a cycle.
        node.lines[index] = unlinkLine(text, linkTitle);
        node.unlinked = true;
      } else if (target.state === 0) {
        target.state = 1;
        stack.push({ node: target, line: 0 });
      }
    }
  }

  const unlinked = nodes.filter((n) => n.unlinked).map((n) => n.title);
  return { create, skipped, unlinked };
}
