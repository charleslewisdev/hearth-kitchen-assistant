# Adding recipes by hand

Typing a recipe in is the most reliable way to add one. It is also the fallback when an import
does not come out right. This page also explains how Hearth reads ingredient lines, which matters
for imports too, because every import ends in the same kind of form.

To start, press **+ Add / Import**, then **By hand**.

## The form

| Field           | What to put                                                                   |
| --------------- | ----------------------------------------------------------------------------- |
| **Title**       | Required. Everything else is optional.                                        |
| **Servings**    | How many people the recipe feeds as written. A whole number, 1 or more.       |
| **Recipe type** | Tick any of breakfast, lunch, dinner, snack, dessert, side, drink, sauce, base. Used by the filters. |
| **Tags**        | Start typing: your matching tags drop down with how many recipes use each. **Enter** picks the highlighted one, a comma keeps what you typed. A tag you don't have yet shows as a dashed chip marked **new**. Tags you already use that the recipe mentions show below as **Suggested**. |
| **Source**      | Where it came from by name: `Joy of Cooking, p. 212`, `King Arthur`. Sources you've used before are suggested as you type, and if you type a book another way ("Newlywed Cookbook" for "The Newlywed Cookbook"), Hearth offers the spelling you already use. |
| **Source link** | The web address it came from, if any. `www.` addresses without `https://` are fine. |
| **Prep / Cook minutes** | Optional. Shown under the title.                                      |
| **Notes**       | Anything worth remembering: who it is from, what to change next time.         |
| **Ingredients** | One ingredient per line. A preview shows how Hearth reads each line.          |
| **Steps**       | One box per step. **+ Add step** adds a box.                                  |

Press **Save** at the bottom. Hearth opens the saved recipe.

Servings matter. Scaling and the shopping list both work from this number. If a recipe says
"makes 24 cookies", decide what one serving is for your family, or enter 24 and treat each cookie
as a serving.

**Side, drink, sauce and base** are for recipes that go into or alongside another: a side dish, a
drink, a sauce or dressing, and a base such as a stock, a dough or a spice mix.

Tags are matched without regard to capital letters or a plural, so `Soup`, `soup` and `soups` are
one tag, and typing any of them picks the one you have. A tag cannot contain a comma. To rename, recolour, merge or delete tags, use
**Recipes → Tags** (see [Cooking](cooking.md#tags)).

To change a recipe later, open it and press **Edit**.

To delete a recipe, open it and press **Delete recipe** at the bottom, then **Yes, delete**. It
also comes off the meal plan. This cannot be undone.

## How Hearth reads an ingredient line

Hearth splits each line into four parts:

1. **Amount**: a number at the start of the line.
2. **Unit**: the word right after the amount, if Hearth knows it as a unit.
3. **Food**: what is left.
4. **Note**: anything in parentheses, anything after a comma, a trailing "to taste" or "to
   serve", and the size, freshness and preparation words described below.

As you type, the **Parsed preview** next to the box shows each line as `amount · unit · food`,
with the note underneath. Check it before you save. The food is what the shopping list uses to
add up ingredients across recipes, so a wrong food means a messy list.

Examples:

| You type                              | Amount | Unit | Food                | Note                 |
| ------------------------------------- | ------ | ---- | ------------------- | -------------------- |
| `2 cups flour`                        | 2      | cup  | flour               |                      |
| `1 1/2 tsp salt`                      | 1 ½    | tsp  | salt                |                      |
| `3 cloves garlic, minced`             | 3      | clove | garlic             | minced               |
| `3 large cloves garlic`               | 3      | clove | garlic             | large                |
| `1 cup finely chopped fresh parsley`  | 1      | cup  | parsley             | finely chopped fresh |
| `one 14-ounce can chickpeas`          | 1      | can  | chickpeas           | 14-ounce             |
| `1 (14 oz) can diced tomatoes`        | 1      | can  | diced tomatoes      | 14 oz                |
| `Salt and pepper, to taste`           |        |      | Salt and pepper     | to taste             |
| `4 to 5 tablespoons olive oil`        | 4      | tbsp | olive oil           |                      |

### Amounts

Hearth reads whole numbers (`2`), decimals (`1.5`, `.5`), fractions (`1/2`), mixed numbers
(`1 1/2`) and fraction characters (`½`, `1½`).

A range (`2-3`, `4 to 5`, `2 or 3`) is read, but only its **low end** is kept. `4 to 5
tablespoons` is stored as 4. If you want the high end, type it.

Amounts written as words are read at the start of a line: `a`, `an`, `one` to `twelve`, `half`
and `one and a half`. `a green bell pepper` is 1 green bell pepper. Vague words such as `a few`
are not read as an amount. A line that starts with `Pinch`, `Dash` or `Handful` and no number
means one.

### Units

Hearth knows these units, in singular, plural and common short forms:

- cup (`cup`, `cups`, `c`)
- tablespoon (`tbsp`, `tbl`, `tbs`, `tablespoon`, `T` with a capital T)
- teaspoon (`tsp`, `teaspoon`, `t` with a small t)
- gram (`g`), kilogram (`kg`), ounce (`oz`), pound (`lb`, `lbs`)
- millilitre (`ml`), litre (`l`, `liter`, `litre`)
- clove, can, bunch, sprig, stalk, slice, piece, pinch, dash, handful, head, stick, dozen
- package (`pkg`), jar, box, bag, bottle, packet
- pint (`pt`), quart (`qt`), gallon (`gal`), fluid ounce (`fl oz`, `fluid ounces`)

Units show in the plural after more than one: "3 cups", "2 cloves". Short forms (tbsp, g, oz) and
"dozen" stay as they are.

Any other word after the amount becomes part of the food.

### Tips for lines the parser gets wrong

- **Size, freshness and preparation words go to the note by themselves.** In front of the food,
  Hearth moves words such as large, small, medium, baby, fresh, freshly ground, chopped, finely
  chopped, diced, minced, sliced, grated, crumbled, torn, softened, melted, boiling and warm into
  the note, and "at room temperature" at the end. So `2 large eggs` and `3 eggs` are the same food,
  and add up on the shopping list.
- **Words that change what you buy stay in the food:** dried, ground, smoked, frozen, crushed,
  unsalted, whole, heavy, sour, brown, sweet, hot and colours. "ground cumin" and "cumin" are two
  foods, on purpose. So are "yellow onions" and "onions".
- **Check the preview for anything unusual.** If a word you consider a preparation stays in the
  food, move it after a comma: `2 cups spinach, wilted`.
- **Use the same name for the same food.** Hearth ignores capital letters and treats a plural as
  the singular ("Tomatoes" and "tomato" are one food), and "garlic cloves" is read as cloves of
  garlic. It does not know that "scallions" and "green onions" are the same thing. Pick one name
  and stick to it.
- **Split "or" choices into a note.** `1 cup milk (or oat milk)` keeps the food as "milk".
- **Section labels are fine to leave out.** A line like "For the sauce:" becomes a food with no
  amount if you type it in the ingredient box. Leave it out, or put the section in the step text.

## Steps

Each step is its own box. Use the arrows to move a step up or down, and the cross to remove it.
Empty boxes are dropped when you save.

Keep each step to one action or a short group of actions. Cook mode shows one step at a time and
lets you tick them off.

### Timers in step text

When a step mentions a length of time, cook mode turns that phrase into a button that starts a
timer. You do not need to do anything special; write the time as a number followed by a unit.

These become timers:

- `Bake for 25 minutes`, `simmer 10 min`, `rest 30 secs`, `roast 2 hours`, `1 hr`
- `1 hour 10 minutes` (one timer of 1:10:00)
- `20 to 30 minutes`, `5-10 minutes`, `45 minutes to 1 hour` (the timer uses the **longer** time)

These do not:

- Fractions: `1/2 hour`, `1½ hours`. Write `30 minutes` or `90 minutes` instead.
- Words: `half an hour`, `a few minutes`, `overnight`.
- Single letters: `10 m`, `2 h`. Write `min` or `hr`.
- Anything over 24 hours.

## Next

- [Importing recipes](importing.md) for links, pasted text, PDFs and photos.
- [Cooking](cooking.md) for scaling and cook mode.
