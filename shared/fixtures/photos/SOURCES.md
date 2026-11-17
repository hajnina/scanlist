# Product photos (image queries for the golden fixture)

15 Open Food Facts front-of-pack photos, used as **image queries** in `shared/fixtures/golden.json`
(card S3). They are ranked against the synthetic `photo-corpus` list (all 44 items of the four
`shared/spec/samples/*.json` lists, `done` cleared) so image top-1 is measured against a realistic
44-item shopping list, not a 10-item toy.

All images are from Open Food Facts and are licensed **CC-BY-SA 3.0** (product images, see
<https://world.openfoodfacts.org/terms-of-use>). Each file is the 400px `front_*` image the site
serves, downloaded on 2026-11-17. Attribution and the exact source URL are below; the machine-readable
copy is `manifest.json` (the generator reads that file, not this table).

| file | product (as OFF names it) | expected list item(s) | barcode | source image |
|---|---|---|---|---|
| `milk.jpg` | Mléko polotučné s obsahem 1,5% tuku (Olma) | Milk | 8593807234713 | https://images.openfoodfacts.org/images/products/859/380/723/4713/front_en.10.400.jpg |
| `pasta.jpg` | Spaghetti Nº5 (Barilla) | Pasta | 8076800195057 | https://images.openfoodfacts.org/images/products/807/680/019/5057/front_en.3881.400.jpg |
| `ice-cream.jpg` | Twix glacé | Ice cream | 5000159484695 | https://images.openfoodfacts.org/images/products/500/015/948/4695/front_fr.85.400.jpg |
| `olive-oil.jpg` | Huile d'olive vierge extra Bio Classico | Olive oil | 8002470023727 | https://images.openfoodfacts.org/images/products/800/247/002/3727/front_en.71.400.jpg |
| `olives.jpg` | Olives vertes dénoyautées | Olives | 3017239003723 | https://images.openfoodfacts.org/images/products/301/723/900/3723/front_fr.53.400.jpg |
| `bananas.jpg` | Bananes 5 fruits | Bananas | 3564707141710 | https://images.openfoodfacts.org/images/products/356/470/714/1710/front_en.46.400.jpg |
| `cheese.jpg` | Fromage Blanc Nature | Cheese | 6111246721261 | https://images.openfoodfacts.org/images/products/611/124/672/1261/front_fr.118.400.jpg |
| `butter.jpg` | beurre (category pick) | Butter | 6111242105331 | https://images.openfoodfacts.org/images/products/611/124/210/5331/front_fr.38.400.jpg |
| `honey.jpg` | miel (category pick) | Honey | 3088540004440 | https://images.openfoodfacts.org/images/products/308/854/000/4440/front_fr.129.400.jpg |
| `tomatoes.jpg` | Concentré de tomates Aicha | Tomatoes | 6111021090049 | https://images.openfoodfacts.org/images/products/611/102/109/0049/front_fr.4.400.jpg |
| `eggs.jpg` | œufs (category pick) | Eggs | 3270190021179 | https://images.openfoodfacts.org/images/products/327/019/002/1179/front_fr.168.400.jpg |
| `bread.jpg` | pain (category pick) | Bread, Sourdough loaf | 3760049790214 | https://images.openfoodfacts.org/images/products/376/004/979/0214/front_en.262.400.jpg |
| `coffee.jpg` | Nescafé Classic | Coffee beans | 6111018903161 | https://images.openfoodfacts.org/images/products/611/101/890/3161/front_fr.48.400.jpg |
| `nutella.jpg` | Nutella (Ferrero) — **distractor** | *nothing on the list* | 3017620422003 | https://images.openfoodfacts.org/images/products/301/762/042/2003/front_en.879.400.jpg |
| `coca-cola.jpg` | Coca-Cola Original — **distractor** | *nothing on the list* | 5449000000996 | https://images.openfoodfacts.org/images/products/544/900/000/0996/front_en.1129.400.jpg |

Notes / honesty about the set:

- Product photos are **front-of-pack shots on white**, the easiest real-world case (no shelf clutter,
  no angle, no hands). A phone camera frame is much harder, so these numbers are an *upper bound* for
  the real pipeline, not a realistic estimate of on-device accuracy. Say so wherever they are quoted.
- `coffee.jpg` is instant coffee in a jar while the list item is "Coffee beans" — kept on purpose:
  it is the weakest semantic match in the set and a useful near-miss.
- `tomatoes.jpg` is a tomato **tin**, the list item is loose tomatoes: same idea, different form.
- `bread.jpg` matches two list items in the merged corpus (Bread, Sourdough loaf); both count as
  acceptable, see `accept` in `golden.json`.
- `nutella` / `coca-cola` are distractors: they are in no sample list, so nothing may be highlighted
  (they exercise the margin / absolute-score rule in `PREFIX_AB.md`).
- Re-fetch: `python /tmp`-style ad-hoc script is not committed (OFF is rate-limited and its search
  index changes); the committed JPEGs + `manifest.json` are the reproducible artefact.
