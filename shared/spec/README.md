# shared/spec — the ScanList contract

One list format, one flattening rule, one ranking algorithm, one prefix table — so the Kotlin, React Native and
Web tracks produce **identical** results on the golden fixtures.

| file | what it is |
|---|---|
| [`LIST.md`](LIST.md) | JSON format: top level, sections (any depth), items, `amount` number\|string, `unit`, `aliases`, `done`, defaults, import/export rules |
| [`FLATTEN.md`](FLATTEN.md) | depth-first flatten order, item id (`id` or `sha1(section/path/name#index)`), collision renaming, embedding text (`docText`) |
| [`RANK.md`](RANK.md) | 256-d Matryoshka truncation + L2, cosine, `max(image,text)` fusion + 0.15 barcode boost, EMA α=0.5, 0.02 hysteresis, 400 ms cadence, tie rules, done group, worked example |
| [`prompts.json`](prompts.json) | the two candidate prefix sets (`mnemothera`, `modelcard`), `imagePrefix: ""`, `active`; consumers read prefixes from here, never hard-code |
| [`list.schema.json`](list.schema.json) | byte copy of `docs/list.schema.json`, the machine-readable schema used by the validator |
| [`validate.py`](validate.py) | schema + invariant validator (no deps; uses `jsonschema` when present) |
| [`samples/`](samples/) | `van-weekly.json` (from `docs/samples/`), `deep-nesting.json` (4 levels, explicit ids, empty section), `string-amounts.json` (free-text amounts), `aliases-es-cz.json` (Spanish/Czech aliases) |

## Validate the samples

```sh
python3 shared/spec/validate.py shared/spec/samples/*.json
# schema: shared/spec/list.schema.json  (jsonschema 4.x)
# OK   shared/spec/samples/aliases-es-cz.json  (2 top sections, 13 items, max depth 1)
# ...
# OK: 4 file(s), 44 items, 0 warning(s)
echo $?   # 0
```

`--strict` promotes the LIST.md §5 warnings (duplicate explicit ids, unknown keys, unit without amount, empty
aliases) to errors; `--schema PATH` validates against another schema file. Exit codes: `0` valid, `1` invalid,
`2` usage error.

## Status

Spec v1 is final for cards S2 (`shared/ref` reference ranker), S3 (golden fixtures + prefix A/B), S5 (Kotlin
embedder), S8 (TypeScript core). The prefix choice is the only open decision and lives in `prompts.json`
(`active`), set by S3 after its A/B run.
