#!/usr/bin/env python3
"""Validate ScanList list files against shared/spec/list.schema.json.

Usage
    python3 shared/spec/validate.py shared/spec/samples/*.json
    python3 shared/spec/validate.py --strict samples/*.json     # warnings become errors
    python3 shared/spec/validate.py --schema other.json list.json

Exit status: 0 = every file valid, 1 = at least one invalid/readable file, 2 = usage error.

No third-party dependency is required: if `jsonschema` is installed it is used for full
JSON-Schema draft 2020-12 validation, otherwise a small built-in validator for the subset of
keywords used by list.schema.json is used (same accept/reject behaviour for this schema).

Besides schema validation, a few FLATTEN/LIST invariants are checked as warnings (duplicate
explicit ids, unknown keys, unit without amount, empty alias entries). Those never make a file
invalid unless --strict is given.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import unicodedata
from pathlib import Path

SPEC_DIR = Path(__file__).resolve().parent
DEFAULT_SCHEMA = SPEC_DIR / "list.schema.json"
DOCS_SCHEMA = SPEC_DIR.parent.parent / "docs" / "list.schema.json"

KNOWN_LIST_KEYS = {"title", "version", "sections"}
KNOWN_SECTION_KEYS = {"name", "items", "sections"}
KNOWN_ITEM_KEYS = {"id", "name", "amount", "unit", "note", "aliases", "done"}


# --------------------------------------------------------------------------- schema loading


def load_schema(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def make_validator(schema: dict):
    """Return (callable(instance) -> list[str], engine_description)."""
    try:
        import jsonschema  # type: ignore

        validator = jsonschema.Draft202012Validator(schema)

        def validate(instance):
            errors = []
            for err in sorted(validator.iter_errors(instance), key=lambda e: list(e.absolute_path)):
                ptr = "/" + "/".join(str(p) for p in err.absolute_path) if err.absolute_path else "/"
                errors.append(f"{ptr}: {err.message}")
            return errors

        try:
            from importlib.metadata import version as _dist_version

            engine = f"jsonschema {_dist_version('jsonschema')}"
        except Exception:
            engine = "jsonschema"
        return validate, engine
    except ImportError:
        def validate(instance):
            errors: list[str] = []
            _validate(instance, schema, schema, "", errors)
            return errors

        return validate, "built-in fallback"


# --------------------------------------------------------------- minimal JSON-Schema validator


def _resolve_ref(ref: str, root: dict):
    if not ref.startswith("#"):
        raise ValueError(f"unsupported $ref {ref!r}")
    node = root
    for token in ref[1:].split("/"):
        if not token:
            continue
        token = token.replace("~1", "/").replace("~0", "~")
        node = node[token]
    return node


def _is_type(value, name: str) -> bool:
    if name == "object":
        return isinstance(value, dict)
    if name == "array":
        return isinstance(value, list)
    if name == "string":
        return isinstance(value, str)
    if name == "boolean":
        return isinstance(value, bool)
    if name == "null":
        return value is None
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return False


def _validate(value, schema, root, path: str, errors: list[str]) -> None:
    if not isinstance(schema, dict):
        return
    if "$ref" in schema:
        _validate(value, _resolve_ref(schema["$ref"], root), root, path, errors)
        return
    if "allOf" in schema:
        for sub in schema["allOf"]:
            _validate(value, sub, root, path, errors)
    if "anyOf" in schema:
        if not any(not _sub_errors(value, sub, root, path) for sub in schema["anyOf"]):
            errors.append(f"{path}: does not match anyOf")
    if "oneOf" in schema:
        hits = sum(1 for sub in schema["oneOf"] if not _sub_errors(value, sub, root, path))
        if hits != 1:
            errors.append(f"{path}: matches {hits} of oneOf (expected 1)")
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: expected const {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: {value!r} is not one of {schema['enum']!r}")

    expected = schema.get("type")
    if expected is not None:
        names = [expected] if isinstance(expected, str) else list(expected)
        if not any(_is_type(value, n) for n in names):
            errors.append(f"{path}: {type(value).__name__} is not of type {'/'.join(names)}")
            return

    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required property {key!r}")
        props = schema.get("properties", {})
        for key, sub in props.items():
            if key in value:
                _validate(value[key], sub, root, f"{path}/{key}", errors)
        extra = schema.get("additionalProperties", True)
        for key, sub in value.items():
            if key in props:
                continue
            if extra is False:
                errors.append(f"{path}: additional property {key!r} is not allowed")
            elif isinstance(extra, dict):
                _validate(sub, extra, root, f"{path}/{key}", errors)
    elif isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path}: more than {schema['maxItems']} items")
        if schema.get("uniqueItems"):
            seen = []
            for entry in value:
                if entry in seen:
                    errors.append(f"{path}: duplicate array entry {entry!r}")
                seen.append(entry)
        if isinstance(schema.get("items"), dict):
            for i, entry in enumerate(value):
                _validate(entry, schema["items"], root, f"{path}/{i}", errors)
    elif isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: shorter than {schema['minLength']} characters")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{path}: longer than {schema['maxLength']} characters")
    elif _is_type(value, "number"):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: {value} < minimum {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: {value} > maximum {schema['maximum']}")


def _sub_errors(value, schema, root, path) -> list[str]:
    errors: list[str] = []
    _validate(value, schema, root, path, errors)
    return errors


# --------------------------------------------------------------------- ScanList invariants


def _norm(s: str) -> str:
    return unicodedata.normalize("NFC", s).casefold().strip()


def _derived_id(path: list[str], name: str, index: int) -> str:
    key = ("/".join(path) + "/" if path else "") + name + "#" + str(index)
    return "sha1:" + hashlib.sha1(key.encode("utf-8")).hexdigest()


def _walk_sections(list_obj: dict):
    """Yield (section, path, depth, json_pointer) depth-first, sections in JSON order."""
    if not isinstance(list_obj, dict):
        return
    sections = list_obj.get("sections")
    if not isinstance(sections, list):
        return
    stack = []
    for i in range(len(sections) - 1, -1, -1):
        section = sections[i]
        name = section.get("name") if isinstance(section, dict) else None
        stack.append((section, [name if isinstance(name, str) else ""], 1, f"/sections/{i}"))
    while stack:
        section, path, depth, ptr = stack.pop()
        yield section, path, depth, ptr
        children = section.get("sections") if isinstance(section, dict) else None
        if not isinstance(children, list):
            continue
        for i in range(len(children) - 1, -1, -1):
            child = children[i]
            name = child.get("name") if isinstance(child, dict) else None
            stack.append((child, path + [name if isinstance(name, str) else ""], depth + 1,
                          f"{ptr}/sections/{i}"))


def check_invariants(list_obj: dict, warnings: list[str], strict: bool) -> tuple[int, int]:
    """Return (item_count, max_section_depth). Append human-readable warnings."""
    def warn(msg: str) -> None:
        if strict:
            warnings.append("ERROR " + msg)
        else:
            warnings.append("WARN " + msg)

    if not isinstance(list_obj, dict):
        return 0, 0
    title = list_obj.get("title")
    if isinstance(title, str) and not title.strip():
        warn("/title: empty or whitespace-only title")
    version = list_obj.get("version", 1)
    if isinstance(version, int) and not isinstance(version, bool) and version < 1:
        warn(f"/version: {version} is < 1")
    for key in list_obj:
        if key not in KNOWN_LIST_KEYS:
            warn(f"/{key}: unknown top-level key (ignored)")

    item_count = 0
    max_depth = 0
    used_ids: dict[str, str] = {}      # final id -> pointer of first use
    candidates: dict[str, str] = {}    # candidate id -> pointer of first use

    for section, path, depth, ptr in _walk_sections(list_obj):
        max_depth = max(max_depth, depth)
        if not isinstance(section, dict):
            continue
        name = section.get("name")
        if isinstance(name, str) and not name.strip():
            warn(f"{ptr}/name: empty or whitespace-only section name")
        for key in section:
            if key not in KNOWN_SECTION_KEYS:
                warn(f"{ptr}/{key}: unknown section key (ignored)")
        items = section.get("items") or []
        if not isinstance(items, list):
            continue
        for i, item in enumerate(items):
            iptr = f"{ptr}/items/{i}"
            if not isinstance(item, dict):
                continue
            item_count += 1
            iname = item.get("name")
            if isinstance(iname, str) and not iname.strip():
                warn(f"{iptr}/name: empty or whitespace-only item name")
            for key in item:
                if key not in KNOWN_ITEM_KEYS:
                    warn(f"{iptr}/{key}: unknown item key (ignored)")

            aliases = item.get("aliases") or []
            if isinstance(aliases, list):
                seen_alias = set()
                for a in aliases:
                    if isinstance(a, str):
                        if not a.strip():
                            warn(f"{iptr}/aliases: empty alias entry (ignored)")
                        norm = _norm(a)
                        if norm in seen_alias:
                            warn(f"{iptr}/aliases: duplicate alias {a!r} (deduped)")
                        seen_alias.add(norm)
            if item.get("unit") is not None and item.get("amount") is None:
                warn(f"{iptr}: unit without amount (unit is not displayed)")

            raw_id = item.get("id")
            if isinstance(raw_id, str) and raw_id.strip():
                candidate = raw_id.strip()
            else:
                candidate = _derived_id(path, iname if isinstance(iname, str) else "", i)

            if candidate in candidates:
                warn(f"{iptr}: duplicate item id {candidate!r} (first at {candidates[candidate]}); "
                     f"the flattener renames this one to '{candidate}~2'")
            else:
                candidates[candidate] = iptr
            final_id, n = candidate, 2
            while final_id in used_ids:
                final_id = f"{candidate}~{n}"
                n += 1
            used_ids[final_id] = iptr

    return item_count, max_depth


# ----------------------------------------------------------------------------------- main


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Validate ScanList JSON lists against list.schema.json.")
    parser.add_argument("files", nargs="+", metavar="LIST.json",
                        help="list files to validate (shell globs are fine)")
    parser.add_argument("--schema", default=None, help="schema path (default: shared/spec/list.schema.json)")
    parser.add_argument("--strict", action="store_true", help="treat invariant warnings as errors")
    parser.add_argument("-q", "--quiet", action="store_true", help="only print problems and the final line")
    args = parser.parse_args(argv)

    schema_path = Path(args.schema) if args.schema else DEFAULT_SCHEMA
    if not schema_path.exists() and args.schema is None and DOCS_SCHEMA.exists():
        schema_path = DOCS_SCHEMA
    if not schema_path.exists():
        print(f"FAIL: schema not found: {schema_path}", file=sys.stderr)
        return 1

    try:
        schema = load_schema(schema_path)
        validate, engine = make_validator(schema)
    except Exception as exc:  # malformed schema is a hard error
        print(f"FAIL: cannot load schema {schema_path}: {exc}", file=sys.stderr)
        return 1

    if not args.quiet:
        print(f"schema: {schema_path}  ({engine})")

    total_files = total_items = total_warnings = 0
    failed = False

    for name in args.files:
        path = Path(name)
        total_files += 1
        try:
            raw = path.read_bytes()
            text = raw.decode("utf-8")
            instance = json.loads(text)
        except FileNotFoundError:
            print(f"FAIL {path}: file not found")
            failed = True
            continue
        except UnicodeDecodeError as exc:
            print(f"FAIL {path}: not UTF-8 ({exc})")
            failed = True
            continue
        except json.JSONDecodeError as exc:
            print(f"FAIL {path}: invalid JSON at line {exc.lineno} column {exc.colno}: {exc.msg}")
            failed = True
            continue

        file_errors = validate(instance)
        warnings: list[str] = []
        items, depth = check_invariants(instance, warnings, args.strict)
        strict_errors = [w[len("ERROR "):] for w in warnings if w.startswith("ERROR ")]
        warns = [w for w in warnings if w.startswith("WARN ")]
        file_errors.extend(strict_errors)

        total_items += items
        total_warnings += len(warns)

        if file_errors:
            failed = True
            print(f"FAIL {path}")
            for msg in file_errors:
                print(f"  - {msg}")
        elif not args.quiet:
            print(f"OK   {path}  ({len(instance.get('sections') or [])} top sections, "
                  f"{items} items, max depth {depth})")
        else:
            print(f"OK   {path}")
        for msg in warns:
            print(f"  {msg}  [{path}]")

    if failed:
        print(f"FAILED: {total_files} file(s) checked, {total_items} items, {total_warnings} warning(s)")
        return 1
    print(f"OK: {total_files} file(s), {total_items} items, {total_warnings} warning(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
