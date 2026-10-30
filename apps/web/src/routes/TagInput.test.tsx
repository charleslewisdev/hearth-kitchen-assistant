import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TagInput, type KnownTag } from './TagInput';

const KNOWN: KnownTag[] = [
  { name: 'Chicken', normalizedName: 'chicken', color: null, uses: 4 },
  { name: 'Chickpea', normalizedName: 'chickpea', color: null, uses: 1 },
  { name: 'Italian', normalizedName: 'italian', color: 'blue', uses: 11 },
  { name: 'Quick & easy', normalizedName: 'quick & easy', color: null, uses: 2 },
];

let latest: string[] = [];

function Harness({ initial = [] as string[] }) {
  const [tags, setTags] = useState(initial);
  latest = tags;
  return (
    <>
      <label htmlFor="t">Tags</label>
      <TagInput id="t" label="Tags" value={tags} onChange={setTags} known={KNOWN} />
    </>
  );
}

const box = () => screen.getByRole('combobox', { name: 'Tags' });
const chips = () =>
  within(screen.getByRole('list', { name: 'Tags on this recipe' }))
    .queryAllByRole('listitem')
    .map((li) => li.firstChild?.textContent);

function type(text: string) {
  fireEvent.focus(box());
  fireEvent.change(box(), { target: { value: text } });
}

describe('TagInput', () => {
  it('lists the household’s matching tags, prefix first, with how many recipes use each', () => {
    render(<Harness />);
    type('chick');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'Chicken4 recipes',
      'Chickpea1 recipe',
      '+ Create new tag “chick”',
    ]);
  });

  it('takes the highlighted tag on Enter, as the household spells it', () => {
    render(<Harness />);
    type('chick');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(latest).toEqual(['Chicken']);
    expect(box()).toHaveValue('');
  });

  it('folds plurals and case onto an existing tag instead of offering a new one', () => {
    render(<Harness />);
    type('CHICKENS');
    expect(screen.queryByText(/Create new tag/)).toBeNull();
    fireEvent.keyDown(box(), { key: ',' });
    expect(latest).toEqual(['Chicken']);
  });

  it('takes the text as typed on a comma, not the highlighted longer tag', () => {
    render(<Harness />);
    type('ital');
    fireEvent.keyDown(box(), { key: ',' });
    expect(latest).toEqual(['ital']);
  });

  it('marks a tag the household does not have yet as new', () => {
    render(<Harness />);
    type('weeknight');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent(
      'Create new tag “weeknight”',
    );
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(latest).toEqual(['weeknight']);
    expect(screen.getByText('new')).toBeInTheDocument();
  });

  it('picks an option with the mouse without keeping the half-typed text', () => {
    render(<Harness />);
    type('ital');
    fireEvent.mouseDown(screen.getByRole('option', { name: /Italian/ }));
    fireEvent.blur(box());
    expect(latest).toEqual(['Italian']);
  });

  it('keeps typed text as a tag when the box is left, so Save loses nothing', () => {
    render(<Harness />);
    type('Soup');
    fireEvent.blur(box());
    expect(latest).toEqual(['Soup']);
  });

  it('splits a pasted list, skips duplicates, and removes with Backspace or the cross', () => {
    render(<Harness initial={['Italian']} />);
    type('italian, Vegan, vegan, Pork');
    expect(latest).toEqual(['Italian', 'Vegan']);
    expect(box()).toHaveValue('Pork');
    fireEvent.change(box(), { target: { value: '' } });
    fireEvent.keyDown(box(), { key: 'Backspace' });
    expect(latest).toEqual(['Italian']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag Italian' }));
    expect(latest).toEqual([]);
    expect(chips()).toEqual([]);
  });

  it('does not offer a tag already on the recipe', () => {
    render(<Harness initial={['Chicken']} />);
    type('chick');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Chickpea1 recipe',
      '+ Create new tag “chick”',
    ]);
  });
});
