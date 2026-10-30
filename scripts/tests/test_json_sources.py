from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import override

from scripts import json_sources as J


class JsonSourceTests(unittest.TestCase):
    temp: TemporaryDirectory[str] | None = None

    @property
    def root(self) -> Path:
        if self.temp is None:
            raise RuntimeError("JSON fixture is not set up")
        return Path(self.temp.name)

    @property
    def spec(self) -> J.DataSource:
        return J.DataSource("runtime.json", "sources")

    @override
    def setUp(self) -> None:
        self.temp = TemporaryDirectory(prefix="robb-json-sources-")

    @override
    def tearDown(self) -> None:
        if self.temp is not None:
            self.temp.cleanup()
            self.temp = None

    def capture(self, value: J.JsonValue) -> dict[Path, str]:
        _ = (self.root / self.spec.output).write_text(J.pretty(value))
        plan = J.capture_plan(self.root, self.spec)
        for path, text in plan.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            _ = path.write_text(text)
        return plan

    def test_reconstructs_nested_unicode_and_scalar_types_without_changing_the_runtime_file(self) -> None:
        rows: list[J.JsonValue] = []
        for i in range(120):
            checks: list[J.JsonValue] = ["validé"] * 8
            row: dict[str, J.JsonValue] = {"id": i, "checks": checks}
            rows.append(row)
        value: J.JsonValue = {"name": "Rapport vérifié", "flags": [True, False, None, 1, "1", 1.0],
                             "rows": rows}
        plan = self.capture(value)
        original = (self.root / self.spec.output).read_bytes()
        self.assertGreater(len(plan), 4)
        self.assertTrue(all(len(text.splitlines()) <= J.MAX_SOURCE_LINES for text in plan.values()))
        self.assertEqual(J.canonical(J.assemble(self.root, self.spec)), J.canonical(value))
        self.assertTrue(J.matches(self.root, self.spec))
        self.assertEqual((self.root / self.spec.output).read_bytes(), original)

    def test_preserves_an_array_root_and_empty_arrays(self) -> None:
        values: list[J.JsonValue] = [[], {"rows": []}, [{"id": "first"}, {"id": "second"}]]
        for value in values:
            with self.subTest(value=value):
                _ = self.capture(value)
                self.assertEqual(J.canonical(J.assemble(self.root, self.spec)), J.canonical(value))

    def test_detects_stale_generated_values_including_boolean_number_confusion(self) -> None:
        _ = self.capture({"ready": True})
        _ = (self.root / self.spec.output).write_text('{"ready": 1}')
        self.assertFalse(J.matches(self.root, self.spec))

    def test_missing_partition_fails_without_rewriting_runtime_data(self) -> None:
        plan = self.capture([{"id": "first"}])
        part = next(path for path in plan if path.parent.name == "items")
        original = (self.root / self.spec.output).read_bytes()
        part.unlink()
        with self.assertRaises(FileNotFoundError):
            _ = J.matches(self.root, self.spec)
        self.assertEqual((self.root / self.spec.output).read_bytes(), original)

    def test_rejects_paths_outside_the_dataset_owner(self) -> None:
        with self.assertRaises(ValueError):
            _ = J.capture_plan(self.root, J.DataSource("../outside.json", "sources"))
        _ = self.capture([1])
        _ = (self.root / "sources/manifest.json").write_text('{"format":1,"arrays":{"items":["../../outside.json"]}}')
        with self.assertRaises(ValueError):
            _ = J.assemble(self.root, self.spec)

    def test_rejects_duplicate_keys_nonfinite_data_and_long_maintained_sources(self) -> None:
        target = self.root / "invalid.json"
        for text in ['{"id":1,"id":2}', '{"value":NaN}', '{"value":Infinity}']:
            _ = target.write_text(text)
            with self.assertRaises(ValueError):
                _ = J.read_json(target)
        _ = target.write_text("\n" * 501 + "{}")
        with self.assertRaises(ValueError):
            _ = J.read_json(target, source=True)


if __name__ == "__main__":
    _ = unittest.main()
