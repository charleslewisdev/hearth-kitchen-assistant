"""
Writes test/fixtures/word-recipe.docx, an invented recipe saved by python-docx.

python-docx starts from Word's own default template, so the package has the parts a real Word
file has: relationships, styles.xml with "List Number" and "List Bullet" numbering their
paragraphs through the style, numbering.xml, a heading style and a table of amounts. Run it from the repo
root with `python3 -I packages/enrichment/test/make-word-fixture.py` (needs `pip install
python-docx`) only to change the fixture; the tests read the committed file.
"""
import datetime
import sys

import docx

out = sys.argv[1] if len(sys.argv) > 1 else "packages/enrichment/test/fixtures/word-recipe.docx"

d = docx.Document()
props = d.core_properties
props.author = "Hearth tests"
props.last_modified_by = "Hearth tests"
props.title = ""
props.comments = ""
fixed = datetime.datetime(2026, 1, 1)
props.created = fixed
props.modified = fixed
props.revision = 1

d.add_heading("Brown Butter Oat Bars", level=1)
d.add_paragraph("A tray bake for a bake sale. Makes 16 bars.")
d.add_heading("Ingredients", level=2)
rows = [
    ("1 cup", "unsalted butter"),
    ("2 cups", "rolled oats"),
    ("1 1/2 cups", "all-purpose flour"),
    ("3/4 cup", "packed brown sugar"),
    ("1 tsp", "baking soda"),
    ("1/2 tsp", "fine salt"),
    ("2 tsp", "vanilla extract"),
]
table = d.add_table(rows=len(rows), cols=2)
for row, (amount, food) in zip(table.rows, rows):
    row.cells[0].text = amount
    row.cells[1].text = food
d.add_paragraph("For the topping:")
for line in ["1/2 cup chocolate chips", "1/4 cup chopped pecans"]:
    d.add_paragraph(line, style="List Bullet")
d.add_heading("Method", level=2)
for line in [
    "Heat the oven to 350F and line a 9 by 13 inch pan.",
    "Melt the butter until it smells nutty and the solids turn brown.",
    "Stir everything together and press it into the pan.",
    "Scatter the topping over and bake for 25 minutes. Cool in the pan and cut into 16 bars.",
]:
    d.add_paragraph(line, style="List Number")
d.save(out)
