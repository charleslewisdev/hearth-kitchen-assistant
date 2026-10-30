/**
 * The demo kitchen: everything a screenshot can show.
 *
 * All of it is invented for this file. Do not paste in recipes from a cookbook, a website or the
 * real instance, because these words end up in pictures in the public README.
 */
export const HOUSEHOLD_NAME = 'Maple Street Kitchen';

export type DemoRecipe = {
  title: string;
  servings: number;
  mealTypes: string[];
  tags: string[];
  description: string;
  sourceName: string;
  prepMinutes: number;
  cookMinutes: number;
  rating: number | null;
  ingredientLines: string[];
  steps: string[];
};

export const RECIPES: DemoRecipe[] = [
  {
    title: 'Weeknight Lemon Chicken',
    servings: 4,
    mealTypes: ['dinner'],
    tags: ['Weeknight', 'One pan'],
    description: 'Everything roasts on one pan, and the lemon turns into its own sauce.',
    sourceName: 'Family recipe',
    prepMinutes: 10,
    cookMinutes: 40,
    rating: 5,
    ingredientLines: [
      '8 chicken thighs',
      '2 lemons, sliced',
      '1 1/2 lb small potatoes, halved',
      '3 tbsp olive oil',
      '4 garlic cloves, smashed',
      '1 tsp dried oregano',
      '1 tsp salt',
    ],
    steps: [
      'Heat the oven to 425°F and oil a large sheet pan.',
      'Toss the potatoes with half the oil and the salt, then spread them on the pan.',
      'Rub the chicken with the rest of the oil and the oregano, and nestle it among the potatoes.',
      'Tuck in the lemon and garlic, then roast for 40 minutes until the skin is deep gold.',
      'Spoon the pan juices over everything and serve.',
    ],
  },
  {
    title: 'Black Bean Tacos',
    servings: 4,
    mealTypes: ['dinner'],
    tags: ['Weeknight', 'Vegetarian'],
    description: 'Twenty minutes, one skillet, and a pantry that was already stocked.',
    sourceName: 'Our notebook',
    prepMinutes: 5,
    cookMinutes: 15,
    rating: 4,
    ingredientLines: [
      '2 cans black beans, drained',
      '1 red onion, diced',
      '2 tsp ground cumin',
      '1 tbsp olive oil',
      '8 corn tortillas',
      '1 cup shredded cheese',
      '1 lime, cut into wedges',
    ],
    steps: [
      'Soften the onion in the oil over medium heat.',
      'Add the cumin and beans, and mash about half of them with a fork.',
      'Warm the tortillas in a dry pan.',
      'Fill the tortillas, top with cheese, and serve with lime.',
    ],
  },
  {
    title: 'Sunday Tomato Soup',
    servings: 6,
    mealTypes: ['lunch', 'dinner'],
    tags: ['Soup', 'Freezer friendly'],
    description: 'A big pot for the weekend, with enough left for two lunches.',
    sourceName: 'Family recipe',
    prepMinutes: 15,
    cookMinutes: 35,
    rating: 5,
    ingredientLines: [
      '2 cans whole tomatoes',
      '1 yellow onion, chopped',
      '3 garlic cloves, sliced',
      '4 cups vegetable broth',
      '2 tbsp butter',
      '1/2 cup heavy cream',
      '1 tsp salt',
    ],
    steps: [
      'Melt the butter in a heavy pot and soften the onion and garlic.',
      'Add the tomatoes, broth and salt, and simmer for 30 minutes.',
      'Blend until smooth, then stir in the cream.',
    ],
  },
  {
    title: 'Blueberry Oat Pancakes',
    servings: 4,
    mealTypes: ['breakfast'],
    tags: ['Weekend', 'Kid favorite'],
    description: 'Blend the batter the night before and breakfast is half done.',
    sourceName: 'Our notebook',
    prepMinutes: 10,
    cookMinutes: 15,
    rating: 5,
    ingredientLines: [
      '2 cups rolled oats',
      '2 eggs',
      '1 1/2 cups milk',
      '2 tsp baking powder',
      '1 cup blueberries',
      '2 tbsp butter',
      'maple syrup, to serve',
    ],
    steps: [
      'Blend the oats, eggs, milk and baking powder until smooth.',
      'Rest the batter for ten minutes, then fold in the blueberries.',
      'Fry spoonfuls in butter until golden on both sides.',
    ],
  },
  {
    title: 'Spinach and Feta Pasta',
    servings: 4,
    mealTypes: ['dinner'],
    tags: ['Weeknight', 'Vegetarian'],
    description: 'The sauce comes together in the time the pasta takes to boil.',
    sourceName: 'Our notebook',
    prepMinutes: 5,
    cookMinutes: 15,
    rating: 4,
    ingredientLines: [
      '1 lb short pasta',
      '6 oz baby spinach',
      '6 oz feta, crumbled',
      '1 lemon, zested',
      '3 garlic cloves, sliced',
      '3 tbsp olive oil',
    ],
    steps: [
      'Boil the pasta in well salted water, and save a cup of the water.',
      'Warm the garlic in the oil, then wilt the spinach in the same pan.',
      'Toss the pasta with the spinach, feta, zest and a splash of the water.',
    ],
  },
  {
    title: 'Slow Cooker Pork Shoulder',
    servings: 8,
    mealTypes: ['dinner'],
    tags: ['Make ahead', 'Freezer friendly'],
    description: 'Start it before work. Tomorrow it becomes tacos.',
    sourceName: 'Family recipe',
    prepMinutes: 10,
    cookMinutes: 480,
    rating: 4,
    ingredientLines: [
      '4 lb pork shoulder',
      '1 yellow onion, sliced',
      '1 tbsp smoked paprika',
      '2 tsp salt',
      '1 cup chicken broth',
    ],
    steps: [
      'Rub the pork with the paprika and salt.',
      'Put the onion and broth in the slow cooker, and set the pork on top.',
      'Cook on low for eight hours, then shred with two forks.',
    ],
  },
  {
    title: 'Cinnamon Apple Crisp',
    servings: 8,
    mealTypes: ['dessert'],
    tags: ['Weekend', 'Kid favorite'],
    description: 'The topping is mostly oats, so it counts as fruit.',
    sourceName: 'Family recipe',
    prepMinutes: 20,
    cookMinutes: 45,
    rating: 5,
    ingredientLines: [
      '6 apples, sliced',
      '1 cup rolled oats',
      '1/2 cup brown sugar',
      '1/2 cup all-purpose flour',
      '1 stick butter, cold',
      '2 tsp ground cinnamon',
    ],
    steps: [
      'Heat the oven to 350°F and pile the apples into a baking dish.',
      'Rub the oats, sugar, flour, butter and cinnamon together until crumbly.',
      'Scatter the topping over the apples and bake for 45 minutes.',
    ],
  },
  {
    title: 'Chickpea Salad Sandwiches',
    servings: 4,
    mealTypes: ['lunch'],
    tags: ['Vegetarian', 'Make ahead'],
    description: 'Better on the second day, which is why it is always a double batch.',
    sourceName: 'Our notebook',
    prepMinutes: 10,
    cookMinutes: 0,
    rating: null,
    ingredientLines: [
      '2 cans chickpeas, drained',
      '1/4 cup mayonnaise',
      '2 celery stalks, diced',
      '1 tbsp whole grain mustard',
      '8 slices sandwich bread',
    ],
    steps: [
      'Mash the chickpeas with a fork, leaving some whole.',
      'Stir in the mayonnaise, celery and mustard.',
      'Pile onto the bread.',
    ],
  },
];

/** Which recipe the week's dinners use, Day 1 first. Null leaves a night open, as real weeks do. */
export const PLANNED_DINNERS: (string | null)[] = [
  'Weeknight Lemon Chicken',
  'Black Bean Tacos',
  'Spinach and Feta Pasta',
  null,
  'Slow Cooker Pork Shoulder',
  'Sunday Tomato Soup',
  'Weeknight Lemon Chicken',
];

/** What the shopping list shows as already in the cart. */
export const IN_THE_CART = ['olive oil', 'garlic', 'salt'];

/** The recipe the import screens show being read. */
export const PASTED_RECIPE = `Peach Skillet Cobbler
Serves 6

4 ripe peaches, sliced
1 cup self-rising flour
1 cup sugar
1 cup milk
1 stick butter

Heat the oven to 375°F and melt the butter in a cast iron skillet.
Whisk the flour, sugar and milk, then pour the batter over the butter.
Scatter over the peaches and bake for 40 minutes.`;
