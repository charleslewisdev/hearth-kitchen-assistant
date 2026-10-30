import styles from './StarRating.module.css';

/**
 * One to five stars. With `onChange` it is a control: tap a star to set that rating, tap the
 * current one again to clear it. Without, it only shows the rating.
 */
export function StarRating({
  value,
  onChange,
  label = 'Rating',
  size = 'medium',
}: {
  value: number | null;
  onChange?: (rating: number | null) => void;
  label?: string;
  size?: 'small' | 'medium' | 'large';
}) {
  const sizeClass = styles[size];
  if (!onChange) {
    return (
      <span
        className={`${styles.stars} ${sizeClass}`}
        role="img"
        aria-label={value ? `${value} out of 5 stars` : 'Not rated'}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <span
            key={n}
            className={value !== null && n <= value ? styles.on : styles.off}
            aria-hidden="true"
          >
            ★
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className={`${styles.stars} ${sizeClass}`} role="group" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={`${styles.star} ${value !== null && n <= value ? styles.on : styles.off}`}
          aria-label={`${n} ${n === 1 ? 'star' : 'stars'}`}
          aria-pressed={value === n}
          onClick={() => onChange(value === n ? null : n)}
        >
          ★
        </button>
      ))}
    </span>
  );
}
