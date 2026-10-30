# Importing recipes

Press **+ Add / Import**. The **Add a recipe** screen has five tiles:

| Tile           | Use it for                                                      |
| -------------- | --------------------------------------------------------------- |
| **Paste link** | A recipe web page                                               |
| **Photo**      | A photo of a cookbook page or a printout                        |
| **PDF**        | A PDF, including a scan from a phone scanner app or a scanner   |
| **Text**       | Text you copied from anywhere: a web page, an email, a document |
| **By hand**    | Typing it in ([Adding recipes by hand](adding-recipes.md))      |

Every import ends on the same review screen, **Check this over**. Nothing is saved until you
press **Save recipe** there.

All importing happens on your server. Nothing is sent to an outside service.

## The review screen

The review screen is a form with the recipe's title, servings, recipe types, tags, ingredients and
steps filled in. Change anything you like.

**Amber fields are guesses.** Hearth marks a field when the source did not state it outright, with
a note saying why. For example: "The photo did not say how many this serves", or "The split into
steps is a guess". The line at the top says how many fields are marked. Fields that are not amber
came straight from the source. Editing a marked field clears its mark.

Things to check every time:

- **Title.** From a photo, PDF or paste, the title is the first line above the ingredients; from
  a photo, the largest type near the top, all of its lines. A title printed in capitals or in
  sentence case is changed to title case. OCR sometimes picks up a chapter heading or page header
  instead, and can misread a letter in large display type.
- **Servings.** If the source did not say, Hearth puts 1. Scaling and the shopping list depend on
  this number.
- **Ingredients**, one per line. Below the box is the same `amount · unit · food` preview as the
  recipe form. Use it to fix lines the parser misread (see
  [the tips](adding-recipes.md#tips-for-lines-the-parser-gets-wrong)). A line printed in both
  systems shows its second amount too (`3 · cups · or 360 g · flour`); see
  [US or metric](cooking.md#us-or-metric).
- **Check the amount against the page.** From a photo, a line marked this way had a fraction OCR
  could not read, and Hearth guessed ½. Fix it if the book says ¼ or ¾. Editing the line clears
  the mark. Where the book prints grams or millilitres beside the amount, Hearth works the fraction
  out from those instead of guessing.
- **Steps**, separated by a **blank line**. This is different from the hand-typed form, which has
  one box per step. Put a blank line between steps to split them, and remove one to join them.
- **Tags.** Hearth fills in only tags you already use that the recipe mentions, in its title or
  among the site's keywords. The site's other keywords, and your tags that an ingredient names,
  show below as **Suggested**: tap one to add it. Nothing else becomes a tag, so marketing words
  like "baked pork tenderloin recipe" stay out of your tag list.
- **Source link.** For a paste, PDF or photo, type the web address if the recipe lives online. A
  link import keeps its own.
- **Source.** Where the recipe came from, such as `Joy of Cooking, p. 212`. For a photo, PDF or
  paste, this starts with the last source you typed on this device, so a batch from one book only
  needs the page number changed. A link is its own source, so this starts empty for a link.
- **Notes.** Anything worth keeping with the recipe: who it is from, what to change next time.
  From a photo, PDF or paste, Hearth fills in the paragraph under the title and any "Tip:".

The panel beside the form (below it on a phone) shows what the source said for the title, yield,
category and keywords. For a link, it also shows the page address.

**Start over** throws the draft away and returns to the tiles. The draft is not saved anywhere
while you review it, so leaving the screen or reloading the page also loses it.

Hearth does not check for duplicates. If you import the same recipe twice you get two recipes.
Delete the extra one from its recipe screen (**Delete recipe**, then **Yes, delete**).

## Paste link (web pages)

Paste the address of the recipe page and press **Import**.

**Works well** on most recipe sites and blogs. Sites that want to show up in search results embed
a structured copy of the recipe in the page, and Hearth reads that. Those fields come through
unmarked. For pages without it, Hearth reads the page text the same way it reads a paste, and
marks the fields as guesses.

**What comes through:** title, servings (from the yield), ingredients, steps, prep and cook times, the site's short description (into Notes), a recipe type guessed from the site's category (a "Side Dish" becomes side, "Condiments" sauce, "Drinks" drink), and tag suggestions from the site's keywords. The link is saved with the recipe and
shown on its Source line as "*site name*" on the recipe screen, so you can go back to the original for its
photos, notes and comments.

**What does not come through:** photos, and notes or tips below the recipe. If a site states only a total time, Hearth leaves both times blank rather than guess how it splits.

**Limits:** the page must be under 4 MB and answer within 10 seconds. Hearth follows up to 5
redirects. It sends no cookies and does not log in, so pages behind a login or paywall will not
work.

**Some sites block Hearth.** Allrecipes is one. You see "That page could not be read: the site
answered 403." Use **Text** instead: on the recipe page, select from the recipe title down to the
last step, copy, and paste into Hearth. The same works for paywalled pages and pages built by
scripts.

Messages you may see:

| Message                                                                                                                   | What to do                                                    |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| No recipe was found on that page. If it is behind a paywall or drawn by a script, copying the text in is the way through. | Copy the text and use **Text**.                               |
| That page could not be read: the site answered _number_.                                                                  | The site refused or failed. Copy the text and use **Text**.   |
| That site took too long to answer. Try again in a moment.                                                                 | Try again, or paste the text.                                 |
| That site could not be reached.                                                                                           | Check the address. Try again later.                           |
| That page is too large to import. Try the printable version of the recipe.                                                | Many sites have a "Print" button with a smaller page.         |
| That does not look like a web address. / Recipe links have to start with http:// or https://.                             | Paste the full address from the browser's address bar.        |
| That link points into this server's own network rather than out to the web, so Hearth will not open it.                   | Hearth only fetches public web pages. Paste the text instead. |

## Text (paste)

Paste the recipe and press **Import**. This is the one source that always has a way through: if
you can select the text, you can import it. The limit is 100,000 characters.

Hearth works out the recipe from the shape of the text, so every field comes through marked as a
guess. It looks for:

- **An ingredient list:** at least three lines close together that start with an amount. Or a
  line that says only "Ingredients", followed later by a line that says only "Instructions",
  "Directions", "Method" or "Steps". With both headings, it takes everything between them as ingredients, even lines with no
  amounts.
- **A title:** the first sensible line above the ingredients.
- **Servings:** a line like "Serves 4", "4 servings", "Makes 12" or "Yield: 6".
- **Steps:** everything after the ingredients. Numbered steps (`1.`, `2)`, `Step 3`) are split on
  the numbers. Otherwise bulleted lines, otherwise blank lines.
- **The end:** a line that is only a heading such as "Notes", "Tips", "Nutrition", "Variations",
  "Equipment" or "Storage" ends the steps. Anything after it is left out.

To get a clean import from a paste, tidy it first in the text box:

```
Grandma's Rolls
Makes 12

Ingredients
1 cup warm milk
2 1/4 tsp yeast
3 cups flour
1 tsp salt

Instructions
1. Mix the milk and yeast and rest 10 minutes.
2. Add the flour and salt and knead 8 minutes.
3. Bake at 375F for 18 to 20 minutes.
```

If Hearth finds no ingredient list, it says: "No recipe was found in that text. An ingredient list
with amounts on it is what Hearth looks for." Add amounts or the two headings and try again.

## PDF

Choose a PDF file. Hearth reads the text inside it and then treats it like a paste. If the PDF
has no text in it because it is a scan, Hearth reads the scanned pages the way it reads a photo.

**Works well** on PDFs made by a computer: a web page saved or printed as PDF, a recipe exported
from Word or another app, a recipe card from a website. Hearth handles two-column pages, such as a
web print with the ingredients in a sidebar, by reading each column in turn.

**Works badly or not at all:**

- **Scanned PDFs read like photos, not like text.** A scan from a phone app (Google Drive, Adobe
  Scan, the iPhone Notes scanner) or a flatbed scanner is a picture of each page. Hearth reads it
  with OCR, the same as [Photo](#photo-cookbook-pages-and-printouts), so everything said there
  applies: English only, a few seconds a page, two-column pages and handwriting read badly, and
  every field comes through marked as a guess. A scan can have **up to 4 pages**. For a longer
  one, save just the recipe's pages as a new PDF. Scan at 300 dpi or less (a scanner app's
  normal setting is fine); a very high-resolution scan is refused as too large.
- **A PDF with nothing Hearth can read.** A PDF with no text and no scanned page in it, for
  example one that is only drawings, gets: "That PDF has no text in it and no scanned page Hearth
  can read. Photograph the page and use Photo instead." The Photo tile does not accept PDF files,
  so take a screenshot of the page on your screen, or photograph the paper original, then use
  **Photo**.
- **A PDF with several recipes.** Hearth makes one recipe from the whole file and usually picks the
  longest ingredient list. Save just the pages of the recipe you want, or copy that recipe's text
  and use **Text**.

**Limits:** 6 MB and 20 pages; for a scan, 4 pages.

Messages you may see:

| Message                                                                          | What to do                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| That PDF has no text in it and no scanned page Hearth can read. Photograph the page and use Photo instead. | See "A PDF with nothing Hearth can read" above. |
| That PDF is a scan of more than 4 pages. Try saving just the recipe pages.       | Save only the recipe's pages as a new PDF.            |
| No recipe was found in that scan. A straight, sharp scan of just the recipe usually reads better. | Scan again flat and in focus, or crop to the recipe. See [Photo](#photo-cookbook-pages-and-printouts). |
| Reading that scan took too long, so Hearth stopped. Try saving just the recipe pages. | Save fewer pages, or crop to the recipe.     |
| That PDF is a scan, and reading text from scans is not working on this server. Its language data is missing. | A problem with the install. Tell the owner. |
| That PDF is too large to import. Try saving just the recipe pages.               | Print or save only the pages you need as a new PDF. For a scan, scan again at 300 dpi or less. |
| That PDF has more than 20 pages in it. Try saving just the recipe.               | Same.                                                 |
| There is far more text in that PDF than a recipe has. Try saving just the recipe pages. | Same.                                          |
| Hearth could not read that PDF. It may be damaged, or protected with a password. | Open it on your computer and save a fresh copy, or copy the text and use **Text**. |
| No recipe was found in that PDF.                                                 | Copy the text out of the PDF and use **Text**.        |
| Hearth is reading another file. Try again in a moment.                           | Someone else is importing. Wait a few seconds.        |

### Word documents

Word files (.doc, .docx) are not supported. Open the document, select the recipe, copy it and use
**Text**. Or, in Word, save the document as a PDF and use **PDF**; a PDF saved from Word has real
text in it.

## Photo (cookbook pages and printouts)

Choose or take a photo. One photo is read straight away. For a recipe that runs over a page
turn, choose **up to 4 photos** at once. Hearth then shows a **Pages** step: a numbered list of
the photos, each with a small preview and its file name. Check that page 1 is the first page of
the recipe, because its first line becomes the title. Use the up and down arrows to move a page,
and **×** to take one out. Then press **Read 2 pages** (or 3, or 4), or **Cancel** to go back.
Hearth first lists the photos by file name, which is usually the order your camera took them in;
if the names are all the same, as they are when an iPhone shares photos, they stay in the order
you picked them. Hearth joins the pages into one recipe. It reads the
text on your server (this is called OCR, optical character recognition) and then treats the text
like a paste. Every field comes through marked as a guess.

It reads **English** text only. It takes a few seconds per photo, depending on the server.

OCR reads printed fractions (½, ¼, ¾) badly, often as `Y2`, `%` or `72`. Hearth puts back the
ones it can be sure of and marks the rest on the review screen. It also handles steps numbered
with no full stop ("1 Peel the cucumber"), sub-lists such as "For the filling", a method printed
beside the ingredients, and running headers, page numbers and nutrition lines, which it leaves out.

**Works well:** a single-column page, photographed flat, square to the page, in good even light,
filling the frame, with sharp text.

**Works badly:**

- **Busy two-column pages.** Hearth reads a page with the ingredients in one column and the method
  in another a column at a time, and a page photographed on its side the right way up. A page with
  photos, boxes or sidebars between the columns can still mix ingredients and steps together.
- **A spread with two recipes.** Hearth does not split them. You get one recipe with the other's
  lines mixed in.
- Curved pages near the spine, shadows, glare on glossy paper, and handwriting.

Your browser shrinks a large photo before it uploads it, so ordinary phone photos are fine. The
limit after shrinking is 6 MB a photo and 12 MB for all the photos of one recipe. If you choose
more than 4, Hearth says "Choose up to 4 photos for one recipe." and sends nothing. If one page
of several cannot be read, the whole import fails with that page's message, so retake that page.

Messages you may see:

| Message                                                                                         | What to do                                                             |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| No recipe was found in that photo. A flatter, better lit shot of the page usually reads better. | Retake it, or crop it to one recipe (below).                           |
| That file could not be read as an image.                                                        | Save it as JPEG or PNG and try again.                                  |
| That photo is too large to import. Take it again at a smaller size.                             | Retake, or crop it.                                                    |
| Reading that photo took too long, so Hearth stopped. Try a smaller one.                         | Crop to the recipe and try again.                                      |
| Hearth is reading another photo. Try again in a moment.                                         | Hearth reads one photo at a time with two waiting. Wait a few seconds. |
| Reading text from photos is not working on this server. Its language data is missing.           | A problem with the install. Tell the owner.                            |

## Recipes from cookbooks

If you are bringing in a shelf of cookbooks, this is the workflow that works today.

### For each recipe

1. **Photograph one page, flat and square.** Lay the book open on a table in good light, near a
   window if you can. Hold the phone directly above the page, parallel to it. Press the book flat
   so the lines near the spine are not curved. Avoid your own shadow and glare from overhead
   lights.
2. **Crop to one recipe's column with your phone's own photo editor** before you upload. Cut away
   the facing page, the other column, photos, and the page header. This single step fixes most of
   the two-column and two-recipe problems.
3. **Upload with Photo** and check the review screen. For a recipe over two pages, choose both
   photos at once and check their order on the **Pages** step. Fix the title, servings and any misread lines, and set the **Source** to the
   book and page.
4. **If the result is poor, do not fight it.** Switch to the text route below.

### When OCR is poor: copy the text on your phone

Modern phones can read text from a photo themselves, and they are often better at it than
Hearth's OCR on a tricky page:

- **iPhone (Live Text):** open the photo, touch and hold the text, drag to select, and tap **Copy**.
- **Android (Google Lens):** open the photo, tap **Lens**, then **Text**, select, and **Copy**.

Then in Hearth press **Text**, paste, and tidy it up as shown in [Text (paste)](#text-paste). For
a recipe over two pages, copy each page's text and paste them one after the other into the same
box.

If even that is messy, type the recipe in with **By hand**. For a short recipe this is often the
fastest route.

### Recipes over two pages

Photograph each page, then choose all of them together (up to 4) on the **Photo** tile. On the
**Pages** step, put them in page order with the arrows, so the first page is at the top, then
press **Read**. Hearth starts from the file names, but only you can see which page is which.

### Pace and batching for 100 or more recipes

- **Work in sessions of 10 to 15 recipes**, one book at a time. Photograph a batch first, crop
  them, then import them one by one. The review step is where the time goes, and it is easier
  when you are fresh.
- **Tag as you go.** On the review screen, add a tag for the book, for example `Joy of Cooking`,
  plus anything else you will filter by (`soup`, `weeknight`). Tag filters appear on the Recipes
  screen and in its **Filters** panel. Adding tags later means opening every recipe again.
- **Put the book and page in Source**, for example `Joy of Cooking, p. 212`. It shows on the
  recipe as "From Joy of Cooking, p. 212". Photos are not kept with the recipe.
- **Set servings every time.** A cookbook's "Serves 4 to 6" reads as 4.
- **Keep food names consistent** across recipes (see
  [the tips](adding-recipes.md#tips-for-lines-the-parser-gets-wrong)). It pays off on the
  shopping list.
- **Import one at a time.** Hearth reads one photo or PDF at a time. If two people import at
  once, one of them may see "Hearth is reading another photo".
- **Search before importing** a recipe you may already have added. If you do end up with two,
  delete one from its recipe screen.
