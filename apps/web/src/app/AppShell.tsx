import type { ReactNode } from 'react';
import styles from './AppShell.module.css';

const DESTINATIONS = [
  { key: 'recipes', label: 'Recipes', icon: '📖' },
  { key: 'plan', label: 'Plan', icon: '📅' },
  { key: 'shop', label: 'Shop', icon: '🛒' },
  { key: 'more', label: 'More', icon: '☰' },
] as const;

export function AppShell({
  active,
  onNavigate,
  children,
}: {
  active: string;
  onNavigate: (k: string) => void;
  children: ReactNode;
}) {
  return (
    <div className={styles.shell}>
      <nav className={styles.rail} aria-label="Primary">
        <div className={styles.brand}>Hearth</div>
        <button className={styles.add}>＋ Add / Import</button>
        {DESTINATIONS.map((d) => (
          <button
            key={d.key}
            aria-current={active === d.key}
            className={styles.item}
            onClick={() => onNavigate(d.key)}
          >
            <span aria-hidden>{d.icon}</span>
            {d.label}
          </button>
        ))}
      </nav>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
