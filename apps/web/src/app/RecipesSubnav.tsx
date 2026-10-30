import { NavLink } from 'react-router-dom';
import styles from './RecipesSubnav.module.css';

/**
 * Recipe Book and Tags as two tabs, at the top of both screens, on a phone only. The bottom tab
 * bar has no room to nest, so this strip is what the desktop rail's nested items are there.
 */
export function RecipesSubnav() {
  return (
    <nav className={styles.subnav} aria-label="Recipes">
      <NavLink to="/recipes" end className={styles.tab}>
        Recipe Book
      </NavLink>
      <NavLink to="/tags" className={styles.tab}>
        Tags
      </NavLink>
    </nav>
  );
}
