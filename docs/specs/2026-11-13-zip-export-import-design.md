# Export with photos, and import the zip back (#37)

The library export becomes a complete, portable copy of every recipe: the Markdown files of D52 plus each recipe's photos and source scans. The same zip imports into any Hearth in one step. Owner decisions 2026-11-12: save straight in, skip titles already in the library, include photos and source scans.

## The zip

```
hearth-recipes-2026-11-13/
  green-chile-stew.md
  green-chile-stew/
    photo-1.jpg
    photo-2.jpg
    page-1.jpg
    page-2.jpg
    source.pdf
  pizza-dough.md
```

- Each recipe's files sit in a folder named after its Markdown file's stem (`recipeMarkdownFileName`), so the name is unique in the zip already.
- Photos are `photo-<n>.jpg` in gallery order. Source pages are `page-<n>.jpg` in reading order, and the source PDF is `source.pdf` (a second PDF is `source-2.pdf`). Only the `full` variant is written; thumbnails are made again on import.
- A recipe with no files gets no folder.
- Markdown is deflated. JPEG and PDF are stored without compression, since compressing them saves nothing and costs CPU.

The front matter gains four optional keys, written only when the recipe has such files, so a recipe without files exports the same bytes as before. The values are paths relative to the zip folder, written as JSON like every other value (D52):

```yaml
photos: ['green-chile-stew/photo-1.jpg', 'green-chile-stew/photo-2.jpg']
cover: 'green-chile-stew/photo-2.jpg'
source_pages: ['green-chile-stew/page-1.jpg', 'green-chile-stew/page-2.jpg']
source_pdf: 'green-chile-stew/source.pdf'
```

`hearth_format` stays 1. The keys are additive, and a reader that does not know them ignores them. The reader accepts a path only when it is relative, has no `..` segment and has at most 200 characters. Any other value is dropped, like any value Hearth would refuse.

## Export

`GET /api/export/recipes.zip` streams the zip instead of building it in memory. It uses fflate's `Zip` with `ZipDeflate` for Markdown and `ZipPassThrough` for files, piped into the reply. It reads one file from disk at a time, so memory stays near the largest single file (6 MiB) however big the library is.

- The file rows come from one household-scoped query, `recipe_file` ordered by recipe, kind and position, inside the same transaction as the recipes. The export is then one consistent snapshot.
- A file row whose bytes are missing on disk is left out of the zip and out of the front matter. One `warn` log line carries the file id. A partial backup beats a failed one.
- The single-recipe download `/api/export/recipes/:id` stays Markdown only.
- The Household screen's text changes from "Photos are not included" to say that photos and scans are included.

## Import

All of it happens in the browser, through the procedures that already exist. Files go up one at a time through `recipeFile.upload`, under its current limits. The server gains no upload route, no body-limit change and no image library.

1. **Pick.** The Import screen's Markdown tile also accepts `.zip`.
2. **Read (pass 1).** The browser streams the zip with fflate's `Unzip` from `File.stream()`. It keeps only `.md` entries, each capped at `MAX_TEXT_LENGTH` characters; larger entries are skipped and listed. Every other entry is skipped without being decompressed. Each `.md` goes through `readRecipeMarkdown`. A file without front matter is listed as "not a Hearth recipe" and skipped.
3. **Summary.** Before anything is saved, the screen shows: "42 recipes, 51 photos and scans. 3 are already in your library and will be skipped: …". A title counts as present when `recipeTitleKey` matches a title in `recipe.list` or an earlier recipe in the same zip. One button: **Import 39 recipes**.
4. **Save recipes.** Recipes go through `recipe.create`, one at a time, so that every recipe they link is created before them.
   - The order comes from each recipe's `[[Title]]` tokens: within the zip, depth first.
   - A link whose title is neither in the library nor in the zip, or that is part of a cycle, is written back as plain text, so `[[Pizza Dough]]` becomes `Pizza Dough`. The summary lists those recipes. `recipe.create` would otherwise refuse the whole recipe.
   - `rating` is carried, as the Markdown tile does today.
5. **Save files (pass 2).** The zip is streamed again. Each listed file of a saved recipe is uploaded with `recipeFile.upload`:
   - Photos are re-encoded by `prepareImage` and source pages by `prepareSourcePage` (both in `photo-upload.ts`), which make the thumbnail.
   - The PDF goes up as it is. An entry larger than the kind's cap is skipped and listed, without being decompressed past the cap.
   - When the recipe's files are in, `cover` is set with `recipeFile.setCover`, unless it is already the first photo.
6. **Report.** Progress shows as "Saving 12 of 39", then a list of what was saved, skipped and failed. One failure does not stop the rest. Reloading mid-import leaves the recipes saved so far, and importing the same zip again skips them by title.

A zip that is not a Hearth export works too, provided it holds `.md` files with front matter. Their file keys are simply absent.

## Limits and hostile input

The zip comes from a file the cook picked, but it may come from anyone.

- Entry names are only looked up, never used as paths to write.
- Each entry is checked against its cap while it decompresses, and is stopped at the cap, so a zip bomb cannot exhaust memory.
- At most 2,000 recipes per zip, enough for any household.
- No regex is added. Path checks are string operations.

## Out of scope

- The cook log, tag colours and food departments, as in D52.
- Re-importing over an existing recipe. Duplicates are skipped by title (owner decision).
- Server-side zip upload. Revisit only if a browser cannot hold one entry at a time.

## Decision

This spec is recorded as D62.
