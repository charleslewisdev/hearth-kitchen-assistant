import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import styles from './AppShell.module.css';

// Stroke icons drawn in the text colour, so the active tab's colour carries to its icon (D49
// replaced the emoji, which ignored the theme and rendered differently on every platform).
const ICONS = {
  recipes: (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
      <path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" />
    </>
  ),
  plan: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  shop: (
    <>
      <path d="M6 6h15l-1.5 9h-12z" />
      <path d="M6 6 5 3H2" />
      <circle cx="9" cy="20" r="1.3" />
      <circle cx="18" cy="20" r="1.3" />
    </>
  ),
  more: <path d="M4 7h16M4 12h16M4 17h16" />,
} as const;

/** Paths that belong to the Recipes tab: the book, a recipe, the editor, and Tags. */
function inRecipes(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/recipes') || pathname.startsWith('/tags');
}

// Nested under Recipes in the rail. A click on Recipes itself lands on the first, Recipe Book.
const RECIPE_PAGES = [
  {
    to: '/recipes',
    label: 'Recipe Book',
    active: (p: string) => inRecipes(p) && !p.startsWith('/tags'),
  },
  { to: '/tags', label: 'Tags', active: (p: string) => p.startsWith('/tags') },
] as const;

const DESTINATIONS = [
  { to: '/recipes', label: 'Recipes', icon: ICONS.recipes },
  { to: '/plan', label: 'Plan', icon: ICONS.plan },
  { to: '/shop', label: 'Shop', icon: ICONS.shop },
  { to: '/more', label: 'More', icon: ICONS.more },
] as const;

export function AppShell() {
  const { pathname } = useLocation();
  return (
    <div className={styles.shell}>
      <nav className={styles.rail} aria-label="Primary">
        <div className={styles.brand}>Hearth</div>
        {/*
          Points at the import screen rather than straight at the blank form, now that there is
          one. The label already said "Add / Import"; this is what makes that true. Typing a
          recipe in by hand is the last tile there, so the old destination is one press away.
        */}
        <Link to="/import" className={styles.add}>
          + Add / Import
        </Link>
        {DESTINATIONS.map((d) => {
          const icon = (
            <svg
              className={styles.icon}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {d.icon}
            </svg>
          );
          if (d.to !== '/recipes') {
            return (
              <NavLink key={d.to} to={d.to} className={styles.item}>
                {icon}
                {d.label}
              </NavLink>
            );
          }
          // Recipes is active for all of its pages, Tags included, which a NavLink's own
          // prefix match would miss; so it sets aria-current itself.
          const active = inRecipes(pathname);
          return (
            <div key={d.to} className={styles.group}>
              <Link to={d.to} className={styles.item} aria-current={active ? 'page' : undefined}>
                {icon}
                {d.label}
              </Link>
              <div className={styles.subItems}>
                {RECIPE_PAGES.map((page) => (
                  <Link
                    key={page.to}
                    to={page.to}
                    className={styles.subItem}
                    aria-current={page.active(pathname) ? 'page' : undefined}
                  >
                    {page.label}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </nav>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
