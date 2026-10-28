from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from scripts import json_sources as J


class JsonSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp: TemporaryDirectory[str] = TemporaryDirectory(prefix="robb-json-sources-")
        self.root = Path(self.temp.name)
        self.spec = J.DataSource("runtime.json", "sources")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def capture(self, value: J.JsonValue) -> dict[Path, str]:
        (self.root / self.spec.output).write_text(J.pretty(value))
        plan = J.capture_plan(self.root, self.spec)
        for path, text in plan.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        return plan

    def test_reconstructs_nested_unicode_and_scalar_types_without_changing_the_runtime_file(self) -> None:
        value: J.JsonValue = {"name": "Rapport vérifié", "flags": [True, False, None, 1, "1", 1.0],
            "rows": [{"id": i, "checks": ["validé"] * 8} for i in range(120)]}
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
                self.capture(value)
                self.assertEqual(J.canonical(J.assemble(self.root, self.spec)), J.canonical(value))

    def test_detects_stale_generated_values_including_boolean_number_confusion(self) -> None:
        self.capture({"ready": True})
        (self.root / self.spec.output).write_text('{"ready": 1}')
        self.assertFalse(J.matches(self.root, self.spec))

    def test_missing_partition_fails_without_rewriting_runtime_data(self) -> None:
        plan = self.capture([{"id": "first"}])
        part = next(path for path in plan if path.parent.name == "items")
        original = (self.root / self.spec.output).read_bytes()
        part.unlink()
        with self.assertRaises(FileNotFoundError):
            J.matches(self.root, self.spec)
        self.assertEqual((self.root / self.spec.output).read_bytes(), original)

    def test_rejects_paths_outside_the_dataset_owner(self) -> None:
        with self.assertRaises(ValueError):
            J.capture_plan(self.root, J.DataSource("../outside.json", "sources"))
        self.capture([1])
        (self.root / "sources/manifest.json").write_text('{"format":1,"arrays":{"items":["../../outside.json"]}}')
        with self.assertRaises(ValueError):
            J.assemble(self.root, self.spec)

    def test_rejects_duplicate_keys_nonfinite_data_and_long_maintained_sources(self) -> None:
        target = self.root / "invalid.json"
        for text in ['{"id":1,"id":2}', '{"value":NaN}', '{"value":Infinity}']:
            target.write_text(text)
            with self.assertRaises(ValueError):
                J.read_json(target)
        target.write_text("\n" * 501 + "{}")
        with self.assertRaises(ValueError):
            J.read_json(target, source=True)


if __name__ == "__main__":
    unittest.main()
