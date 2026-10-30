# Planning and shopping

## The shopping list

The household has one shopping list, on the **Shop** tab. Everyone in the household shares it.

### Adding a recipe to the list

1. Open a recipe.
2. Set **Servings** to the number you are cooking for.
3. Press **Add to list** at the bottom of the recipe. Hearth says "Added to your shopping list."

Hearth adds each ingredient at the scaled amount. Water is never added: it is in the recipe, not
in the shop. The list rounds amounts up, so you always buy enough:

- Counted items (cloves, stalks, cans, or a bare "3 eggs") show as whole numbers: 16⅙ cloves of
  garlic shows as 17.
- Cups, spoons, ounces and pounds show to the next quarter or third: 0.29 cup shows as ⅓ cup, and
  3.83 tbsp as 4 tbsp.
- Grams and millilitres show as whole numbers: 187.5 g shows as 188 g.

The list keeps the exact amount underneath, so adding more recipes still sums correctly.

### How amounts are added up

When a recipe's ingredient matches an item already on the list, Hearth adds the amounts together
instead of making a second line. For example, 2 cups of flour from one recipe and 1 cup from
another become 3 cups of flour.

Two lines are added together only when **all** of these are true:

- They are the **same food**. Hearth ignores capital letters, treats plurals as the singular, and
  moves size and preparation words out of the name, so "3 large cloves garlic" and "2 garlic
  cloves" are both garlic (see
  [the ingredient tips](adding-recipes.md#tips-for-lines-the-parser-gets-wrong)).
- They have the **same unit**. 1 cup of milk and 2 tbsp of milk stay on separate lines. Hearth does
  not convert between units.
- Both have an **amount**. "Salt, to taste" always gets its own line.
- The item on the list came from a recipe and is **not checked off**.

Adding the same recipe twice doubles its amounts.

### Adding staples by hand

Type into the box at the top, for example `2 dozen eggs` or `paper towels`, and press **Add**.
Hearth reads the line the same way as a recipe ingredient. A hand-added item always gets its own
line; recipe amounts are never added to it.

### Departments

The list is grouped by store department: Produce, Dairy, Meat & Seafood, Bakery, Baking, Pantry,
Frozen and Beverages. Hearth picks the department from a built-in list of common foods. It also
recognises a known food at the end of a longer name, so "low-sodium chicken broth" goes where
"chicken broth" goes. Anything it does not recognise goes under **Other**, at the bottom.

A food's department is set the first time Hearth sees that food. You cannot change it in the app
yet.

### Tidying foods

**More → Foods** lists every food Hearth knows, with how many recipe lines use it.

- **Department:** pick where you shop for it. Anything under Other moves there on the list too.
- **Edit → Merge into:** fold two names for the same thing into one ("scallions" into "green
  onions"). Recipes keep their wording; the list then adds them up as one.
- **Edit → Rename:** a new name. If another food already has it, Hearth offers a merge instead.
- **Remove N unused foods:** clears foods no recipe uses any more, such as ones left behind after
  editing recipes.

### At the store

- **Tick an item** to check it off. It moves to the **Done** section at the bottom. Tick it again
  to put it back.
- **×** removes one item from the list.
- **Clear checked** removes every checked item, for everyone in the household.

Changes are saved on the server straight away, so every device in the household sees the same
list. A phone with the list open picks up other people's changes within about 5 seconds, so two of
you can shop from the same list at once.

With no signal (a store with patchy reception), ticks, removals and new items still show at once,
a note says you're offline, and they are sent when the phone reconnects. Keep Hearth open while
offline: if the page is closed or reloaded before the signal returns, those changes are lost, and
Hearth can't open at all without a connection.

Amounts cannot be edited on the list. To change one, remove the item and add it again by hand.

## Meal planner

The **Plan** tab shows one week. Each day has three rows: **Breakfast**, **Lunch** and **Dinner**.
Today is outlined.

### Planning meals

- Press **+ Add** on a row, search for a recipe, tap it, set the servings (it starts at the
  recipe's own number), and press **Add to plan**.
- A row can hold more than one recipe, for example a main and a side.
- Change an entry's servings with its **−** and **+** buttons.
- **Move** puts it on another day or meal in the same week. **×** removes it.
- Tap an entry's title to open the recipe.
- **‹ Prev** and **Next ›** step between weeks. **This week** jumps back.
- On a phone the days are a column of cards, and the plan scrolls to today when it opens. On a
  wider screen they sit in a grid.

You can also plan from a recipe: **Add to plan** under the ingredients picks a day in the next two
weeks and a meal, at the servings the recipe is scaled to on screen.

On today's meals and earlier ones, **Cooked it** opens the cook log for that recipe with the day
and servings already filled in, so logging what you made is one tap from the plan.

If a recipe is deleted, it also disappears from the plan.

### Building the shopping list

The button at the top reads **Build shopping list (N new)**. Pressing it adds the week's meals to
the shopping list, scaled to each entry's servings and added up in the same way as adding recipes
one at a time. Hearth then says how many meals it added, with a link to the list.

- Each meal remembers that it was added and shows an **On list** mark. Pressing the button again
  adds only the meals that are new since last time. When nothing is new, the button is disabled.
- **Removing a meal from the plan does not remove its items from the shopping list.** By then the
  list may have been edited or checked off. Remove the items from the list by hand if you need to.
- **Changing a meal's servings after it is on the list does not change the list.** Adjust the
  list by hand.

### Which day the week starts on

The week starts on **Sunday** by default. To change it, go to **More** and pick a day under
**Meal plan**, **Weeks start on**. It is a household setting, so it changes the planner for
everyone, and anyone in the household can change it.
