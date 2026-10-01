from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "robinswood-public-source-boundary.py"
SPEC = importlib.util.spec_from_file_location("public_source_boundary", SCRIPT)
assert SPEC and SPEC.loader
GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)


class PublicSourceBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="robb-public-boundary-")
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def file(self, relative: str, text: str) -> str:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return relative

    def test_rejects_retired_implementation_even_when_empty(self) -> None:
        path = self.file("packages/shared/src/config/routing-policy.ts", "")
        self.assertEqual(len(GUARD.violations(self.root, [path])), 1)

    def test_rejects_retired_task_and_subquery_selectors(self) -> None:
        for relative in (
            "packages/server-core/src/tasks/task-node-routing.ts",
            "packages/server-core/src/missions/mission-routing-ground-truth.ts",
            "packages/pi-agent-server/src/query-llm-model-policy.ts",
            "packages/pi-agent-server/src/pick-mini-model.ts",
        ):
            with self.subTest(relative=relative):
                path = self.file(relative, "")
                self.assertEqual(len(GUARD.violations(self.root, [path])), 1)

    def test_rejects_renamed_implementation_and_import(self) -> None:
        path = self.file("packages/example/src/new-name.ts", "export function decideAgentCostControl() {}")
        self.assertEqual(len(GUARD.violations(self.root, [path])), 1)

    def test_rejects_disabled_or_dormant_implementation(self) -> None:
        path = self.file("apps/example/src/model.ts", "if (false) resolveRoutingPolicy(config)")
        self.assertEqual(len(GUARD.violations(self.root, [path])), 1)

    def test_rejects_ops_activation_in_a_registry(self) -> None:
        path = self.file("ops/example/registry.json", '{"id":"provider-routing-guard"}')
        self.assertEqual(len(GUARD.violations(self.root, [path])), 1)

    def test_allows_manual_selection_transport_and_historical_cost_metadata(self) -> None:
        path = self.file("packages/example/src/manual.ts", "const model = request.model ?? session.model; const cost = message.routingMeta?.actualCostUsd; routeTransport(message)")
        self.assertEqual(GUARD.violations(self.root, [path]), [])

    def test_allows_legacy_config_compatibility_fixtures(self) -> None:
        path = self.file("packages/example/src/manual.test.ts", "expect(legacy.routingPolicy).toBeUndefined()")
        self.assertEqual(GUARD.violations(self.root, [path]), [])

    def test_ignores_deleted_tracked_paths(self) -> None:
        self.assertEqual(GUARD.violations(self.root, ["packages/shared/src/config/routing-policy.ts"]), [])


if __name__ == "__main__":
    unittest.main()
