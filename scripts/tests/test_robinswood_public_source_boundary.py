from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from typing import override

SCRIPT = Path(__file__).resolve().parents[1] / "robinswood_public_source_boundary.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    import robinswood_public_source_boundary as GUARD
finally:
    _ = sys.path.pop(0)


class PublicSourceBoundaryTests(unittest.TestCase):
    temp: tempfile.TemporaryDirectory[str] | None = None

    @property
    def root(self) -> Path:
        if self.temp is None:
            raise RuntimeError("Fixture is not set up")
        return Path(self.temp.name)

    @override
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="robb-public-boundary-")
        self.addCleanup(self.temp.cleanup)

    def file(self, relative: str, text: str) -> str:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        _ = path.write_text(text)
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
    _ = unittest.main()
