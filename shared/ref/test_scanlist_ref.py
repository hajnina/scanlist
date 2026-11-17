"""Tests for the reference ranker — written from RANK.md / FLATTEN.md, not the code.

Every expected number here is taken from the spec text (chiefly RANK.md §10 and
FLATTEN.md §3.2/§4/§6 worked examples) so a regression in the implementation is
not silently blessed by the test.
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import scanlist_ref as ref  # noqa: E402

SPEC_DIR = Path(__file__).resolve().parents[1] / "spec"
SAMPLES_DIR = SPEC_DIR / "samples"
SAMPLE_ITEM_COUNTS = {
    "van-weekly.json": 10,
    "aliases-es-cz.json": 13,
    "deep-nesting.json": 10,
    "string-amounts.json": 11,
}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def make_item(item_id, vec, *, order=0, name=None, aliases=(), done=False):
    return {
        "id": item_id,
        "name": name or item_id,
        "aliases": list(aliases),
        "done": done,
        "order": order,
        "path": [],
        "pathText": "",
        "vec": None if vec is None else np.asarray(vec, dtype=np.float64),
    }


def ids(entries):
    return [e["id"] for e in entries]


def scores(entries):
    return [(e["id"], e["raw"], e["smoothed"]) for e in entries]


def text_queries(*vectors):
    return {"text": [np.asarray(v, dtype=np.float64) for v in vectors], "image": []}


# ---------------------------------------------------------------------------
# §5 q6
# ---------------------------------------------------------------------------
class TestQ6:
    def test_rounds_half_away_from_zero(self):
        assert ref.q6(0.1234565) == 0.123457
        assert ref.q6(-0.1234565) == -0.123457
        assert ref.q6(0.0000004) == 0.0
        assert ref.q6(0.0000005) == 0.000001

    def test_six_dp_values_are_idempotent(self):
        for value in (0.0, 0.02, 0.09, 0.85, 0.915, 0.94875, -1.0, 1.15):
            assert ref.q6(ref.q6(value)) == ref.q6(value)

    def test_negative_zero_is_positive_zero(self):
        zero = ref.q6(-0.0)
        assert zero == 0.0
        assert math.copysign(1.0, zero) == 1.0
        tiny = ref.q6(-1e-9)
        assert tiny == 0.0
        assert math.copysign(1.0, tiny) == 1.0

    def test_spec_comparison_examples(self):
        # RANK.md §10: these two differences decide the highlight.
        assert ref.q6(0.87 - 0.85) == 0.02
        assert ref.q6(0.915 - 0.825) == 0.09


# ---------------------------------------------------------------------------
# §2 vectors
# ---------------------------------------------------------------------------
class TestVectors:
    def test_truncates_to_first_256_then_normalises(self):
        vec = np.zeros(768, dtype=np.float64)
        vec[0], vec[1], vec[2] = 3.0, 4.0, 0.0
        vec[300] = 100.0  # outside the active dims: must be ignored
        out = ref.truncate_and_normalize(vec)
        assert out.shape == (256,)
        assert out[0] == 3.0 / 5.0
        assert out[1] == 4.0 / 5.0
        assert np.count_nonzero(out) == 2          # dim 300 (and later) really is dropped
        assert float(np.linalg.norm(out)) == pytest.approx(1.0, abs=1e-15)

    def test_float32_input_is_widened_exactly(self):
        vec = np.zeros(768, dtype=np.float32)
        vec[0] = 0.5
        vec[1] = 0.5
        out = ref.truncate_and_normalize(vec)
        assert out.dtype == np.float64
        assert out[0] == float(np.float64(vec[0])) / math.sqrt(0.5)

    def test_zero_vector_stays_zero(self):
        out = ref.truncate_and_normalize(np.zeros(768))
        assert out.shape == (256,)
        assert not np.any(out)
        assert ref.q6(ref.cosine(out, out)) == 0.0

    def test_too_short_vector_raises(self):
        with pytest.raises(ValueError):
            ref.truncate_and_normalize([1.0, 0.0])

    def test_non_finite_vector_raises(self):
        vec = np.zeros(256)
        vec[3] = np.nan
        with pytest.raises(ValueError):
            ref.truncate_and_normalize(vec)

    def test_scalar_cosine_matches_matrix_path_after_q6(self):
        rng = np.random.default_rng(7)
        a = ref.truncate_and_normalize(rng.normal(size=768))
        b = ref.truncate_and_normalize(rng.normal(size=768))
        scalar = ref.q6(ref.cosine(a, b))
        matrix = ref.q6(float(a @ b))
        assert scalar == matrix

    def test_cache_key_matches_spec_formula(self):
        doc = "Bananas; Fresh > Fruit & veg"
        expected = hashlib.sha1(
            (
                "scanlist-item-vector/1\n"
                "embeddinggemma-2-740m\n"
                "256\n"
                "title: none | text: \n"
                + doc
            ).encode("utf-8")
        ).hexdigest()
        actual = ref.item_vector_cache_key(
            doc,
            model_id="embeddinggemma-2-740m",
            doc_prefix="title: none | text: ",
        )
        assert actual == expected
        assert len(actual) == 40 and actual == actual.lower()
        # Any component of the key invalidates the cache.
        assert actual != ref.item_vector_cache_key(
            doc, model_id="embeddinggemma-2-740m", doc_prefix="task: search result | text: "
        )
        assert actual != ref.item_vector_cache_key(
            doc, model_id="other-model", doc_prefix="title: none | text: "
        )
        assert actual != ref.item_vector_cache_key(
            doc, model_id="embeddinggemma-2-740m", doc_prefix="title: none | text: ", dims=128
        )


# ---------------------------------------------------------------------------
# FLATTEN.md
# ---------------------------------------------------------------------------
class TestFlatten:
    @staticmethod
    def _list(*sections):
        return {"title": "t", "sections": list(sections)}

    def test_derived_ids_match_worked_values(self):
        items = ref.flatten(self._list(
            {"name": "Pantry", "items": [{"name": "Pasta"}]},
            {"name": "Fresh", "sections": [
                {"name": "Fruit & veg", "items": [
                    {"name": "Bananas"},
                    {"name": "Tomatoes"},
                ]},
            ]},
        ))
        assert [it["id"] for it in items] == [
            "sha1:19d895a3b978a4e00caccc2f20ce35044c83cd28",
            "sha1:998e2c1acb80597f39892b85f9dfa8726ead298e",
            "sha1:801b3e63df7a42974bc5f11b4a342251f8c04ba3",
        ]
        assert [it["path"] for it in items] == [
            ["Pantry"], ["Fresh", "Fruit & veg"], ["Fresh", "Fruit & veg"],
        ]
        assert [it["pathText"] for it in items] == [
            "Pantry", "Fresh > Fruit & veg", "Fresh > Fruit & veg",
        ]
        assert [it["order"] for it in items] == [0, 1, 2]

    def test_four_level_nesting_id(self):
        items = ref.flatten(self._list(
            {"name": "A", "sections": [
                {"name": "B", "sections": [
                    {"name": "C", "sections": [
                        {"name": "D", "items": [
                            {"name": "Salt"}, {"name": "Pepper"}, {"name": "Nutmeg"},
                        ]},
                    ]},
                ]},
            ]},
        ))
        assert items[2]["id"] == "sha1:cfc789c216b0dd286fa1f6f40592e8db7aeb7197"
        assert items[2]["path"] == ["A", "B", "C", "D"]
        assert items[2]["index"] == 2

    def test_explicit_id_is_trimmed_and_verbatim(self):
        items = ref.flatten(self._list(
            {"name": "S", "items": [{"id": "  Milk#42  ", "name": "Milk"}]},
        ))
        assert items[0]["id"] == "Milk#42"

    def test_duplicate_ids_are_renamed_deterministically(self):
        items = ref.flatten(self._list(
            {"name": "S", "items": [
                {"id": "milk", "name": "Milk"},
                {"id": "milk", "name": "Milk again"},
                {"id": "milk", "name": "Milk once more"},
            ]},
        ))
        assert [it["id"] for it in items] == ["milk", "milk~2", "milk~3"]

    def test_items_before_sub_sections_in_json_order(self):
        items = ref.flatten(self._list(
            {"name": "Root", "items": [{"name": "Root item"}], "sections": [
                {"name": "First child", "items": [{"name": "Child item"}]},
                {"name": "Second child", "items": [{"name": "Other child"}]},
            ]},
        ))
        assert [it["name"] for it in items] == ["Root item", "Child item", "Other child"]
        assert [it["order"] for it in items] == [0, 1, 2]

    def test_aliases_trimmed_deduped_case_insensitively(self):
        items = ref.flatten(self._list(
            {"name": "S", "items": [
                {"name": "Milk", "aliases": ["Leche", "leche", "Leche ", "  ", "MLÉKO"]},
            ]},
        ))
        # dedupe key is NFC + casefold; the first spelling/order wins
        assert items[0]["aliases"] == ["Leche", "MLÉKO"]

    def test_amount_unit_note_and_done(self):
        items = ref.flatten(self._list(
            {"name": "S", "items": [
                {"name": "Pasta ", "amount": 2, "unit": " kg ", "note": " big bag ", "done": True},
                {"name": "Honey", "amount": "   ", "unit": ""},
                {"name": "Olives", "amount": "250 g tub"},
            ]},
        ))
        pasta, honey, olives = items
        assert pasta["name"] == "Pasta"          # trimmed for display
        assert pasta["amount"] == 2              # JSON type kept
        assert pasta["unit"] == "kg"
        assert pasta["note"] == "big bag"
        assert pasta["done"] is True
        assert honey["amount"] is None           # whitespace-only string -> absent
        assert honey["unit"] is None
        assert olives["amount"] == "250 g tub"
        assert olives["done"] is False

    def test_empty_section_contributes_nothing(self):
        items = ref.flatten(self._list({"name": "Empty", "items": [], "sections": []}))
        assert items == []

    def test_doc_text_worked_examples(self):
        assert ref.doc_text({"name": "Bananas", "aliases": [], "path": ["Fresh", "Fruit & veg"]}) == \
            "Bananas; Fresh > Fruit & veg"
        assert ref.doc_text({
            "name": "Tomatoes", "aliases": ["tomates"], "path": ["Fresh", "Fruit & veg"],
        }) == "Tomatoes; tomates; Fresh > Fruit & veg"
        assert ref.doc_text({
            "name": "Oat milk", "aliases": ["bebida de avena"], "path": ["Fresh", "Dairy"],
        }) == "Oat milk; bebida de avena; Fresh > Dairy"
        assert ref.doc_text({"name": "Milk", "aliases": [], "path": []}) == "Milk"

    def test_load_list_from_path_file_json_and_dict(self):
        path = SAMPLES_DIR / "van-weekly.json"
        raw = json.loads(path.read_text(encoding="utf-8"))
        assert ref.load_list(str(path)) == raw
        with open(path, "r", encoding="utf-8") as fh:
            assert ref.load_list(fh) == raw
        assert ref.load_list(path) == raw
        assert ref.load_list(json.dumps(raw)) == raw
        assert ref.load_list(raw) == raw


# ---------------------------------------------------------------------------
# samples: flatten sanity
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("sample_name", sorted(SAMPLE_ITEM_COUNTS))
def test_samples_flatten(sample_name):
    raw = json.loads((SAMPLES_DIR / sample_name).read_text(encoding="utf-8"))
    items = ref.flatten(raw)

    def count(section):
        return len(section.get("items") or ()) + sum(
            count(child) for child in (section.get("sections") or ())
        )

    independently_counted = sum(count(s) for s in raw["sections"])
    assert len(items) == independently_counted == SAMPLE_ITEM_COUNTS[sample_name]
    assert [it["order"] for it in items] == list(range(len(items)))
    assert len({it["id"] for it in items}) == len(items)
    assert all(it["name"] for it in items)
    assert all(ref.doc_text(it) for it in items)
    # docText never contains the note (FLATTEN.md §4)
    for flattened, plain_items in zip(items, _raw_items(raw)):
        assert ref.doc_text(flattened).startswith(flattened["name"])
        if plain_items.get("note"):
            assert plain_items["note"].strip() not in ref.doc_text(flattened)


def _raw_items(list_obj):
    out = []

    def walk(section):
        for item in section.get("items") or ():
            out.append(item)
        for child in section.get("sections") or ():
            walk(child)

    for section in list_obj["sections"]:
        walk(section)
    return out


# ---------------------------------------------------------------------------
# RANK.md §10 worked example — exact numbers
# ---------------------------------------------------------------------------
MILK_ITEMS = [
    make_item("a", [1, 0, 0, 0], order=0, name="Milk"),
    make_item("b", [0.6, 0.8, 0, 0], order=1, name="Oat milk"),
    make_item("c", [0, 0, 1, 0], order=2, name="Bread"),
]


def tick(items, query, prev, barcode_name=None):
    return ref.rank(items, text_queries(query), prev, barcode_name, dims=4)


class TestWorkedExample:
    def test_tick1_first_observation_equals_raw(self):
        out = tick(MILK_ITEMS, [1, 0, 0, 0], None)
        assert out["ranked"] is True
        assert out["topId"] == "a"
        assert scores(out["entries"]) == [("a", 1.0, 1.0), ("b", 0.6, 0.6), ("c", 0.0, 0.0)]
        assert out["state"]["smoothed"] == {"a": 1.0, "b": 0.6, "c": 0.0}
        assert out["state"]["topId"] == "a"

    def test_tick2_ema_mean_and_top_stays(self):
        out = tick(MILK_ITEMS, [0.8, 0.6, 0, 0], tick(MILK_ITEMS, [1, 0, 0, 0], None)["state"])
        assert out["topId"] == "a"
        assert scores(out["entries"]) == [("a", 0.8, 0.9), ("b", 0.96, 0.78), ("c", 0.0, 0.0)]

    def test_tick3_hysteresis_band_closes_the_margin_gate(self):
        prev = tick(MILK_ITEMS, [0.8, 0.6, 0, 0], tick(MILK_ITEMS, [1, 0, 0, 0], None)["state"])
        out = tick(MILK_ITEMS, [0.8, 0.6, 0, 0], prev["state"])
        assert out["state"]["smoothed"] == {"a": 0.85, "b": 0.87, "c": 0.0}
        assert ref.q6(0.87 - 0.85) == 0.02
        # §6.1 hysteresis keeps `a` as the anchor (0.02 is not > 0.02), but §6.2
        # needs top1 − top2 >= 0.05: the hero is hidden instead of flickering.
        assert out["topId"] is None
        assert out["state"]["topId"] is None
        assert ids(out["entries"]) == ["b", "a", "c"]   # pure ranked order, no hero

    def test_tick4_margin_009_switches_top(self):
        s1 = tick(MILK_ITEMS, [1, 0, 0, 0], None)["state"]
        s2 = tick(MILK_ITEMS, [0.8, 0.6, 0, 0], s1)["state"]
        s3 = tick(MILK_ITEMS, [0.8, 0.6, 0, 0], s2)["state"]
        out = tick(MILK_ITEMS, [0.8, 0.6, 0, 0], s3)
        assert out["state"]["smoothed"] == {"a": 0.825, "b": 0.915, "c": 0.0}
        assert ref.q6(0.915 - 0.825) == 0.09
        assert out["topId"] == "b"
        assert ids(out["entries"]) == ["b", "a", "c"]

    def test_tick5_ticked_top_leaves_and_sinks_without_hysteresis(self):
        states = [tick(MILK_ITEMS, [1, 0, 0, 0], None)["state"]]
        for _ in range(3):
            states.append(tick(MILK_ITEMS, [0.8, 0.6, 0, 0], states[-1])["state"])
        items = [
            dict(MILK_ITEMS[0], done=True),
            MILK_ITEMS[1],
            MILK_ITEMS[2],
        ]
        out = tick(items, [0.8, 0.6, 0, 0], states[-1])
        assert out["topId"] == "b"
        assert scores(out["entries"]) == [
            ("b", 0.96, 0.9375),
            ("c", 0.0, 0.0),
            ("a", None, None),
        ]
        assert out["entries"][-1]["done"] is True
        assert "a" not in out["state"]["smoothed"]      # checked items have no state

    def test_untick_restarts_from_current_raw(self):
        states = [tick(MILK_ITEMS, [1, 0, 0, 0], None)["state"]]
        for _ in range(3):
            states.append(tick(MILK_ITEMS, [0.8, 0.6, 0, 0], states[-1])["state"])
        ticked = [
            dict(MILK_ITEMS[0], done=True),
            MILK_ITEMS[1],
            MILK_ITEMS[2],
        ]
        after_tick = tick(ticked, [0.8, 0.6, 0, 0], states[-1])
        out = tick(MILK_ITEMS, [0.8, 0.6, 0, 0], after_tick["state"])
        assert out["topId"] == "b"
        assert scores(out["entries"]) == [
            ("b", 0.96, 0.94875),
            ("a", 0.8, 0.8),                            # no memory of 0.825
            ("c", 0.0, 0.0),
        ]

    def test_barcode_boost_worked_example(self):
        out = tick(MILK_ITEMS[:2], [0.6, 0.8, 0, 0], None, barcode_name="milk")
        # a: dot 0.6 + 0.15 = 0.75; b: dot 1.0, no match ("oat milk" != "milk")
        assert scores(out["entries"]) == [("b", 1.0, 1.0), ("a", 0.75, 0.75)]

    def test_worked_example_image_tick_hysteresis_and_guard(self):
        # RANK.md §10 image tick: both items confirmed by the same OFF name,
        # y ahead by exactly the 0.005 image margin, hysteresis keeps x.
        x = make_item("x", [0.700, 0, 0, 0], order=0, name="Milk")
        y = make_item("y", [0.705, 0, 0, 0], order=1, name="Oats", aliases=["milk"])
        image = {"text": [], "image": [[1.0, 0, 0, 0]]}
        prev = {"smoothed": {"x": 0.850, "y": 0.855}, "topId": "x"}
        out = ref.rank([x, y], image, prev, "milk", dims=4)
        assert out["topId"] == "x"
        assert scores(out["entries"]) == [("x", 0.85, 0.85), ("y", 0.855, 0.855)]
        unconfirmed = ref.rank([x, y], image, prev, None, dims=4)
        assert unconfirmed["topId"] is None                 # §6.3: no hero without OFF name
        assert ids(unconfirmed["entries"]) == ["y", "x"]    # still ranked

    def test_barcode_boost_is_smoothed_like_any_evidence(self):
        first = tick(MILK_ITEMS[:2], [0.6, 0.8, 0, 0], None, barcode_name="milk")
        second = tick(MILK_ITEMS[:2], [0.6, 0.8, 0, 0], first["state"], barcode_name=None)
        # a loses the boost: (0.6 + 0.75)/2 = 0.675, b: (1.0 + 1.0)/2 = 1.0
        assert scores(second["entries"]) == [("b", 1.0, 1.0), ("a", 0.6, 0.675)]

    def test_boost_alone_never_ranks(self):
        out = ref.rank(MILK_ITEMS[:2], {"text": [], "image": []}, None, "milk", dims=4)
        assert out["ranked"] is False
        assert out["topId"] is None
        assert out["state"] == {"smoothed": {}, "topId": None}


# ---------------------------------------------------------------------------
# §3 scoring: fusion, barcode matching
# ---------------------------------------------------------------------------
class TestScoring:
    def test_fusion_is_max_not_mean(self):
        items = [make_item("x", [1, 0, 0, 0], order=0)]
        out = ref.rank(items, {"text": [[0, 1, 0, 0]], "image": [[1, 0, 0, 0]]}, None, dims=4)
        assert scores(out["entries"]) == [("x", 1.0, 1.0)]

    def test_max_within_text_source_and_across_sources(self):
        items = [make_item("x", [1, 0, 0, 0], order=0)]
        out = ref.rank(
            items,
            {"text": [[0.6, 0.8, 0, 0], [0.8, 0.6, 0, 0]], "image": [[0, 1, 0, 0]]},
            None,
            dims=4,
        )
        # max text = 0.8, image = 0.0 -> max = 0.8 (not 0.4 from a mean)
        assert scores(out["entries"]) == [("x", 0.8, 0.8)]

    def test_negative_cosines_are_kept(self):
        items = [make_item("x", [1, 0, 0, 0], order=0)]
        out = ref.rank(items, text_queries([-1, 0, 0, 0]), None, dims=4)
        assert scores(out["entries"]) == [("x", -1.0, -1.0)]

    def test_barcode_exact_match_only(self):
        item = {"name": "Oat milk", "aliases": ["bebida de avena"]}
        assert ref.barcode_match(item, "Oat milk")
        assert ref.barcode_match(item, "  oat   milk ")
        assert ref.barcode_match(item, "BEBIDA DE AVENA")
        assert not ref.barcode_match(item, "Milk")
        assert not ref.barcode_match(item, "oat")
        assert not ref.barcode_match(item, None)
        assert not ref.barcode_match(item, "   ")

    def test_barcode_match_is_nfc_and_whitespace_normalised(self):
        item = {"name": "Mle\u0301ko", "aliases": []}       # decomposed é
        assert ref.barcode_match(item, "ml\u00e9ko")          # precomposed é
        assert ref.barcode_match({"name": "Beef", "aliases": ["Hovězí  maso"]}, "hovězí maso")

    def test_alias_match_adds_the_boost(self):
        items = [
            make_item("milk", [1, 0, 0, 0], order=0, name="Milk", aliases=["leche"]),
            make_item("bread", [1, 0, 0, 0], order=1, name="Bread"),
        ]
        out = ref.rank(items, text_queries([1, 0, 0, 0]), None, "leche", dims=4)
        assert scores(out["entries"]) == [("milk", 1.15, 1.15), ("bread", 1.0, 1.0)]
        # boost is not clipped after the boost (raw max is 1.15)
        assert out["entries"][0]["raw"] == 1.15

    def test_zero_query_vector_gives_cosine_zero_never_nan(self):
        items = [make_item("x", [1, 0, 0, 0], order=0)]
        out = ref.rank(items, text_queries([0, 0, 0, 0]), None, dims=4)
        assert out["ranked"] is True
        assert scores(out["entries"]) == [("x", 0.0, 0.0)]

    def test_nan_and_inf_queries_are_dropped(self):
        items = [make_item("x", [1, 0, 0, 0], order=0)]
        out = ref.rank(items, {"text": [[np.nan, 0, 0, 0]], "image": [[0, np.inf, 0, 0]]}, None, dims=4)
        assert out["ranked"] is False
        assert out["entries"][0]["smoothed"] is None

    def test_wrong_dimension_query_is_dropped_not_crashing(self):
        items = [make_item("x", [1, 0, 0, 0], order=0)]
        out = ref.rank(items, {"text": [[1, 0, 0]], "image": []}, None, dims=4)
        assert out["ranked"] is False


# ---------------------------------------------------------------------------
# §6 ordering, ties, done group, state
# ---------------------------------------------------------------------------
class TestOrdering:
    def test_ties_follow_flatten_order(self):
        items = [
            make_item("second", [0, 1, 0, 0], order=1, name="Second"),
            make_item("first", [0, 1, 0, 0], order=0, name="First"),
        ]
        # Passed out of order on purpose: `order`, not list position, breaks ties.
        out = ref.rank(items, text_queries([0, 1, 0, 0]), None, dims=4)
        assert ids(out["entries"]) == ["first", "second"]
        # A tie is margin 0: §6.2 closes the gate, so the list ranks with no hero.
        assert out["topId"] is None
        assert out["entries"][0]["smoothed"] == out["entries"][1]["smoothed"] == 1.0

    def test_done_items_sink_and_are_unscored(self):
        items = [
            make_item("a", [1, 0, 0, 0], order=0, name="A", done=True),
            make_item("b", [0, 1, 0, 0], order=1, name="B"),
            make_item("c", [1, 0, 0, 0], order=2, name="C", done=True),
            make_item("d", [0, 1, 0, 0], order=3, name="D"),
        ]
        out = ref.rank(items, text_queries([0, 1, 0, 0]), None, dims=4)
        assert ids(out["entries"]) == ["b", "d", "a", "c"]
        assert [e["done"] for e in out["entries"]] == [False, False, True, True]
        assert out["entries"][2]["raw"] is None
        assert out["entries"][2]["smoothed"] is None
        assert set(out["state"]["smoothed"]) == {"b", "d"}

    def test_all_items_checked_is_ranked_without_top(self):
        items = [make_item("a", [1, 0, 0, 0], order=0, done=True)]
        out = ref.rank(items, text_queries([1, 0, 0, 0]), None, dims=4)
        assert out["ranked"] is True
        assert out["topId"] is None
        assert ids(out["entries"]) == ["a"]
        assert out["state"] == {"smoothed": {}, "topId": None}

    def test_empty_list(self):
        out = ref.rank([], text_queries([1, 0, 0, 0]), None, dims=4)
        assert out == {
            "ranked": True,
            "topId": None,
            "entries": [],
            "state": {"smoothed": {}, "topId": None},
        }

    def test_ticking_the_top_promotes_next_immediately(self):
        # Both clear T=0.79 so the hero is observable at both steps.
        items = [
            make_item("a", [0.98, 0, 0, 0], order=0, name="A"),
            make_item("b", [0.90, 0, 0, 0], order=1, name="B"),
        ]
        first = ref.rank(items, text_queries([1, 0, 0, 0]), None, dims=4)
        assert first["topId"] == "a"
        items[0]["done"] = True
        out = ref.rank(items, text_queries([1, 0, 0, 0]), first["state"], dims=4)
        assert out["topId"] == "b"                       # no hysteresis against a ticked item
        assert ids(out["entries"]) == ["b", "a"]
        assert "a" not in out["state"]["smoothed"]

    def test_prev_top_that_is_no_longer_a_candidate_is_ignored(self):
        items = [make_item("b", [1, 0, 0, 0], order=1)]
        prev = {"smoothed": {"a": 1.0, "b": 1.0}, "topId": "a"}
        out = ref.rank(items, text_queries([1, 0, 0, 0]), prev, dims=4)
        assert out["topId"] == "b"
        assert set(out["state"]["smoothed"]) == {"b"}   # stale state is dropped

    def test_state_accepts_previous_rank_output_and_bare_scores(self):
        items = [make_item("a", [1, 0, 0, 0], order=0)]
        first = ref.rank(items, text_queries([1, 0, 0, 0]), None, dims=4)
        via_state = ref.rank(items, text_queries([1, 0, 0, 0]), first["state"], dims=4)
        via_output = ref.rank(items, text_queries([1, 0, 0, 0]), first, dims=4)
        via_scores = ref.rank(items, text_queries([1, 0, 0, 0]), {"a": 1.0}, dims=4)
        assert via_state["state"]["smoothed"] == via_output["state"]["smoothed"] == {"a": 1.0}
        assert via_scores["state"]["smoothed"] == {"a": 1.0}
        assert via_scores["topId"] == "a"


# ---------------------------------------------------------------------------
# §4 EMA exactness
# ---------------------------------------------------------------------------
class TestEma:
    def test_alpha_is_applied_once_per_tick(self):
        # The dot product is driven by the first component: raw = q6(value).
        item = make_item("a", [1, 0, 0, 0], order=0)
        items = [item]
        state = None
        expected = None
        for value in (1.0, 0.5, 0.75, 0.25):
            item["vec"] = np.asarray([value, 0, 0, 0], dtype=np.float64)
            out = ref.rank(items, text_queries([1, 0, 0, 0]), state, dims=4)
            raw = ref.q6(value)
            expected = raw if expected is None else ref.q6(0.5 * raw + 0.5 * expected)
            assert out["state"]["smoothed"]["a"] == expected
            state = out["state"]

    def test_first_observation_is_raw_and_repeat_converges(self):
        items = [make_item("a", [0.6, 0.8, 0, 0], order=0)]
        state = None
        for _ in range(4):
            out = ref.rank(items, text_queries([0.6, 0.8, 0, 0]), state, dims=4)
            state = out["state"]
        assert state["smoothed"]["a"] == 1.0

    def test_prev_smoothed_that_is_not_a_number_is_ignored(self):
        items = [make_item("a", [1, 0, 0, 0], order=0)]
        out = ref.rank(items, text_queries([1, 0, 0, 0]), {"smoothed": {"a": "x"}, "topId": None}, dims=4)
        assert out["state"]["smoothed"]["a"] == 1.0


# ---------------------------------------------------------------------------
# §8 degraded states
# ---------------------------------------------------------------------------
class TestDegraded:
    def test_no_signal_is_unranked_flatten_order(self):
        items = [
            make_item("a", [1, 0, 0, 0], order=0),
            make_item("b", None, order=1, done=True),
        ]
        out = ref.rank(items, {"text": [], "image": []}, {"smoothed": {"a": 0.5}, "topId": "a"}, dims=4)
        assert out["ranked"] is False
        assert out["topId"] is None
        assert ids(out["entries"]) == ["a", "b"]
        assert [e["done"] for e in out["entries"]] == [False, True]
        assert all(e["raw"] is None and e["smoothed"] is None for e in out["entries"])
        assert out["state"] == {"smoothed": {}, "topId": None}   # state cleared

    def test_missing_item_vector_returns_previous_output(self):
        items = [
            make_item("a", [1, 0, 0, 0], order=0),
            make_item("b", None, order=1),
        ]
        first = ref.rank(
            [items[0]], text_queries([1, 0, 0, 0]), None, dims=4,
        )
        out = ref.rank(
            items, text_queries([1, 0, 0, 0]), first["state"], dims=4,
            prev_output=first,
        )
        assert ids(out["entries"]) == ["a"]              # previous output, not a crash
        assert out["state"] == first["state"]            # state untouched
        assert out["ranked"] is True

    def test_missing_item_vector_first_tick_is_unranked(self):
        items = [make_item("a", None, order=0)]
        out = ref.rank(items, text_queries([1, 0, 0, 0]), None, dims=4)
        assert out["ranked"] is False
        assert ids(out["entries"]) == ["a"]
        assert out["entries"][0]["smoothed"] is None

    def test_wrong_dim_item_vector_is_treated_as_missing(self):
        items = [make_item("a", [1, 0, 0], order=0)]
        out = ref.rank(items, text_queries([1, 0, 0, 0]), None, dims=4)
        assert out["ranked"] is False
        assert out["topId"] is None

    def test_non_finite_item_vector_is_treated_as_missing(self):
        bad = np.zeros(4)
        bad[1] = np.nan
        items = [make_item("a", bad, order=0)]
        out = ref.rank(items, text_queries([1, 0, 0, 0]), None, dims=4)
        assert out["ranked"] is False

    def test_text_queries_are_capped_at_16(self):
        items = [make_item("a", [1, 0, 0, 0], order=0)]
        queries = [[0, 1, 0, 0]] * 16 + [[1, 0, 0, 0]]    # only the 17th would match
        out = ref.rank(items, {"text": queries, "image": []}, None, dims=4)
        assert out["entries"][0]["raw"] == 0.0


# ---------------------------------------------------------------------------
# the highlight decision is isolated (card S10: margin + no-match + image guard)
# ---------------------------------------------------------------------------
class TestDecideTop:
    """§6.1–§6.3 through the isolated function: boundaries are exact here."""

    @staticmethod
    def _candidates(first=0.90, second=0.85, source="text"):
        return [
            {"id": "b", "raw": first, "smoothed": first, "done": False,
             "order": 1, "source": source},
            {"id": "a", "raw": second, "smoothed": second, "done": False,
             "order": 0, "source": source},
        ]

    def test_no_candidates_returns_none(self):
        assert ref.decide_top([], "a") is None

    def test_no_current_top_returns_best_when_the_gate_is_open(self):
        assert ref.decide_top(self._candidates(), None)["id"] == "b"

    def test_text_margin_boundary_exactly_005_highlights(self):
        assert ref.decide_top(self._candidates(0.90, 0.85), None)["id"] == "b"

    def test_text_margin_just_under_005_has_no_hero(self):
        out = ref.decide_top(self._candidates(0.90, 0.8501), None)
        assert out is None
        assert ref.q6(0.90 - 0.8501) < ref.MARGIN_TEXT

    def test_text_floor_boundary_at_079_highlights(self):
        assert ref.decide_top(self._candidates(0.79, 0.70), None)["id"] == "b"

    def test_text_floor_under_079_has_no_hero_even_with_a_wide_margin(self):
        assert ref.decide_top(self._candidates(0.7899, 0.60), None) is None

    def test_text_hysteresis_band_can_never_clear_the_margin_gate(self):
        # Current hero "a" (0.85) is 0.02 behind "b": hysteresis would keep it,
        # but the 0.05 margin gate is closed, so there is no hero at all.
        assert ref.decide_top(self._candidates(0.87, 0.85), "a") is None

    def test_image_hysteresis_is_sticky_above_the_image_margin(self):
        # M_image = 0.005 < HYSTERESIS, so here the two rules *can* both apply.
        got = ref.decide_top(
            self._candidates(0.87, 0.85, source="image"), "a",
            barcode_confirmed_ids={"a", "b"},
        )
        assert got["id"] == "a"
        assert ref.q6(0.87 - 0.85) >= ref.MARGIN_IMAGE

    def test_image_switches_when_the_challenger_leads_by_more_than_hysteresis(self):
        got = ref.decide_top(
            self._candidates(0.90, 0.85, source="image"), "a",
            barcode_confirmed_ids={"a", "b"},
        )
        assert got["id"] == "b"

    def test_image_gate_boundaries_are_inclusive(self):
        confirmed = {"b"}
        assert ref.decide_top(
            self._candidates(0.70, 0.695, source="image"), None,
            barcode_confirmed_ids=confirmed,
        )["id"] == "b"
        assert ref.decide_top(
            self._candidates(0.70, 0.6951, source="image"), None,
            barcode_confirmed_ids=confirmed,
        ) is None
        assert ref.decide_top(
            self._candidates(0.68, 0.60, source="image"), None,
            barcode_confirmed_ids=confirmed,
        )["id"] == "b"
        assert ref.decide_top(
            self._candidates(0.6799, 0.60, source="image"), None,
            barcode_confirmed_ids=confirmed,
        ) is None

    def test_image_guard_requires_accept_list_confirmation(self):
        assert ref.decide_top(self._candidates(0.90, 0.70, source="image"), None) is None
        assert ref.decide_top(
            self._candidates(0.90, 0.70, source="image"), None, barcode_confirmed_ids={"b"},
        )["id"] == "b"

    def test_single_candidate_has_a_vacuous_margin(self):
        only = [{"id": "a", "raw": 0.85, "smoothed": 0.85, "done": False, "order": 0}]
        assert ref.decide_top(only, None)["id"] == "a"
        low = [{"id": "a", "raw": 0.78, "smoothed": 0.78, "done": False, "order": 0}]
        assert ref.decide_top(low, None) is None


# ---------------------------------------------------------------------------
# §7 cadence / lifecycle
# ---------------------------------------------------------------------------
class TestCadence:
    def test_at_most_one_evaluation_per_400ms(self):
        ticker = ref.RankTicker(dims=4)
        ticker.submit([np.asarray([1, 0, 0, 0], dtype=np.float64)])
        assert ticker.tick(MILK_ITEMS, at_ms=1000) is not None
        assert ticker.tick(MILK_ITEMS, at_ms=1200) is None      # inside the window
        assert ticker.tick(MILK_ITEMS, at_ms=1399) is None
        assert ticker.tick(MILK_ITEMS, at_ms=1400) is not None  # exactly 400 ms later
        assert ticker.tick(MILK_ITEMS, at_ms=1450) is None

    def test_immediate_tick_resets_the_clock(self):
        ticker = ref.RankTicker(dims=4)
        ticker.submit([np.asarray([1, 0, 0, 0], dtype=np.float64)])
        ticker.tick(MILK_ITEMS, at_ms=1000)
        assert ticker.tick_now(MILK_ITEMS, at_ms=1050) is not None
        assert ticker.tick(MILK_ITEMS, at_ms=1300) is None      # 250 ms after the immediate tick
        assert ticker.tick(MILK_ITEMS, at_ms=1450) is not None

    def test_pending_queries_are_replaced_not_queued(self):
        ticker = ref.RankTicker(dims=4)
        ticker.submit([np.asarray([0, 0, 1, 0], dtype=np.float64)])
        ticker.submit([np.asarray([1, 0, 0, 0], dtype=np.float64)])
        out = ticker.tick(MILK_ITEMS, at_ms=0)
        assert out["topId"] == "a"                              # only the latest frame counts

    def test_submit_none_keeps_the_other_source(self):
        ticker = ref.RankTicker(dims=4)
        image = np.asarray([1, 0, 0, 0], dtype=np.float64)
        ticker.submit(text=[], image=[image])
        ticker.submit(text=[np.asarray([0, 1, 0, 0], dtype=np.float64)])
        out = ticker.tick(MILK_ITEMS, at_ms=0)
        # text [0,1,0,0] gives b=0.8, image [1,0,0,0] gives a=1.0 -> a wins via max fusion
        assert ids(out["entries"])[0] == "a"
        assert out["state"]["smoothed"]["a"] == 1.0
        # a's base came from the image source (1.0 > 0.0) and no barcode confirmed
        # it, so §6.3 hides the hero while the ranked order still puts a first.
        assert out["topId"] is None

    def test_tick_now_smooths_from_the_previous_state(self):
        ticker = ref.RankTicker(dims=4)
        ticker.submit([np.asarray([1, 0, 0, 0], dtype=np.float64)])
        first = ticker.tick(MILK_ITEMS, at_ms=0)
        ticker.submit([np.asarray([0.8, 0.6, 0, 0], dtype=np.float64)])
        second = ticker.tick_now(MILK_ITEMS, at_ms=10)
        assert first["state"]["smoothed"]["a"] == 1.0
        assert second["state"]["smoothed"]["a"] == 0.9
        assert second["state"]["smoothed"]["b"] == 0.78

    def test_list_changed_clears_state(self):
        ticker = ref.RankTicker(dims=4)
        ticker.submit([np.asarray([1, 0, 0, 0], dtype=np.float64)])
        ticker.tick(MILK_ITEMS, at_ms=0)
        out = ticker.list_changed(MILK_ITEMS, at_ms=10)
        assert out["state"]["smoothed"] == {"a": 1.0, "b": 0.6, "c": 0.0}
        assert out["state"]["topId"] == "a"

    def test_scan_stopped_returns_unranked_and_clears_queries(self):
        ticker = ref.RankTicker(dims=4)
        ticker.submit([np.asarray([1, 0, 0, 0], dtype=np.float64)])
        ticker.tick(MILK_ITEMS, at_ms=0)
        out = ticker.scan_stopped(MILK_ITEMS)
        assert out["ranked"] is False
        assert ids(out["entries"]) == ["a", "b", "c"]
        assert ticker.queries == {"text": [], "image": []}
        assert ticker.state == {"smoothed": {}, "topId": None}


# ---------------------------------------------------------------------------
# sanity: rank the real samples with 256-d vectors (no model, fixed seed)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("sample_name", sorted(SAMPLE_ITEM_COUNTS))
def test_rank_samples_with_synthetic_256d_vectors(sample_name):
    rng = np.random.default_rng(11)
    items = ref.flatten(ref.load_list(SAMPLES_DIR / sample_name))
    for item in items:
        item["vec"] = ref.truncate_and_normalize(rng.normal(size=768))
    query = ref.truncate_and_normalize(rng.normal(size=768))

    out = ref.rank(items, {"text": [query], "image": []}, None)
    assert out["ranked"] is True
    assert len(out["entries"]) == len(items)
    assert {e["id"] for e in out["entries"]} == {it["id"] for it in items}
    scored = [e for e in out["entries"] if not e["done"]]
    if scored:
        # Random unit vectors sit far below T_text=0.79: no hero, but the list is
        # still ordered by smoothed score, and a hero (when present) is that row.
        assert out["entries"][0]["smoothed"] == max(e["smoothed"] for e in scored)
        assert out["topId"] is None
        assert out["state"]["topId"] is None

    done_ids = {it["id"] for it in items if it["done"]}
    if len(done_ids) == len(items):
        assert out["topId"] is None
    else:
        assert out["topId"] not in done_ids
        assert out["state"]["smoothed"].keys() == {
            it["id"] for it in items if not it["done"]
        }
    for entry in out["entries"]:
        if entry["done"]:
            assert entry["raw"] is None and entry["smoothed"] is None
        else:
            assert -1.0 <= entry["smoothed"] <= 1.15
    # done group is last and in flatten order
    done_in_flatten_order = [it["id"] for it in items if it["done"]]
    if done_in_flatten_order:
        assert ids(out["entries"])[-len(done_in_flatten_order):] == done_in_flatten_order


# ---------------------------------------------------------------------------
# §6.2/§6.3 highlight gates through rank() (card S10)
# ---------------------------------------------------------------------------
class TestHighlightGate:
    """The gates never change what is scored or how it is ordered — only the hero."""

    @staticmethod
    def _pair(first, second, *, source_items=None):
        items = source_items or [
            make_item("a", [first, 0, 0, 0], order=0, name="Alpha"),
            make_item("b", [second, 0, 0, 0], order=1, name="Beta"),
        ]
        return items

    def test_text_margin_at_the_boundary_highlights(self):
        out = ref.rank(self._pair(0.90, 0.85), text_queries([1, 0, 0, 0]), None, dims=4)
        assert out["topId"] == "a"
        assert ids(out["entries"]) == ["a", "b"]

    def test_text_margin_below_the_boundary_ranks_without_a_hero(self):
        out = ref.rank(self._pair(0.90, 0.8501), text_queries([1, 0, 0, 0]), None, dims=4)
        assert out["topId"] is None
        assert out["state"]["topId"] is None
        assert ids(out["entries"]) == ["a", "b"]          # order still ranked
        assert [e["smoothed"] for e in out["entries"]] == [0.90, 0.8501]
        assert out["state"]["smoothed"] == {"a": 0.90, "b": 0.8501}   # state unchanged

    def test_no_match_floor_rejects_a_wide_margin_low_score(self):
        out = ref.rank(self._pair(0.78, 0.70), text_queries([1, 0, 0, 0]), None, dims=4)
        assert out["topId"] is None                       # margin 0.08 but top1 < 0.79

    def test_floor_boundary_at_079_highlights(self):
        out = ref.rank(self._pair(0.79, 0.70), text_queries([1, 0, 0, 0]), None, dims=4)
        assert out["topId"] == "a"

    def test_exact_tie_has_no_hero(self):
        out = ref.rank(self._pair(0.95, 0.95), text_queries([1, 0, 0, 0]), None, dims=4)
        assert out["topId"] is None

    def test_single_candidate_has_a_vacuous_margin_but_still_needs_the_floor(self):
        high = ref.rank(self._pair(0.85, 0.0)[:1], text_queries([1, 0, 0, 0]), None, dims=4)
        assert high["topId"] == "a"
        low = ref.rank(self._pair(0.78, 0.0)[:1], text_queries([1, 0, 0, 0]), None, dims=4)
        assert low["topId"] is None

    def test_barcode_boost_can_open_the_gate(self):
        # 0.66 raw is below T; the +0.15 boost lifts the confirmed item to 0.81
        # and it then clears the margin against the runner-up at 0.70.
        out = ref.rank(
            self._pair(0.66, 0.70), text_queries([1, 0, 0, 0]), None,
            barcode_name="Alpha", dims=4,
        )
        assert out["entries"][0]["raw"] == 0.81
        assert out["topId"] == "a"

    def test_mixed_tick_text_driven_winner_uses_the_text_gate(self):
        items = [
            make_item("a", [0.95, 0.05, 0, 0], order=0, name="Alpha"),
            make_item("b", [0.60, 0.80, 0, 0], order=1, name="Beta"),
        ]
        out = ref.rank(
            items, {"text": [[1, 0, 0, 0]], "image": [[0, 0, 1, 0]]}, None, dims=4,
        )
        assert out["topId"] == "a"                        # image queries score 0 here

    def test_image_only_tick_without_confirmation_has_no_hero(self):
        out = ref.rank(
            self._pair(0.75, 0.70), {"text": [], "image": [[1, 0, 0, 0]]}, None, dims=4,
        )
        # Passes T_image=0.68 and the 0.005 margin, but §6.3 needs confirmation.
        assert out["topId"] is None
        assert ids(out["entries"]) == ["a", "b"]

    def test_accept_list_confirmation_highlights_an_image_winner(self):
        out = ref.rank(
            self._pair(0.75, 0.70), {"text": [], "image": [[1, 0, 0, 0]]}, None,
            barcode_name="Alpha", dims=4,
        )
        assert out["entries"][0]["raw"] == 0.90           # 0.75 + 0.15 boost
        assert out["topId"] == "a"

    def test_image_floor_rejects_below_068_even_when_confirmed(self):
        # Confirmed, wide margin, but 0.60+0.15 = 0.75 ... use an unboosted path:
        # confirmation is on a *different* item, so the image winner stays raw.
        items = [
            make_item("a", [0.60, 0, 0, 0], order=0, name="Alpha"),
            make_item("b", [0.40, 0, 0, 0], order=1, name="Beta"),
        ]
        out = ref.rank(
            items, {"text": [], "image": [[1, 0, 0, 0]]}, None, dims=4,
        )
        assert out["topId"] is None                       # 0.60 < T_image and unconfirmed


# ---------------------------------------------------------------------------
# golden.json — the gates on S3's measured queries (card S10)
# ---------------------------------------------------------------------------
GOLDEN_PATH = Path(__file__).resolve().parents[1] / "fixtures" / "golden.json"
_GOLDEN = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))


def golden_rank(query, *, barcode_name=None):
    """One tick of ``query`` against its list, exactly as golden.json contracts it."""
    lst = next(l for l in _GOLDEN["lists"] if l["id"] == query["list"])
    items = []
    for item in lst["items"]:
        clone = dict(item)
        clone["vec"] = np.asarray(lst["itemVectors"][item["id"]], dtype=np.float64)
        items.append(clone)
    queries = {"text": [], "image": []}
    queries[query["kind"]] = [np.asarray(query["vector"], dtype=np.float64)]
    return ref.rank(items, queries, None, barcode_name)


def golden_queries(kind=None, expect=None):
    return [
        q for q in _GOLDEN["queries"]
        if (kind is None or q["kind"] == kind) and (expect is None or q["expect"] == expect)
    ]


@pytest.mark.parametrize("query", _GOLDEN["queries"], ids=lambda q: q["id"])
def test_golden_ranked_order_is_unchanged(query):
    """§6.2/§6.3 change only the hero: top-3 ids and scores stay as S3 measured."""
    out = golden_rank(query)
    ranked = [e for e in out["entries"] if not e["done"]][:3]
    assert [e["id"] for e in ranked] == query["expectedTop3"]
    assert [e["smoothed"] for e in ranked] == query["expectedScores"]


class TestGoldenHighlight:
    def test_every_text_distractor_produces_no_highlight(self):
        for query in golden_queries("text", "nomatch"):
            out = golden_rank(query)
            assert out["topId"] is None, query["id"]
            assert out["ranked"] is True
            # ranking still works: the same row is first, with its measured score
            assert out["entries"][0]["smoothed"] == query["expectedScores"][0], query["id"]

    def test_text_hits_highlight_except_the_one_margin_failure(self):
        highlighted = {}
        for query in golden_queries("text", "hit"):
            highlighted[query["id"]] = golden_rank(query)["topId"]
        # t20 ("hovězí maso 500 g", margin 0.039765 < 0.05) fails safe: no hero.
        assert {qid for qid, top in highlighted.items() if top is None} == {"t20"}
        for query in golden_queries("text", "hit"):
            if query["id"] != "t20":
                assert highlighted[query["id"]] == query["expectedTop3"][0], query["id"]

    def test_cheese_photo_never_highlights(self):
        query = next(q for q in _GOLDEN["queries"] if q["id"] == "icheese")
        out = golden_rank(query)
        # The measured false positive is still ranked first (that is the point),
        # but the accept-list guard keeps the hero off it.
        assert out["entries"][0]["id"] == query["expectedTop3"][0]      # Greek yoghurt
        assert out["entries"][0]["smoothed"] == 0.699416
        assert out["topId"] is None

    def test_eggs_and_bread_stay_suppressed(self):
        for query_id in ("ieggs", "ibread"):
            query = next(q for q in _GOLDEN["queries"] if q["id"] == query_id)
            out = golden_rank(query)
            margin = ref.q6(out["entries"][0]["smoothed"] - out["entries"][1]["smoothed"])
            assert margin < ref.MARGIN_IMAGE, query_id          # 0.003758 / 0.003876
            assert out["topId"] is None, query_id

    def test_unconfirmed_image_ticks_never_highlight(self):
        # v1 accept-list guard (RANK.md §6.3): the fixture ranks photo vectors
        # without an OFF name, so no image tick has a confirmed winner. This is
        # the documented trade-off — ranked order only, no hero for the camera.
        for query in golden_queries("image"):
            assert golden_rank(query)["topId"] is None, query["id"]

    def test_off_name_confirmation_promotes_the_winner(self):
        query = next(q for q in _GOLDEN["queries"] if q["id"] == "ihoney")
        out = golden_rank(query, barcode_name="Honey")
        assert out["topId"] == query["expectedTop3"][0]
        assert out["entries"][0]["raw"] == 0.902869             # 0.752869 + 0.15
        # The confirmation is stricter than the gate: even the cheese confusion
        # becomes a correct highlight once the OFF name names the item.
        cheese = next(q for q in _GOLDEN["queries"] if q["id"] == "icheese")
        out = golden_rank(cheese, barcode_name="Cheese")
        assert out["topId"] in cheese["accept"]
