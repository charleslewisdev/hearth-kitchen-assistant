import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  parseIngredientLine,
  RECIPE_TYPES,
  recipeTitleKey,
  sortRecipeTypes,
  suggestTags,
  splitRecipeLink,
  withRecipeLink,
  type RecipeType,
} from '@hearth/shared';
import { trpc } from '../lib/trpc';
import { previewLabel } from '../lib/ingredient-preview';
import { lineIndexAt, openedLinkAt, setLineLink } from '../lib/ingredient-links';
import { RecipeLinkPicker } from './RecipeLinkPicker';
import { sourceUrlInput } from '../lib/source-url';
import { notYetTagged, useTagColors } from '../lib/tags';
import { TagInput } from './TagInput';
import { SourceField } from './SourceField';
import { TagSuggestionChips } from './TagSuggestionChips';
import styles from './RecipeEdit.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';

const MEAL_TYPES = RECIPE_TYPES;
type MealType = RecipeType;

// Create / edit a recipe. Two modes keyed on the :slug route param:
//   /recipes/new        → create mode (empty form)
//   /recipes/:slug/edit → edit mode (prefilled from recipe.get)
// An empty or unreadable minutes box means "not given", never 0.
function minutesOrNull(text: string): number | null {
  const n = Number.parseInt(text, 10);
  return Number.isNaN(n) || n < 0 ? null : Math.min(n, 10_000);
}

export function RecipeEdit() {
  const { slug } = useParams();
  const isEdit = Boolean(slug);
  const navigate = useNavigate();

  // Load the existing recipe only in edit mode.
  const existing = trpc.recipe.get.useQuery({ idOrSlug: slug ?? '' }, { enabled: isEdit });
  useDocumentTitle(isEdit ? (existing.data ? `Edit ${existing.data.title}` : null) : 'New recipe');

  const createMutation = trpc.recipe.create.useMutation();
  const updateMutation = trpc.recipe.update.useMutation();
  const mutation = isEdit ? updateMutation : createMutation;
  // Every recipe in the household, for the link picker and for showing what each link resolves
  // to. The Library asks the same question, so this is usually already cached.
  const library = trpc.recipe.list.useQuery();

  // Controlled form state.
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [servings, setServings] = useState(1);
  const [mealTypes, setMealTypes] = useState<MealType[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [ingredientsText, setIngredientsText] = useState('');
  const [steps, setSteps] = useState<string[]>(['']);
  const [sourceName, setSourceName] = useState('');
  const [sourceUrlText, setSourceUrlText] = useState('');
  const [description, setDescription] = useState('');
  const [prepText, setPrepText] = useState('');
  const [cookText, setCookText] = useState('');
  // The ingredients-box line the recipe picker is linking, or null while it is closed.
  const [pickerLine, setPickerLine] = useState<number | null>(null);
  // Which recipe each link token means, by title key: seeded from the links the recipe loaded
  // with and from every pick. Saving sends these ids, so a title two recipes share, or one that
  // was renamed, still links the recipe the cook chose.
  const [linkIds, setLinkIds] = useState<Map<string, string>>(new Map());
  const ingredientsRef = useRef<HTMLTextAreaElement>(null);

  // Prefill once the recipe loads (edit mode). Keyed on the loaded id so it runs
  // exactly once per recipe, not on every keystroke.
  const loaded = existing.data;
  useEffect(() => {
    if (!loaded) return;
    setLoadedId(loaded.id);
    setTitle(loaded.title);
    setServings(loaded.servings);
    setMealTypes(loaded.mealTypes as MealType[]);
    setTags(loaded.tags);
    setIngredientsText(
      loaded.ingredients
        .map((i) => withRecipeLink(i.rawText, i.linkedRecipe?.title ?? null))
        .join('\n'),
    );
    setLinkIds(
      new Map(
        loaded.ingredients.flatMap((i) =>
          i.linkedRecipe ? [[recipeTitleKey(i.linkedRecipe.title), i.linkedRecipe.id]] : [],
        ),
      ),
    );
    setSteps(loaded.steps.length ? loaded.steps.map((s) => s.text) : ['']);
    setSourceName(loaded.sourceName ?? '');
    setSourceUrlText(loaded.sourceUrl ?? '');
    setDescription(loaded.description ?? '');
    setPrepText(loaded.prepMinutes == null ? '' : String(loaded.prepMinutes));
    setCookText(loaded.cookMinutes == null ? '' : String(loaded.cookMinutes));
    // Keyed on the loaded id so prefill runs once per recipe, not on background refetch.
  }, [loaded?.id]);

  function toggleMeal(meal: MealType) {
    setMealTypes((prev) =>
      prev.includes(meal) ? prev.filter((m) => m !== meal) : sortRecipeTypes([...prev, meal]),
    );
  }

  function updateStep(index: number, value: string) {
    setSteps((prev) => prev.map((s, i) => (i === index ? value : s)));
  }

  function addStep() {
    setSteps((prev) => [...prev, '']);
  }

  function removeStep(index: number) {
    setSteps((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  function moveStep(index: number, direction: -1 | 1) {
    setSteps((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  // Non-empty ingredient lines (raw), used for both the preview and the payload.
  const ingredientLines = ingredientsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // The household's tags this recipe mentions, offered under the Tags box and never added
  // until tapped. An editor has no site keywords, so it is title and ingredients only.
  const tagList = trpc.tag.all.useQuery();
  const colorOf = useTagColors();
  const tagSuggestions = useMemo(() => {
    const existing = (tagList.data ?? []).map((t) => t.name);
    const { chosen, offered } = suggestTags(
      { title, ingredientLines: ingredientsText.split('\n'), siteTags: [] },
      existing,
    );
    return [...chosen, ...offered];
  }, [tagList.data, title, ingredientsText]);

  const sourceUrl = sourceUrlInput(sourceUrlText);
  const canSave = title.trim().length > 0 && sourceUrl !== 'invalid' && !mutation.isPending;

  const recipes = library.data ?? [];
  const recipeById = new Map(recipes.map((r) => [r.id, r]));
  const recipeByKey = new Map(recipes.map((r) => [recipeTitleKey(r.title), r]));
  const pickerText = pickerLine === null ? '' : (ingredientsText.split('\n')[pickerLine] ?? '');
  const pickerSplit = splitRecipeLink(pickerText);

  // The recipe a token means: the one picked or loaded for that title, else the library's only
  // recipe with that title.
  function linkedRecipeOf(linkTitle: string | null) {
    if (linkTitle === null) return null;
    const key = recipeTitleKey(linkTitle);
    const id = linkIds.get(key);
    return (id === undefined ? undefined : recipeById.get(id)) ?? recipeByKey.get(key) ?? null;
  }

  function openPicker() {
    const box = ingredientsRef.current;
    setPickerLine(lineIndexAt(ingredientsText, box?.selectionStart ?? ingredientsText.length));
  }

  // Write the picked link into the line, close the picker and put the caret back at the end of
  // that line, so the cook carries on typing where they were.
  function applyLink(picked: { id: string; title: string } | null) {
    if (pickerLine === null) return;
    if (picked) setLinkIds((prev) => new Map(prev).set(recipeTitleKey(picked.title), picked.id));
    const next = setLineLink(ingredientsText, pickerLine, picked?.title ?? null);
    setIngredientsText(next.text);
    setPickerLine(null);
    requestAnimationFrame(() => {
      const box = ingredientsRef.current;
      box?.focus();
      box?.setSelectionRange(next.caret, next.caret);
    });
  }

  function closePicker() {
    setPickerLine(null);
    requestAnimationFrame(() => ingredientsRef.current?.focus());
  }

  // A refused link (a missing or shared title, a cycle) comes back as a sentence worth showing,
  // under a code input validation never uses. Anything else gets the general message.
  const saveError =
    mutation.error?.data?.code === 'UNPROCESSABLE_CONTENT'
      ? mutation.error.message
      : 'Couldn’t save this recipe. Please try again.';

  async function handleSave() {
    if (!canSave) return;
    const input = {
      title: title.trim(),
      servings,
      mealTypes,
      tags,
      ingredientLines,
      ingredientLinks: ingredientLines.map(
        (line) => linkedRecipeOf(splitRecipeLink(line).linkTitle)?.id ?? null,
      ),
      steps: steps.map((s) => s.trim()).filter((s) => s.length > 0),
      sourceName: sourceName.trim() || null,
      sourceUrl: sourceUrl.url,
      description: description.trim() || null,
      prepMinutes: minutesOrNull(prepText),
      cookMinutes: minutesOrNull(cookText),
    };

    if (isEdit) {
      if (!loadedId) return;
      const result = await updateMutation.mutateAsync({ id: loadedId, ...input });
      // Update keeps the slug stable; fall back to the route slug.
      navigate(`/recipes/${result?.slug ?? slug}`);
    } else {
      const result = await createMutation.mutateAsync(input);
      navigate(`/recipes/${result.slug}`);
    }
  }

  if (isEdit && existing.isLoading) {
    return (
      <section className={styles.editor}>
        <p className={styles.status}>Loading recipe…</p>
      </section>
    );
  }

  return (
    <section className={styles.editor}>
      <h1 className={styles.title}>{isEdit ? 'Edit recipe' : 'New recipe'}</h1>

      {/* Fields grouped into cards (D49), so a long form reads as four parts, not one list. */}
      <div className={styles.group}>
        <h2 className={styles.groupTitle}>Basics</h2>
        <label className={styles.field}>
          <span className={styles.label}>Title</span>
          <input
            type="text"
            className={styles.input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. White Bean Soup"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Servings</span>
          <input
            type="number"
            min={1}
            className={styles.input}
            value={servings}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              setServings(Number.isNaN(n) || n < 1 ? 1 : n);
            }}
          />
        </label>

        <fieldset className={styles.field}>
          <legend className={styles.label}>Recipe type</legend>
          <div className={styles.chips}>
            {MEAL_TYPES.map((meal) => (
              <label key={meal} className={styles.chip}>
                <input
                  type="checkbox"
                  checked={mealTypes.includes(meal)}
                  onChange={() => toggleMeal(meal)}
                />
                <span>{meal}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="recipe-tags">
            Tags
          </label>
          <TagInput
            id="recipe-tags"
            label="Tags"
            value={tags}
            onChange={setTags}
            known={tagList.data ?? []}
          />
        </div>
        <TagSuggestionChips
          names={notYetTagged(tagSuggestions, tags)}
          colorOf={colorOf}
          onAdd={(name) => setTags((current) => [...current, name])}
        />
      </div>

      <div className={styles.group}>
        <h2 className={styles.groupTitle}>Details</h2>
        <SourceField
          value={sourceName}
          onChange={setSourceName}
          fieldClassName={styles.field}
          labelClassName={styles.label}
          inputClassName={styles.input}
        />

        <label className={styles.field}>
          <span className={styles.label}>Source link</span>
          <input
            type="url"
            inputMode="url"
            className={styles.input}
            value={sourceUrlText}
            onChange={(e) => setSourceUrlText(e.target.value)}
            placeholder="https://…"
            aria-invalid={sourceUrl === 'invalid'}
            aria-describedby={sourceUrl === 'invalid' ? 'source-url-error' : undefined}
          />
          {sourceUrl === 'invalid' && (
            <span id="source-url-error" className={styles.error}>
              That doesn’t look like a web address.
            </span>
          )}
        </label>

        <div className={styles.timeRow}>
          <label className={styles.field}>
            <span className={styles.label}>Prep minutes</span>
            <input
              type="number"
              min={0}
              inputMode="numeric"
              className={styles.input}
              value={prepText}
              onChange={(e) => setPrepText(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Cook minutes</span>
            <input
              type="number"
              min={0}
              inputMode="numeric"
              className={styles.input}
              value={cookText}
              onChange={(e) => setCookText(e.target.value)}
            />
          </label>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>Notes</span>
          <textarea
            className={styles.input}
            rows={3}
            value={description}
            maxLength={5000}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Anything worth remembering: who it's from, what to change next time"
          />
        </label>
      </div>

      <div className={`${styles.group} ${styles.field}`}>
        <h2 className={styles.groupTitle}>Ingredients</h2>
        <div className={styles.ingredientsRow}>
          <textarea
            ref={ingredientsRef}
            className={styles.textarea}
            value={ingredientsText}
            onChange={(e) => {
              const { value, selectionStart } = e.target;
              // Typing `[[` opens the picker and the two brackets go, so nothing half-typed is
              // left in the line. Any other edit closes an open picker: the line it was linking
              // may have moved.
              if (openedLinkAt(value, selectionStart)) {
                setIngredientsText(
                  value.slice(0, selectionStart - 2) + value.slice(selectionStart),
                );
                setPickerLine(lineIndexAt(value, selectionStart));
              } else {
                setIngredientsText(value);
                setPickerLine(null);
              }
            }}
            rows={8}
            placeholder={'2 cups flour\n1 tsp salt\n3 cloves garlic, minced'}
            aria-label="Ingredients, one per line"
          />
          <div className={styles.preview} aria-label="Parsed ingredient preview">
            <span className={styles.previewHint}>Parsed preview</span>
            {ingredientLines.length === 0 ? (
              <p className={styles.previewEmpty}>
                Type ingredients to see how they’ll be understood.
              </p>
            ) : (
              <ul className={styles.previewList}>
                {ingredientLines.map((line, i) => {
                  const { text, linkTitle } = splitRecipeLink(line);
                  const parsed = parseIngredientLine(text);
                  const linked = linkedRecipeOf(linkTitle);
                  return (
                    <li key={i} className={styles.previewItem}>
                      <span className={styles.previewMain}>{previewLabel(parsed)}</span>
                      {parsed.note && <span className={styles.previewNote}>{parsed.note}</span>}
                      {linked && (
                        <Link to={`/recipes/${linked.slug}`} className={styles.previewLink}>
                          → {linked.title}
                        </Link>
                      )}
                      {linkTitle !== null && !linked && library.isSuccess && (
                        <span className={styles.previewBadLink}>
                          No recipe called “{linkTitle}”
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        {pickerLine === null ? (
          <button type="button" className={styles.linkButton} onClick={openPicker}>
            Link a recipe to this line
          </button>
        ) : (
          <RecipeLinkPicker
            recipes={recipes}
            excludeId={loadedId}
            lineLabel={pickerSplit.text}
            linkedTitle={pickerSplit.linkTitle}
            onPick={applyLink}
            onRemove={() => applyLink(null)}
            onClose={closePicker}
          />
        )}
        <p className={styles.hint}>
          Put the cursor on a line, or type <kbd>[[</kbd>, to link a recipe it is made from. Its
          ingredients go on the shopping list in the line’s place.
        </p>
      </div>

      <div className={`${styles.group} ${styles.field}`}>
        <h2 className={styles.groupTitle}>Steps</h2>
        <ol className={styles.steps}>
          {steps.map((step, i) => (
            <li key={i} className={styles.stepRow}>
              {/* A textarea that grows with its step: a one-line input cut long steps off. */}
              <textarea
                className={`${styles.input} ${styles.stepText}`}
                rows={2}
                value={step}
                onChange={(e) => updateStep(i, e.target.value)}
                placeholder={`Step ${i + 1}`}
                aria-label={`Step ${i + 1}`}
              />
              <div className={styles.stepButtons}>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => moveStep(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move step ${i + 1} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => moveStep(i, 1)}
                  disabled={i === steps.length - 1}
                  aria-label={`Move step ${i + 1} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => removeStep(i)}
                  disabled={steps.length === 1}
                  aria-label={`Remove step ${i + 1}`}
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ol>
        <button type="button" className={styles.addStep} onClick={addStep}>
          + Add step
        </button>
      </div>

      {mutation.isError && (
        <p className={styles.error} role="alert">
          {saveError}
        </p>
      )}

      {/* Save stays in reach at the bottom of the screen, above the tab bar, however long the
          recipe is. */}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.saveButton}
          onClick={handleSave}
          disabled={!canSave}
        >
          {mutation.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}
