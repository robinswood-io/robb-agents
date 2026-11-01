from __future__ import annotations

import unittest

from pydantic import ValidationError
from rbw_agent_runtime.json_support import _is_json_array, _is_json_object
from rbw_agent_runtime.models import ExecutionBackend, ExecutionSpec


class JsonContractTests(unittest.TestCase):
    def test_json_shape_guards_accept_only_matching_shapes(self) -> None:
        self.assertTrue(_is_json_object({"count": 3}))
        self.assertFalse(_is_json_object(["value"]))
        self.assertTrue(_is_json_array(["value", None]))
        self.assertFalse(_is_json_array({"value": 1}))

    def test_execution_spec_accepts_argv_backend(self) -> None:
        spec = ExecutionSpec(backend=ExecutionBackend.ARGV, argv=["/usr/bin/true"])
        self.assertEqual(spec.argv, ["/usr/bin/true"])
        self.assertEqual(spec.backend, ExecutionBackend.ARGV)

    def test_execution_spec_rejects_protected_environment(self) -> None:
        with self.assertRaises(ValidationError):
            _ = ExecutionSpec(
                backend=ExecutionBackend.ARGV,
                argv=["/usr/bin/true"],
                env={"RBW_EVENT_JSON": "{}"},
            )

    def test_execution_spec_rejects_relative_executable(self) -> None:
        with self.assertRaises(ValidationError):
            _ = ExecutionSpec(backend=ExecutionBackend.ARGV, argv=["true"])


if __name__ == "__main__":
    _ = unittest.main()
