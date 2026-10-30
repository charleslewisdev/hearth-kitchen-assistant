# Hearth visual overhaul: Market layout, Cookbook warmth

_2026-09-24. Decision D49. Supersedes the visual parts of the [P0/P1 UI spec](2026-06-17-ui-design-p0-p1-design.md) (its "Fresh Market" palette and system font); its structure (D25 shell, D26 recipe and cook mode, D27 planner, D30 library) stands._

## Why

The first real week of use showed the UI works but reads as a prototype: every screen is the same flat card, type has one weight and size, the nav uses emoji, and nothing tells a cookbook recipe from a shopping list. The owner asked for the look to be settled before more features land.

Three directions were mocked up on the same two screens (recipe view, shopping list) with real data: **A Cookbook** (warm paper, serif), **B Counter** (dark, huge targets), **C Market** (bright, colour-coded departments). The owner ranked C, then A, then B, and chose a hybrid: **C's layout and colour-coded departments, with A's serif titles and warm paper palette.** The mockups are on a private canvas (artboards `D-Recipe` and `D-List`).

## The system

Everything below is a token in `apps/web/src/styles/tokens.css`. Components use roles, never hex (D24 stands).

### Colour, light

| Role                 | Token                                             | Value                | Notes                                   |
| -------------------- | ------------------------------------------------- | -------------------- | --------------------------------------- |
| Page                 | `--color-bg`                                      | `#F6F1E7`            | warm paper                              |
| Card                 | `--color-surface`                                 | `#FFFDF8`            |                                         |
| Sunken / header band | `--color-surface-2`                               | `#EFE7D8`            |                                         |
| Hairline             | `--color-border`                                  | `#E4DACB`            |                                         |
| Ink                  | `--color-text`                                    | `#231F1A`            | 14.6:1 on bg                            |
| Secondary ink        | `--color-text-muted`                              | `#6B6257`            | 5.3:1 on bg                             |
| Action               | `--color-accent`                                  | `#2A7454`            | 5.0:1 as text on bg, white on it 5.6:1  |
| On action            | `--color-on-accent`                               | `#FFFFFF`            | new token; replaces the `#fff` literals |
| Selected / soft      | `--color-accent-soft`, `--color-accent-soft-text` | `#E3EFE6`, `#1F5A40` |                                         |

Status colours keep their meaning (leftover amber, frozen blue, flag amber) and move to the warmer family.

### Colour, dark

A warm dark, not a neutral one: `bg #1A1714`, `surface #23201B`, `surface-2 #2C2721`, `border #3A332B`, `text #F1EBE0`, `muted #B3A999`, `accent #5DBB8C` with `on-accent #10231A`. Dark mode stays a parallel token set chosen by `data-theme` (D24).

### Departments

Each shopping department gets a tint (section header background) and an ink (its label and dot). Light / dark:

| Department     | Tint                  | Ink                   |
| -------------- | --------------------- | --------------------- |
| Produce        | `#E4F1E6` / `#1E2F22` | `#2D6A3E` / `#9ED3AC` |
| Bakery         | `#F5E9D6` / `#33291C` | `#7A5418` / `#E3C08A` |
| Meat & Seafood | `#F8E3E1` / `#3A2220` | `#9B3A30` / `#EFA79E` |
| Dairy          | `#E6EEF8` / `#1E2835` | `#2A5486` / `#A5C4EA` |
| Frozen         | `#E1F0F3` / `#1B2E32` | `#1F6570` / `#9AD3DC` |
| Pantry         | `#F7ECDD` / `#35291B` | `#8A5A1C` / `#E7BF85` |
| Baking         | `#F3E6EC` / `#33222A` | `#8A3D5E` / `#E6A9C3` |
| Beverages      | `#ECE8F6` / `#26223A` | `#50428E` / `#BDB2EC` |
| Other          | `--color-surface-2`   | `--color-text-muted`  |

Every department ink passes 5:1 on its tint in both themes; "Other" uses the muted ink on `surface-2`, 4.9:1 in light. The name is always written out, so colour is never the only signal. The same dot marks an ingredient's department on the recipe screen.

### Type

- **Fraunces** (variable, opsz 9–144) for titles: screen headings, recipe titles, section headings. Weight 600; italic 400 for a recipe's subtitle.
- **Figtree** (variable) for everything else. 16px body, 600 for labels, 700 for amounts and buttons.
- Both are **bundled with the app** through `@fontsource-variable/*`, latin subset only. No request leaves the box (Principle 1), and they work offline (Principle 2). Fallbacks: Georgia for Fraunces, `system-ui` for Figtree.
- Scale: 34–44 recipe title (scales with the screen width), 34 screen title, 22 section, 17 large body, 16 body, 14 secondary, 13 caption. Amounts use tabular figures.

### Shape and spacing

- Radius: 18 for cards (`--radius-card`), fully round for pills and primary buttons (`--radius-pill`), 14 for inputs and small panels (`--radius`, kept from D24).
- Spacing on a 4px grid; screen gutter 16–20px on a phone.
- Every tap target is at least 44px high.

### Components

- **Primary button:** filled accent pill, 56px tall on the action bar. The action bar carries its own status line, so feedback shows beside the button that caused it.
- **Secondary button:** outlined pill on surface.
- **Section card:** surface, hairline border, radius 18. Rows inside it are divided by hairlines, not boxed one by one.
- **Header band:** the recipe screen opens on a `surface-2` band with round back and edit buttons, meal and tag pills (`--color-tag-ink`), the Fraunces title, and stat tiles: prep and cook time when the recipe records them, and the servings stepper. The mockup's oven tile waits for an oven-temperature field.
- **Linked ingredient:** the line keeps its place in the ingredients card, on a soft band, with "Made from <recipe> ›" under it. The mockup's chips of what the linked recipe adds to the list are deferred: `recipe.get` does not return the linked recipe's ingredients yet.
- **Nav icons:** inline stroke SVG, replacing the emoji.

## Order of work

Each step is a PR with screenshot checks at 390px and 1280px.

1. **Foundation, recipe screen and shopping list** (this first PR):
   - tokens (light and dark), bundled fonts, and the SVG nav;
   - recipe view and shopping list restyled to match the mockups;
   - two audit bugs fixed: the sticky "Start cooking" bar covering "Delete recipe", and the step editor showing long steps as one clipped line.
2. **Library:** cards with time and tags, remove the unexplained checkbox (or say what it does), and a tighter grid.
3. **Editor and import review:** the new form styles and the ingredient editor.
4. **Plan:** collapse empty meal slots so an empty week isn't 21 "+ Add" rows.
5. **Cook mode:** new type and palette only. It is already the strongest screen.
6. **Shopping amounts:** show "⅓ cup" rather than "0.29 cup" (a `packages/shared` change, separate because it is logic, not look).
