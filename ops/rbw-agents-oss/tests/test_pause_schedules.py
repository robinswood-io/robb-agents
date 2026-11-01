import unittest

from pause_schedules import schedule_ids


class ScheduleManifestTests(unittest.TestCase):
    def test_reads_schedule_identifiers(self) -> None:
        self.assertEqual(
            schedule_ids('{"schedules":[{"schedule_id":"one"},{"schedule_id":"two"}]}'),
            ["one", "two"],
        )

    def test_rejects_non_object_manifest(self) -> None:
        with self.assertRaisesRegex(TypeError, "JSON object"):
            _ = schedule_ids("[]")

    def test_rejects_non_string_identifier(self) -> None:
        with self.assertRaisesRegex(TypeError, "string schedule_id"):
            _ = schedule_ids('{"schedules":[{"schedule_id":4}]}')
