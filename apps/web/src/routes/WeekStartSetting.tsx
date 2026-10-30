import { Link } from 'react-router-dom';
import { trpc } from '../lib/trpc';
import styles from './Household.module.css';

// 0 is Sunday, as the server stores it (D45).
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The household's planner week start, on the More screen. Any member may change it. */
export function WeekStartSetting() {
  const utils = trpc.useUtils();
  const current = trpc.plan.weekStart.useQuery();
  const set = trpc.plan.setWeekStart.useMutation({
    onSuccess: () => {
      void utils.plan.weekStart.invalidate();
      void utils.plan.week.invalidate();
    },
  });

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>Kitchen</h2>
      <label className={styles.weekStart}>
        Weeks start on
        <select
          value={current.data ?? 0}
          disabled={current.isLoading || set.isPending}
          onChange={(e) => set.mutate({ weekStart: Number(e.target.value) })}
        >
          {DAYS.map((day, i) => (
            <option key={day} value={i}>
              {day}
            </option>
          ))}
        </select>
      </label>
      <Link to="/foods" className={styles.foodsLink}>
        Foods: merge duplicates and set store departments
      </Link>
    </div>
  );
}
