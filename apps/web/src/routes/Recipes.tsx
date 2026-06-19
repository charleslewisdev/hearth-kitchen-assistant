import { useState } from 'react';
import { trpc } from '../lib/trpc';

export function Recipes() {
  const list = trpc.recipe.list.useQuery();
  const utils = trpc.useUtils();
  const create = trpc.recipe.create.useMutation({
    onSuccess: () => utils.recipe.list.invalidate(),
  });
  const [title, setTitle] = useState('');
  return (
    <section>
      <h1>Recipes</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title) {
            create.mutate({ title });
            setTitle('');
          }
        }}
      >
        <input
          placeholder="New recipe title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit">Add</button>
      </form>
      <ul>
        {list.data?.map((r) => (
          <li key={r.id}>{r.title}</li>
        ))}
      </ul>
    </section>
  );
}
