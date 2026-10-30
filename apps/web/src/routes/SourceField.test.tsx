import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SourceField, similarSource } from './SourceField';

vi.mock('../lib/trpc', () => ({
  trpc: {
    recipe: {
      sourceNames: {
        useQuery: vi.fn(() => ({
          data: [
            { name: 'The Newlywed Cookbook', count: 8 },
            { name: 'The Newlywed Cookbook, p. 12', count: 1 },
            { name: 'King Arthur', count: 4 },
          ],
        })),
      },
    },
  },
}));

function Harness({ initial = '' }) {
  const [value, setValue] = useState(initial);
  return (
    <SourceField
      value={value}
      onChange={setValue}
      inputClassName={undefined}
      labelClassName={undefined}
      fieldClassName={undefined}
    />
  );
}

describe('SourceField', () => {
  it('offers each book the household has used once, most used first', () => {
    const { container } = render(<Harness />);
    const options = [...container.querySelectorAll('datalist option')].map((o) =>
      o.getAttribute('value'),
    );
    expect(options).toEqual(['The Newlywed Cookbook', 'King Arthur']);
    expect(screen.getByLabelText('Source')).toHaveAttribute(
      'list',
      container.querySelector('datalist')!.id,
    );
  });

  it('offers the existing spelling of a book typed another way, keeping the page', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Source'), {
      target: { value: 'newlywed cookbook, p. 54' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Use “The Newlywed Cookbook”/ }));
    expect(screen.getByLabelText('Source')).toHaveValue('The Newlywed Cookbook, p. 54');
    expect(screen.queryByRole('button', { name: /Use “/ })).toBeNull();
  });
});

describe('similarSource', () => {
  const known = ['The Newlywed Cookbook', 'King Arthur'];
  it.each([
    ['Newlywed Cookbook', 'The Newlywed Cookbook'],
    ['the newlywed cookbook', 'The Newlywed Cookbook'],
    ['Newlywed', 'The Newlywed Cookbook'],
    ['king arthur, p. 3', 'King Arthur'],
    ['The Newlywed Cookbook', null],
    ['Joy of Cooking', null],
    ['Ki', null],
  ])('%s → %s', (typed, expected) => {
    expect(similarSource(typed, known)).toBe(expected);
  });
});
