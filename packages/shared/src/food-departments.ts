import { normalizeFoodName } from './food-name';

/**
 * Grocery store department a food belongs to. These labels are the canonical
 * strings used across the app; keep them stable.
 */
export type Department =
  | 'Produce'
  | 'Dairy'
  | 'Meat & Seafood'
  | 'Bakery'
  | 'Baking'
  | 'Pantry'
  | 'Frozen'
  | 'Beverages';

/**
 * STARTER seed dictionary mapping common grocery foods to their department.
 *
 * This is intentionally small (~60 staples) reference data, NOT a database
 * table and NOT an exhaustive grocery taxonomy. It exists to give new
 * shopping-list items a sensible default department; it is expected to be
 * extended over time (and eventually superseded by user/DB overrides).
 *
 * Keys are written as raw words for readability. They are run through
 * `normalizeFoodName` at module load (see `NORMALIZED_FOOD_DEPARTMENTS`) so
 * that lookups — which also normalize their input — match consistently. That
 * means "tomatoes" and "tomato" both resolve to the same entry.
 */
const FOOD_DEPARTMENTS: Record<string, Department> = {
  // Produce
  tomato: 'Produce',
  lettuce: 'Produce',
  onion: 'Produce',
  garlic: 'Produce',
  potato: 'Produce',
  carrot: 'Produce',
  celery: 'Produce',
  cucumber: 'Produce',
  'bell pepper': 'Produce',
  spinach: 'Produce',
  broccoli: 'Produce',
  mushroom: 'Produce',
  apple: 'Produce',
  banana: 'Produce',
  lemon: 'Produce',
  lime: 'Produce',
  orange: 'Produce',
  strawberry: 'Produce',
  avocado: 'Produce',
  ginger: 'Produce',
  leek: 'Produce',
  'garlic clove': 'Produce',
  'broccoli floret': 'Produce',
  pea: 'Produce',
  'lemon juice': 'Produce',
  'lime juice': 'Produce',
  'lemon zest': 'Produce',
  chili: 'Produce',
  shallot: 'Produce',
  scallion: 'Produce',
  'green onion': 'Produce',
  cilantro: 'Produce',
  parsley: 'Produce',
  basil: 'Produce',
  thyme: 'Produce',
  rosemary: 'Produce',
  sage: 'Produce',
  'sage leaf': 'Produce',
  mint: 'Produce',
  dill: 'Produce',
  kale: 'Produce',
  cabbage: 'Produce',
  zucchini: 'Produce',
  eggplant: 'Produce',
  jalapeno: 'Produce',
  'sweet potato': 'Produce',
  cauliflower: 'Produce',
  asparagus: 'Produce',
  'green bean': 'Produce',
  corn: 'Produce',
  blueberry: 'Produce',
  raspberry: 'Produce',
  mango: 'Produce',
  pineapple: 'Produce',

  // Dairy
  milk: 'Dairy',
  butter: 'Dairy',
  cheese: 'Dairy',
  'cheddar cheese': 'Dairy',
  yogurt: 'Dairy',
  'cream cheese': 'Dairy',
  'sour cream': 'Dairy',
  'heavy cream': 'Dairy',
  egg: 'Dairy',
  cream: 'Dairy',
  'whipping cream': 'Dairy',
  buttermilk: 'Dairy',
  mozzarella: 'Dairy',
  'mozzarella cheese': 'Dairy',
  parmesan: 'Dairy',
  'parmigiano reggiano': 'Dairy',
  pecorino: 'Dairy',
  feta: 'Dairy',
  ricotta: 'Dairy',
  asiago: 'Dairy',

  // Meat & Seafood
  chicken: 'Meat & Seafood',
  'chicken breast': 'Meat & Seafood',
  beef: 'Meat & Seafood',
  'ground beef': 'Meat & Seafood',
  pork: 'Meat & Seafood',
  bacon: 'Meat & Seafood',
  sausage: 'Meat & Seafood',
  turkey: 'Meat & Seafood',
  salmon: 'Meat & Seafood',
  shrimp: 'Meat & Seafood',
  tuna: 'Meat & Seafood',
  veal: 'Meat & Seafood',
  'veal shank': 'Meat & Seafood',
  lamb: 'Meat & Seafood',
  prosciutto: 'Meat & Seafood',
  pancetta: 'Meat & Seafood',
  steak: 'Meat & Seafood',
  'ground chuck': 'Meat & Seafood',
  'ground pork': 'Meat & Seafood',
  'pork butt': 'Meat & Seafood',
  'eye round': 'Meat & Seafood',
  'salmon fillet': 'Meat & Seafood',
  'chicken thigh': 'Meat & Seafood',
  'chicken breast half': 'Meat & Seafood',
  cod: 'Meat & Seafood',

  // Bakery
  bread: 'Bakery',
  bagel: 'Bakery',
  tortilla: 'Bakery',
  'hamburger bun': 'Bakery',
  croissant: 'Bakery',

  // Baking
  flour: 'Baking',
  sugar: 'Baking',
  'brown sugar': 'Baking',
  'baking soda': 'Baking',
  'baking powder': 'Baking',
  'vanilla extract': 'Baking',
  'chocolate chip': 'Baking',
  yeast: 'Baking',
  cocoa: 'Baking',
  'cocoa powder': 'Baking',
  chocolate: 'Baking',
  cornstarch: 'Baking',
  cornmeal: 'Baking',
  'powdered sugar': 'Baking',

  // Pantry
  rice: 'Pantry',
  pasta: 'Pantry',
  'olive oil': 'Pantry',
  'vegetable oil': 'Pantry',
  salt: 'Pantry',
  'black pepper': 'Pantry',
  'canned tomato': 'Pantry',
  'chicken broth': 'Pantry',
  'peanut butter': 'Pantry',
  honey: 'Pantry',
  'soy sauce': 'Pantry',
  oat: 'Pantry',
  cereal: 'Pantry',
  bean: 'Pantry',
  // Spices and dried herbs. Pantry rather than a department of their own, because the store
  // shelves them there and adding a department is a change to every screen that groups by one.
  cumin: 'Pantry',
  'cumin seed': 'Pantry',
  paprika: 'Pantry',
  cinnamon: 'Pantry',
  nutmeg: 'Pantry',
  cayenne: 'Pantry',
  'cayenne pepper': 'Pantry',
  'chili powder': 'Pantry',
  'garlic powder': 'Pantry',
  'onion powder': 'Pantry',
  'dried oregano': 'Pantry',
  'dried thyme': 'Pantry',
  'dried basil': 'Pantry',
  oregano: 'Pantry',
  'bay leaf': 'Pantry',
  'red pepper flake': 'Pantry',
  'garam masala': 'Pantry',
  turmeric: 'Pantry',
  saffron: 'Pantry',
  'kosher salt': 'Pantry',
  'sea salt': 'Pantry',
  pepper: 'Pantry',
  // Cans, jars, sauces, grains.
  'tomato paste': 'Pantry',
  'tomato sauce': 'Pantry',
  'crushed tomato': 'Pantry',
  'sun-dried tomato': 'Pantry',
  'artichoke heart': 'Pantry',
  'coconut milk': 'Pantry',
  'curry paste': 'Pantry',
  'ginger garlic paste': 'Pantry',
  harissa: 'Pantry',
  olive: 'Pantry',
  vinegar: 'Pantry',
  'sesame oil': 'Pantry',
  'neutral oil': 'Pantry',
  oil: 'Pantry',
  'fish sauce': 'Pantry',
  'oyster sauce': 'Pantry',
  mirin: 'Pantry',
  broth: 'Pantry',
  stock: 'Pantry',
  chickpea: 'Pantry',
  lentil: 'Pantry',
  barley: 'Pantry',
  'bread crumb': 'Pantry',
  almond: 'Pantry',
  cashew: 'Pantry',
  walnut: 'Pantry',
  'maple syrup': 'Pantry',
  mustard: 'Pantry',
  spaghetti: 'Pantry',
  bucatini: 'Pantry',
  penne: 'Pantry',
  fusilli: 'Pantry',
  rigatoni: 'Pantry',
  noodle: 'Pantry',

  // Frozen
  'ice cream': 'Frozen',
  'frozen spinach': 'Frozen',
  'frozen pea': 'Frozen',
  'frozen pizza': 'Frozen',

  // Beverages
  coffee: 'Beverages',
  tea: 'Beverages',
  'orange juice': 'Beverages',
  'sparkling water': 'Beverages',
  soda: 'Beverages',
  wine: 'Beverages',
  'red wine': 'Beverages',
  'white wine': 'Beverages',
  sake: 'Beverages',
  tequila: 'Beverages',
  beer: 'Beverages',
};

/**
 * The seed map with every key normalized via `normalizeFoodName`, so keys are
 * guaranteed consistent with how lookups normalize their input.
 */
export const NORMALIZED_FOOD_DEPARTMENTS: Record<string, Department> =
  Object.fromEntries(
    Object.entries(FOOD_DEPARTMENTS).map(([name, dept]) => [
      normalizeFoodName(name),
      dept,
    ]),
  );

/** The longest key in the map, in words. Trailing phrases longer than this cannot match. */
const MAX_SUFFIX_WORDS = 3;

/**
 * Return the grocery department for a food name, or `null` if unknown.
 *
 * Lookup strategy:
 *   1. Normalize the input (lowercase / trim / light singularization).
 *   2. Try an exact match on the full normalized name.
 *   3. Fall back to the longest known TRAILING phrase of up to three words, so
 *      "boneless chicken" resolves to "chicken" and "extra-virgin olive oil" to
 *      "olive oil" rather than to "oil".
 */
export function departmentFor(foodName: string): Department | null {
  const normalized = normalizeFoodName(foodName);
  if (normalized === '') return null;

  const exact = NORMALIZED_FOOD_DEPARTMENTS[normalized];
  if (exact !== undefined) return exact;

  // The longest trailing phrase that is a known food, so "extra-virgin olive oil" finds "olive
  // oil" before "oil", and "low-sodium chicken broth" finds "chicken broth". Only the last few
  // words: a food name is user text and can be any length, and no key here is longer than this.
  const words = normalized.split(' ');
  const first = Math.max(1, words.length - MAX_SUFFIX_WORDS);
  for (let start = first; start < words.length; start++) {
    const found = NORMALIZED_FOOD_DEPARTMENTS[words.slice(start).join(' ')];
    if (found !== undefined) return found;
  }
  return null;
}

/** Every department, in the order a store walk usually meets them. Foods with none are "Other". */
export const DEPARTMENTS: readonly Department[] = [
  'Produce',
  'Bakery',
  'Meat & Seafood',
  'Dairy',
  'Frozen',
  'Pantry',
  'Baking',
  'Beverages',
];
