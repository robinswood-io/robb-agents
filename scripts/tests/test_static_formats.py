"""Prove malformed formats and filesystem-capable SQL/Make inputs fail closed."""
from __future__ import annotations

import sqlite3
import tempfile
import tomllib
import unittest
from pathlib import Path

from validate_static_formats import validate_make, validate_sql, validate_toml


class StaticFormatsTests(unittest.TestCase):
    def test_toml_duplicate_keys_and_types(self) -> None:
        validate_toml('enabled = true\ncount = 2')
        with self.assertRaises(tomllib.TOMLDecodeError):
            validate_toml('a = 1\na = 2')
        with self.assertRaises(tomllib.TOMLDecodeError):
            validate_toml('a = bareword')

    def test_sql_resolves_columns_and_rejects_invalid_queries(self) -> None:
        validate_sql('CREATE TEMP TABLE x (n INT); INSERT INTO x VALUES (2); SELECT SUM(n) FROM x;')
        with self.assertRaises(sqlite3.Error):
            validate_sql('CREATE TEMP TABLE x (n INT); SELECT missing FROM x;')

    def test_sql_cannot_attach_files_or_load_extensions(self) -> None:
        with self.assertRaises(sqlite3.Error):
            validate_sql("ATTACH DATABASE ':memory:' AS other;")
        with self.assertRaises(sqlite3.Error):
            validate_sql("SELECT load_extension('example');")
        with self.assertRaises(sqlite3.Error):
            validate_sql('PRAGMA journal_mode = WAL;')

    def test_make_parses_without_running_recipe(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / 'must-not-exist'
            path = root / 'Makefile'
            content = f'all:\n\ttouch {marker}\n'
            _ = path.write_text(content)
            validate_make(path, content)
            self.assertFalse(marker.exists())
            _ = path.write_text('not a valid makefile\n')
            with self.assertRaises(ValueError):
                validate_make(path, path.read_text())

    def test_make_rejects_parse_time_execution(self) -> None:
        for content in ['X := $(shell touch unsafe)', 'include foreign.mk',
                        'sinclude foreign.mk', '-include foreign.mk', '${DYNAMIC}:']:
            with self.subTest(content=content), self.assertRaises(ValueError):
                validate_make(Path('/nonexistent'), content)


if __name__ == '__main__':
    _ = unittest.main()
