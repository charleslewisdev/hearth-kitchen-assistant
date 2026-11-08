import { PrintPortal } from '../app/PrintPortal';
import paper from '../app/PrintPortal.module.css';
import styles from './ShoppingListPrint.module.css';

/** One line on the printed list, its amount already written as the list shows it. */
export type PrintedItem = { id: string; name: string; note: string | null; amount: string };

/**
 * The shopping list laid out for paper: the day, then what is still to buy, department by
 * department in the list's own order, each line with a box to tick with a pen. Hidden on screen;
 * the Shop tab's Print prints it, and a browser can also save it as a PDF.
 */
export function ShoppingListPrint({
  sections,
}: {
  sections: Array<{ department: string; items: PrintedItem[] }>;
}) {
  const count = sections.reduce((n, s) => n + s.items.length, 0);
  const day = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return (
    <PrintPortal>
      <h1 className={paper.title}>Shopping list</h1>
      <p className={paper.meta}>
        {day} · {count} {count === 1 ? 'item' : 'items'}
      </p>
      <div className={styles.departments}>
        {sections.map((section) => (
          <section key={section.department} className={styles.department}>
            <h2 className={`${paper.heading} ${styles.heading}`}>{section.department}</h2>
            <ul className={styles.items}>
              {section.items.map((item) => (
                <li key={item.id} className={styles.item}>
                  <span className={styles.box} data-tick-box="" />
                  <span className={styles.name}>
                    {item.name}
                    {item.note && <span className={styles.note}>, {item.note}</span>}
                  </span>
                  {item.amount && <span className={styles.amount}>{item.amount}</span>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </PrintPortal>
  );
}
