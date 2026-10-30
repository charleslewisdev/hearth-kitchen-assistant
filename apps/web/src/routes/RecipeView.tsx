import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { trpc } from '../lib/trpc';
import { departmentStyle } from '../lib/departments';
import { amountText, hasSecondMeasure, useMeasureSystem } from '../lib/measure-system';
import { sourceSite } from '../lib/source-url';
import { isBuildingBlock, tagStyle, typeLabels, useTagColors } from '../lib/tags';
import { PlanThisRecipe } from './PlanThisRecipe';
import { PrintSheet, ShareButtons } from './RecipeShare';
import { RecipePhotos } from './RecipePhotos';
import { CookLog } from './CookLog';
import { StarRating } from './StarRating';
import { fileUrl } from '../lib/photo-upload';
import styles from './RecipeView.module.css';
import { useDocumentTitle } from '../lib/useDocumentTitle';

type Pane = 'ingredients' | 'steps';

// Recipe View — read screen with a servings scaler that drives both the displayed
// ingredient amounts and the servings sent to the shopping list. A segmented
// control toggles between the ingredients and the steps panes.
export function RecipeView() {
  const { slug } = useParams();
  const recipeQuery = trpc.recipe.get.useQuery({ idOrSlug: slug ?? '' });
  useDocumentTitle(recipeQuery.data?.title);
  const colorOf = useTagColors();
  const addRecipe = trpc.shoppingList.addRecipe.useMutation();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const cookLog = trpc.cookLog.list.useQuery(
    { recipeId: recipeQuery.data?.id ?? '' },
    { enabled: Boolean(recipeQuery.data?.id) },
  );
  const setRating = trpc.recipe.setRating.useMutation({
    onSuccess: () => Promise.all([utils.recipe.get.invalidate(), utils.recipe.list.invalidate()]),
  });
  const deleteRecipe = trpc.recipe.delete.useMutation({
    onSuccess: () => {
      void utils.recipe.list.invalidate();
      void utils.plan.week.invalidate();
      navigate('/recipes');
    },
  });
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // The recipes this one's lines are made from, in line order, for Share and Print to include:
  // someone without Hearth cannot follow "8 Simple Tortillas" to the tortilla recipe.
  const linkedSlugs = [
    ...new Set(
      // The server returns lines in position order.
      (recipeQuery.data?.ingredients ?? [])
        .map((ing) => ing.linkedRecipe?.slug)
        .filter((s): s is string => s !== undefined && s !== recipeQuery.data?.slug),
    ),
  ];
  const linkedQueries = trpc.useQueries((t) =>
    linkedSlugs.map((linkedSlug) => t.recipe.get({ idOrSlug: linkedSlug })),
  );

  // Target servings the cook is scaling to; seeded from the recipe's base once loaded.
  const [targetServings, setTargetServings] = useState<number | null>(null);
  const [pane, setPane] = useState<Pane>('ingredients');
  const [measureSystem, setMeasureSystem] = useMeasureSystem();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [addError, setAddError] = useState(false);

  if (recipeQuery.isLoading) {
    return (
      <section className={styles.view}>
        <p className={styles.status}>Loading recipe…</p>
      </section>
    );
  }

  if (recipeQuery.isError) {
    return (
      <section className={styles.view}>
        <p className={styles.error} role="alert">
          Couldn’t load this recipe. Please try again.
        </p>
      </section>
    );
  }

  const recipe = recipeQuery.data;
  if (!recipe) {
    return (
      <section className={styles.view}>
        <p className={styles.status}>Recipe not found.</p>
      </section>
    );
  }

  // Fall back to the recipe's base servings until the stepper is first touched.
  const servings = targetServings ?? recipe.servings;
  const trend = (cookLog.data ?? [])
    .filter((entry) => entry.rating !== null)
    .slice(0, 5)
    .map((entry) => entry.rating)
    .reverse();
  const source = sourceSite(recipe.sourceUrl);
  const recipeId = recipe.id;
  // What Share and Print send: the recipe as it is on screen, scaled and measured.
  const shareView = { servings, system: measureSystem };
  const shared = {
    ...recipe,
    linkedRecipes: linkedQueries.flatMap((q) => (q.data ? [q.data] : [])),
  };

  async function handleAddToList() {
    setConfirmation(null);
    setAddError(false);
    try {
      await addRecipe.mutateAsync({ recipeId, servings });
      setConfirmation('Added to your shopping list.');
    } catch {
      setAddError(true);
    }
  }

  return (
    <section className={styles.view}>
      <PrintSheet recipe={shared} view={shareView} coverFileId={recipe.coverFileId} />
      {/* The header band (D49): back and edit, pills, the title, then the numbers a cook
          checks first, with the servings stepper as one of them. */}
      <header className={styles.band}>
        <div className={styles.bandBar}>
          <Link to="/recipes" className={styles.roundButton} aria-label="Back to recipes">
            <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.barIcon}>
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </Link>
          <div className={styles.bandActions}>
            <ShareButtons
              recipe={shared}
              view={shareView}
              waiting={linkedQueries.some((q) => q.isLoading)}
            />
            <Link to={`/recipes/${recipe.slug}/edit`} className={styles.pillButton}>
              Edit
            </Link>
          </div>
        </div>

        {recipe.coverFileId && (
          <img className={styles.cover} src={fileUrl(recipe.coverFileId, 'full')} alt="" />
        )}

        {(recipe.mealTypes.length > 0 || recipe.tags.length > 0) && (
          <ul className={styles.pills}>
            {typeLabels(recipe.mealTypes).map(({ type, label }) => (
              <li
                key={type}
                className={styles.typePill}
                data-block={isBuildingBlock(type) || undefined}
              >
                {label}
              </li>
            ))}
            {recipe.tags.map((tag) => (
              <li key={tag} className={styles.pill} style={tagStyle(tag, colorOf(tag))}>
                {tag}
              </li>
            ))}
          </ul>
        )}

        <h1 className={styles.title}>{recipe.title}</h1>

        {/* The household's own verdict, with how the logged cooks went beside it, oldest to
            newest, so a recipe being dialled in shows its trend. */}
        <div className={styles.rating}>
          <StarRating
            value={recipe.rating}
            label="Your rating"
            onChange={(rating) => setRating.mutate({ id: recipe.id, rating })}
          />
          {trend.length > 0 && (
            <span className={styles.trend}>Recent cooks: {trend.join(' → ')}</span>
          )}
        </div>

        <div className={styles.stats}>
          {recipe.prepMinutes != null && (
            <div className={styles.stat}>
              <span className={styles.statLabel}>Prep</span>
              <span className={styles.statValue}>{recipe.prepMinutes} min</span>
            </div>
          )}
          {recipe.cookMinutes != null && (
            <div className={styles.stat}>
              <span className={styles.statLabel}>Cook</span>
              <span className={styles.statValue}>{recipe.cookMinutes} min</span>
            </div>
          )}
          {/* Servings drive both the ingredient amounts and the add-to-list servings. */}
          <div className={styles.servings}>
            <button
              type="button"
              className={styles.stepperButton}
              onClick={() => setTargetServings(Math.max(1, servings - 1))}
              disabled={servings <= 1}
              aria-label="Decrease servings"
            >
              −
            </button>
            <span className={styles.servingsText}>
              <span className={styles.statLabel}>Serves</span>
              <span className={styles.statValue} aria-label="Servings">
                {servings}
              </span>
            </span>
            <button
              type="button"
              className={styles.stepperButton}
              onClick={() => setTargetServings(servings + 1)}
              aria-label="Increase servings"
            >
              +
            </button>
          </div>
        </div>
      </header>

      {(recipe.description || source || recipe.sourceName) && (
        <div className={styles.about}>
          {recipe.description && <p className={styles.description}>{recipe.description}</p>}
          {/* One line for where it came from: the name the cook gave it, then the link, which
              opens the original page with the photos and comments the recipe left behind. */}
          {(source || recipe.sourceName) && (
            <p className={styles.source}>
              <span className={styles.sourceLabel}>Source</span>
              {recipe.sourceName && <span>{recipe.sourceName}</span>}
              {source && (
                <a
                  href={source.href}
                  title={source.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={styles.sourceLink}
                >
                  {source.site}
                  <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.sourceIcon}>
                    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                  </svg>
                </a>
              )}
            </p>
          )}
        </div>
      )}

      {/* Segmented control: toggles which pane renders. */}
      <div className={styles.segmented} role="tablist" aria-label="Recipe details">
        <button
          type="button"
          role="tab"
          aria-selected={pane === 'ingredients'}
          className={pane === 'ingredients' ? styles.segActive : styles.seg}
          onClick={() => setPane('ingredients')}
        >
          Ingredients
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={pane === 'steps'}
          className={pane === 'steps' ? styles.segActive : styles.seg}
          onClick={() => setPane('steps')}
        >
          Steps
        </button>
      </div>

      {pane === 'ingredients' ? (
        <>
        {hasSecondMeasure(recipe.ingredients) && (
          <div className={styles.measureSwitch} role="radiogroup" aria-label="Measures">
            {(['us', 'metric'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={measureSystem === option}
                className={measureSystem === option ? styles.measureActive : styles.measure}
                onClick={() => setMeasureSystem(option)}
              >
                {option === 'us' ? 'US' : 'Metric'}
              </button>
            ))}
          </div>
        )}
        <ul className={styles.ingredients}>
          {[...recipe.ingredients]
            .sort((a, b) => a.position - b.position)
            .map((ing) => {
              const amount = amountText(ing, measureSystem, { from: recipe.servings, to: servings });
              return (
                <li
                  key={ing.id}
                  className={ing.linkedRecipe ? styles.linkedIngredient : styles.ingredient}
                  style={departmentStyle(ing.department)}
                >
                  <span className={styles.dot} aria-hidden="true" />
                  <span className={styles.amount}>{amount}</span>
                  <span className={styles.what}>
                    <span className={styles.food}>{ing.foodName ?? ing.linkedRecipe?.title}</span>
                    {ing.note && <span className={styles.note}> {ing.note}</span>}
                    {ing.linkedRecipe && (
                      <Link to={`/recipes/${ing.linkedRecipe.slug}`} className={styles.linkedTo}>
                        Made from {ing.linkedRecipe.title}
                        <span aria-hidden="true"> ›</span>
                      </Link>
                    )}
                  </span>
                </li>
              );
            })}
        </ul>
        </>
      ) : (
        <ol className={styles.steps}>
          {[...recipe.steps]
            .sort((a, b) => a.position - b.position)
            .map((step) => (
              <li key={step.id} className={styles.step}>
                {step.text}
              </li>
            ))}
        </ol>
      )}

      {recipe.usedIn.length > 0 && (
        <p className={styles.usedIn}>
          Used in{' '}
          {recipe.usedIn.map((user, i) => (
            <span key={user.id}>
              {i > 0 && ', '}
              <Link to={`/recipes/${user.slug}`}>{user.title}</Link>
            </span>
          ))}
        </p>
      )}

      <CookLog recipeId={recipeId} servings={servings} />

      <RecipePhotos
        recipeId={recipeId}
        recipeTitle={recipe.title}
        files={recipe.files}
        coverFileId={recipe.coverFileId}
      />

      <PlanThisRecipe recipeId={recipeId} servings={servings} />

      {/* An in-page confirmation rather than window.confirm, which blocks the tab. */}
      <div className={styles.dangerZone}>
        {confirmingDelete ? (
          <div className={styles.confirmDelete} role="group" aria-label="Confirm delete">
            <p>Delete “{recipe.title}”? It also comes off your meal plan. This can’t be undone.</p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.deleteButton}
                disabled={deleteRecipe.isPending}
                onClick={() => deleteRecipe.mutate({ id: recipeId })}
              >
                Yes, delete
              </button>
            </div>
            {deleteRecipe.isError && (
              <p className={styles.error} role="alert">
                Couldn’t delete this recipe. Please try again.
              </p>
            )}
          </div>
        ) : (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete recipe
          </button>
        )}
      </div>

      {/*
        Sticky primary action (D26). The servings ride along in the URL: cook mode scales the
        ingredient peek to them, and a query parameter is what survives the reload or the shared
        link that router location state does not.
      */}
      <div className={styles.stickyBar}>
        {/* Feedback lives in the bar, beside the button that caused it: in the page flow it
            landed below the fold, and a cook who saw nothing tapped again. */}
        {confirmation && (
          <p className={styles.confirmation} role="status">
            {confirmation}
          </p>
        )}
        {addError && (
          <p className={styles.error} role="alert">
            Couldn’t add this recipe to your shopping list. Please try again.
          </p>
        )}
        <div className={styles.barButtons}>
          <button
            type="button"
            className={styles.barSecondary}
            onClick={handleAddToList}
            disabled={addRecipe.isPending}
          >
            {addRecipe.isPending ? 'Adding…' : 'Add to list'}
          </button>
          <Link
            to={`/recipes/${recipe.slug}/cook?servings=${servings}`}
            className={styles.cookButton}
          >
            Start cooking
          </Link>
        </div>
      </div>
    </section>
  );
}
