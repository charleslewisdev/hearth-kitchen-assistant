import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RECIPE_TYPES, type RecipeType } from '@hearth/shared';
import { trpc } from '../lib/trpc';
import { isBuildingBlock, tagStyle, typeLabels, useTagColors } from '../lib/tags';
import { RecipesSubnav } from '../app/RecipesSubnav';
import { fileUrl } from '../lib/photo-upload';
import { daysAgo } from '../lib/dates';
import styles from './Library.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';

const MEAL_TYPES = RECIPE_TYPES;
type MealType = RecipeType;

// How many tag chips sit in the always-visible quick row. The rest of the household's tags are
// in the Filters sheet: a chip row that wraps to three lines has stopped being a glance.
const QUICK_TAG_CHIPS = 4;

// How many suggestions one keystroke may offer under the box. The server caps its answer at 20,
// which is a sane transport limit and far more than belongs in a dropdown.
const MAX_SUGGESTIONS = 5;

// Compose the "prep + cook" line shown on a card, omitting either half when the
// recipe doesn't record it. Returns null when neither time is known (no line).
// The card's time: prep and cook together, the number a cook picking dinner wants. The recipe
// screen shows the two apart.
function timeLabel(prepMinutes: number | null, cookMinutes: number | null): string | null {
  if (prepMinutes == null && cookMinutes == null) return null;
  const total = (prepMinutes ?? 0) + (cookMinutes ?? 0);
  return total >= 60
    ? `${Math.floor(total / 60)} h ${total % 60 ? `${total % 60} min` : ''}`.trim()
    : `${total} min`;
}

type Sort = 'default' | 'updated' | 'title' | 'time' | 'rating' | 'cooked' | 'mostCooked';
type View = 'cards' | 'list';

const SORT_KEY = 'hearth.library.sort';
const VIEW_KEY = 'hearth.library.view';

/** A per-device preference from localStorage, or the fallback when absent, unknown or blocked. */
function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value !== null && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the choice lasts until the page is left.
  }
}

interface Card {
  id: string;
  title: string;
  slug: string;
  servings: number;
  mealTypes: string[];
  prepMinutes: number | null;
  cookMinutes: number | null;
  tags: string[];
  createdAt: Date | string;
  updatedAt: Date | string;
  coverFileId: string | null;
  rating: number | null;
  cookCount: number;
  lastCookedOn: string | null;
}

const totalMinutes = (card: Card) =>
  card.prepMinutes == null && card.cookMinutes == null
    ? null
    : (card.prepMinutes ?? 0) + (card.cookMinutes ?? 0);

/**
 * The cards in the order the cook picked. `default` is the server's own order: newest first,
 * or best match while searching. Sorted here rather than by the server because the library is
 * one household's recipes, already all on the screen. A recipe with no times goes last under
 * "Quickest": unknown is not quick.
 */
function sortCards(cards: Card[], sort: Sort): Card[] {
  if (sort === 'default') return cards;
  const sorted = [...cards];
  if (sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'updated') {
    sorted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }
  if (sort === 'time') {
    sorted.sort((a, b) => (totalMinutes(a) ?? Infinity) - (totalMinutes(b) ?? Infinity));
  }
  // Unrated and never-cooked recipes go last, like a recipe with no times under "Quickest".
  if (sort === 'rating') sorted.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  if (sort === 'cooked') {
    sorted.sort((a, b) => (b.lastCookedOn ?? '').localeCompare(a.lastCookedOn ?? ''));
  }
  if (sort === 'mostCooked') {
    sorted.sort(
      (a, b) =>
        b.cookCount - a.cookCount || (b.lastCookedOn ?? '').localeCompare(a.lastCookedOn ?? ''),
    );
  }
  return sorted;
}

const MAX_CARD_TAGS = 4;

/** The recipe's types as one small-caps line: meals in green, building blocks in amber. */
function TypeLine({ types }: { types: string[] }) {
  if (types.length === 0) return null;
  return (
    <p className={styles.types} aria-label="Recipe type">
      {typeLabels(types).map(({ type, label }) => (
        <span key={type} className={isBuildingBlock(type) ? styles.typeBlock : styles.typeMeal}>
          {label}
        </span>
      ))}
    </p>
  );
}

/** Tag chips, the first few and a count of the rest, so one row stays one row. */
function TagChips({ tags, colorOf }: { tags: string[]; colorOf: (name: string) => string | null }) {
  if (tags.length === 0) return null;
  const shown = tags.slice(0, MAX_CARD_TAGS);
  const rest = tags.length - shown.length;
  return (
    <ul className={styles.cardTags} aria-label="Tags">
      {shown.map((tag) => (
        <li key={tag} className={styles.tagChip} style={tagStyle(tag, colorOf(tag))}>
          {tag}
        </li>
      ))}
      {rest > 0 && <li className={styles.tagMore}>+{rest}</li>}
    </ul>
  );
}

const CLOCK = (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.footIcon}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

const PEOPLE = (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.footIcon}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    <path d="M16 5.2a3 3 0 0 1 0 5.6M21 20c0-2.6-1.6-4.8-4-5.6" />
  </svg>
);

/**
 * Recipe Library: the 2-up browse grid, multi-select "add to shopping list", and D30's search.
 *
 * Two ways in, one surface. The chip row is the no-typing path (meal types, then the household's
 * most-used tags with their counts); the box is the typing path, and what it offers is not only
 * a live title match but removable TOKENS - `contains {ingredient}` drawn from the household's
 * canonical foods, and its tags. The Filters sheet is where the two combine and where the tags
 * that did not fit in the chip row live.
 *
 * Each dimension holds ONE value, because that is what `recipe.list` takes: choosing a second
 * meal type replaces the first rather than widening to "either". Clicking the active chip again
 * clears it, so every filter has a way back out that does not require finding its token.
 */
export function Library() {
  useDocumentTitle('Recipe Book');
  // The four search parameters. `text` is the box itself; the other three are shown as tokens.
  const [text, setText] = useState('');
  const [ingredient, setIngredient] = useState<string | null>(null);
  const [mealType, setMealType] = useState<MealType | null>(null);
  // A tag can arrive in the URL, from the Tags screen's "3 recipes" link.
  const [searchParams] = useSearchParams();
  const [tagName, setTagName] = useState<string | null>(() => searchParams.get('tag'));
  const colorOf = useTagColors();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSortState] = useState<Sort>(() =>
    readPref(
      SORT_KEY,
      ['default', 'updated', 'title', 'time', 'rating', 'cooked', 'mostCooked'],
      'default',
    ),
  );
  const [view, setViewState] = useState<View>(() => readPref(VIEW_KEY, ['cards', 'list'], 'cards'));
  function setSort(next: Sort) {
    setSortState(next);
    writePref(SORT_KEY, next);
  }
  function setView(next: View) {
    setViewState(next);
    writePref(VIEW_KEY, next);
  }

  const query = text.trim();
  // Only the filters actually set are sent, so an untouched Library asks for the plain list and
  // a box holding spaces is not a search for spaces.
  const params = {
    ...(query === '' ? {} : { text: query }),
    ...(ingredient === null ? {} : { ingredient }),
    ...(mealType === null ? {} : { mealType }),
    ...(tagName === null ? {} : { tag: tagName }),
  };
  const filterCount = Object.keys(params).length;

  const recipes = trpc.recipe.list.useQuery(params, {
    // Hold the previous grid while the next keystroke's answer is in flight. Without it every
    // character empties the screen to "Loading recipes…" and back.
    placeholderData: (previous) => previous,
  });
  const tagCounts = trpc.recipe.tagCounts.useQuery();
  const foods = trpc.food.list.useQuery({ q: query }, { enabled: query !== '' });

  // Ids of recipes currently ticked for the multi-add action.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Brief inline confirmation after a successful multi-add (cleared on next add).
  const [confirmation, setConfirmation] = useState<string | null>(null);
  // Set when a multi-add fails; selection is kept so the cook can retry.
  const [addError, setAddError] = useState(false);
  const addRecipe = trpc.shoppingList.addRecipe.useMutation();

  const cards = sortCards(recipes.data ?? [], sort);
  const allTags = tagCounts.data ?? [];

  // The action bar counts only what is BOTH ticked and on screen. A recipe ticked before a
  // filter hid it is not silently added, and the bar does not promise to add nothing. The tick
  // itself is kept, so widening the search back brings the selection with it.
  const selectedVisible = cards.filter((r) => selectedIds.has(r.id));

  function toggleSelected(id: string) {
    setConfirmation(null);
    setAddError(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addSelectedToList() {
    if (selectedVisible.length === 0) return;
    setConfirmation(null);
    setAddError(false);
    // One add per selected recipe, at its base servings.
    try {
      await Promise.all(
        selectedVisible.map((card) =>
          addRecipe.mutateAsync({ recipeId: card.id, servings: card.servings }),
        ),
      );
    } catch {
      // Keep the selection so the cook can retry the whole batch.
      setAddError(true);
      return;
    }
    setSelectedIds(new Set());
    setConfirmation(
      `Added ${selectedVisible.length} recipe${selectedVisible.length === 1 ? '' : 's'} to your shopping list.`,
    );
  }

  function clearFilters() {
    setText('');
    setIngredient(null);
    setMealType(null);
    setTagName(null);
  }

  // A chosen suggestion replaces what was typed: the token IS the query now, and leaving the
  // text behind would silently AND the two.
  function chooseIngredient(name: string) {
    setIngredient(name);
    setText('');
  }
  function chooseTag(name: string) {
    setTagName(name);
    setText('');
  }

  const toggleMealType = (meal: MealType) => setMealType((m) => (m === meal ? null : meal));
  const toggleTag = (name: string) => setTagName((t) => (t === name ? null : name));

  // The tokens standing for the three non-text filters, each with the way to remove it.
  const tokens = [
    ingredient === null
      ? null
      : { key: 'ingredient', label: `contains ${ingredient}`, clear: () => setIngredient(null) },
    mealType === null ? null : { key: 'meal', label: mealType, clear: () => setMealType(null) },
    tagName === null
      ? null
      : { key: 'tag', label: `tagged ${tagName}`, clear: () => setTagName(null) },
  ].filter((t) => t !== null);

  // Suggestions are what the typed text could BECOME: a food the household already has, or one
  // of its tags. The live title match needs no suggestion, because it is the grid below.
  const suggestions =
    query === ''
      ? []
      : [
          ...(foods.data ?? []).slice(0, MAX_SUGGESTIONS).map((food) => ({
            key: `food-${food.id}`,
            label: `contains ${food.name}`,
            choose: () => chooseIngredient(food.name),
          })),
          ...allTags
            .filter((t) => t.name.toLowerCase().startsWith(query.toLowerCase()))
            .slice(0, MAX_SUGGESTIONS)
            .map((t) => ({
              key: `tag-${t.normalizedName}`,
              label: `tagged ${t.name}`,
              choose: () => chooseTag(t.name),
            })),
        ];

  function mealChip(meal: MealType) {
    return (
      <button
        key={meal}
        type="button"
        className={mealType === meal ? `${styles.filterChip} ${styles.chipOn}` : styles.filterChip}
        aria-pressed={mealType === meal}
        onClick={() => toggleMealType(meal)}
      >
        {meal}
      </button>
    );
  }

  function tagChip(t: { name: string; normalizedName: string; count: number }) {
    return (
      <button
        key={t.normalizedName}
        type="button"
        className={tagName === t.name ? `${styles.filterChip} ${styles.chipOn}` : styles.filterChip}
        aria-pressed={tagName === t.name}
        onClick={() => toggleTag(t.name)}
      >
        {t.name} <span className={styles.chipCount}>{t.count}</span>
      </button>
    );
  }

  return (
    <section className={styles.library}>
      <RecipesSubnav />
      <header className={styles.header}>
        <h1 className={styles.title}>Recipes</h1>
        <Link to="/recipes/new" className={styles.newButton}>
          + New recipe
        </Link>
      </header>

      <div className={styles.searchRow}>
        {/* Visually hidden rather than absent: a placeholder disappears the moment someone types
            and is not a label to a screen reader. */}
        <label htmlFor="library-search" className={styles.srOnly}>
          Search recipes
        </label>
        <input
          id="library-search"
          type="search"
          className={styles.searchInput}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search recipes"
          autoComplete="off"
        />
        <button
          type="button"
          className={styles.filtersButton}
          aria-expanded={filtersOpen}
          {...(filtersOpen ? { 'aria-controls': 'library-filters' } : {})}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          {/* The badge counts the TOKEN filters, not the typed text. Text is visible in the box
              it was typed into, and counting it here would put a number on a sheet showing
              nothing switched on. */}
          Filters{tokens.length > 0 ? ` (${tokens.length})` : ''}
        </button>
      </div>

      {suggestions.length > 0 && (
        <ul className={styles.suggestions} aria-label="Search suggestions">
          {suggestions.map((s) => (
            <li key={s.key}>
              <button type="button" className={styles.suggestion} onClick={s.choose}>
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {tokens.length > 0 && (
        <ul className={styles.tokens} aria-label="Active filters">
          {tokens.map((t) => (
            <li key={t.key}>
              <button
                type="button"
                className={styles.token}
                onClick={t.clear}
                aria-label={`Remove filter ${t.label}`}
              >
                {t.label} <span aria-hidden="true">✕</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The sheet replaces the quick row rather than covering it, so the same filter is never
          two controls with the same name on one screen. */}
      {filtersOpen ? (
        <div id="library-filters" className={styles.sheet} role="group" aria-label="Filters">
          <div className={styles.sheetGroup}>
            <p className={styles.sheetLabel}>Meal</p>
            <div className={styles.chipRow}>{MEAL_TYPES.map(mealChip)}</div>
          </div>
          {allTags.length > 0 && (
            <div className={styles.sheetGroup}>
              <p className={styles.sheetLabel}>Tags</p>
              <div className={styles.chipRow}>{allTags.map(tagChip)}</div>
            </div>
          )}
          <div className={styles.sheetActions}>
            <button type="button" className={styles.clearButton} onClick={clearFilters}>
              Clear filters
            </button>
            <button
              type="button"
              className={styles.doneButton}
              onClick={() => setFiltersOpen(false)}
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.chipRow} role="group" aria-label="Quick filters">
          {MEAL_TYPES.map(mealChip)}
          {allTags.slice(0, QUICK_TAG_CHIPS).map(tagChip)}
        </div>
      )}

      {recipes.isLoading && <p className={styles.status}>Loading recipes…</p>}

      {recipes.isError && (
        <p className={styles.error} role="alert">
          Couldn’t load your recipes. Please try again.
        </p>
      )}

      {recipes.data && cards.length === 0 && filterCount === 0 && (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No recipes yet</p>
          <p className={styles.emptyBody}>Add your first recipe to start building your library.</p>
          <Link to="/recipes/new" className={styles.newButton}>
            + New recipe
          </Link>
        </div>
      )}

      {/* A cook who has recipes and filtered them all away needs to be told that, not told to
          add their first recipe. */}
      {recipes.data && cards.length === 0 && filterCount > 0 && (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No recipes match</p>
          <p className={styles.emptyBody}>Try a different word, or fewer filters.</p>
          <button type="button" className={styles.clearButton} onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      )}

      {cards.length > 0 && (
        <>
          <div className={styles.toolbar}>
            <p className={styles.count}>
              {cards.length} {cards.length === 1 ? 'recipe' : 'recipes'}
            </p>
            <label className={styles.sortLabel}>
              <span className={styles.srOnly}>Sort recipes</span>
              <select
                className={styles.sortSelect}
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
              >
                <option value="default">{query === '' ? 'Newest' : 'Best match'}</option>
                <option value="updated">Recently edited</option>
                <option value="title">A–Z</option>
                <option value="time">Quickest</option>
                <option value="rating">Top rated</option>
                <option value="cooked">Recently cooked</option>
                <option value="mostCooked">Most cooked</option>
              </select>
            </label>
            <div className={styles.viewToggle} role="group" aria-label="View">
              <button
                type="button"
                className={view === 'cards' ? styles.viewOn : styles.viewButton}
                aria-pressed={view === 'cards'}
                aria-label="Cards"
                onClick={() => setView('cards')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.viewIcon}>
                  <rect x="4" y="4" width="7" height="7" rx="1.5" />
                  <rect x="13" y="4" width="7" height="7" rx="1.5" />
                  <rect x="4" y="13" width="7" height="7" rx="1.5" />
                  <rect x="13" y="13" width="7" height="7" rx="1.5" />
                </svg>
              </button>
              <button
                type="button"
                className={view === 'list' ? styles.viewOn : styles.viewButton}
                aria-pressed={view === 'list'}
                aria-label="List"
                onClick={() => setView('list')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.viewIcon}>
                  <path d="M9 6h11M9 12h11M9 18h11" />
                  <circle cx="5" cy="6" r="1" />
                  <circle cx="5" cy="12" r="1" />
                  <circle cx="5" cy="18" r="1" />
                </svg>
              </button>
            </div>
          </div>
          {selectedVisible.length === 0 && (
            <p className={styles.hint}>Tick recipes to add them to your shopping list together.</p>
          )}
          <ul className={view === 'cards' ? styles.grid : styles.list}>
            {cards.map((recipe) => {
              const time = timeLabel(recipe.prepMinutes, recipe.cookMinutes);
              const checked = selectedIds.has(recipe.id);
              return (
                <li key={recipe.id} className={view === 'cards' ? styles.card : styles.row}>
                  <input
                    type="checkbox"
                    className={styles.select}
                    checked={checked}
                    onChange={() => toggleSelected(recipe.id)}
                    aria-label={`Select ${recipe.title}`}
                  />
                  <Link to={`/recipes/${recipe.slug}`} className={styles.cardLink}>
                    <h2 className={styles.cardTitle}>{recipe.title}</h2>
                    {recipe.coverFileId && (
                      <img
                        className={styles.cardPhoto}
                        src={fileUrl(recipe.coverFileId, 'thumb')}
                        alt=""
                        loading="lazy"
                      />
                    )}
                    <TypeLine types={recipe.mealTypes} />
                    <TagChips tags={recipe.tags} colorOf={colorOf} />
                    {recipe.lastCookedOn && (
                      <p className={styles.cooked}>
                        Cooked {recipe.cookCount}× · last {daysAgo(recipe.lastCookedOn)}
                      </p>
                    )}
                    <p className={styles.foot}>
                      <span className={styles.footItem}>
                        {PEOPLE}
                        Serves {recipe.servings}
                      </span>
                      {recipe.rating !== null && (
                        <span
                          className={styles.footRating}
                          aria-label={`Rated ${recipe.rating} out of 5`}
                        >
                          ★ {recipe.rating}
                        </span>
                      )}
                      {time && (
                        <span className={styles.footItem}>
                          {CLOCK}
                          {time}
                        </span>
                      )}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>

          {confirmation && (
            <p className={styles.confirmation} role="status">
              {confirmation}
            </p>
          )}

          {addError && (
            <p className={styles.error} role="alert">
              Couldn’t add to your shopping list. Please try again.
            </p>
          )}

          {selectedVisible.length > 0 && (
            <div className={styles.actionBar}>
              <button
                type="button"
                className={styles.addButton}
                onClick={addSelectedToList}
                disabled={addRecipe.isPending}
              >
                {addRecipe.isPending ? 'Adding…' : `Add ${selectedVisible.length} to shopping list`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
