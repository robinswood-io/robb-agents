"""Wrapper contract tests use a fake uv process and never touch a user profile."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

WRAPPER = Path(__file__).resolve().parents[2] / 'bin' / '_python-tool'

class PythonWrapperTests(unittest.TestCase):
    def test_bare_command_path_with_spaces_and_missing_runtime(self):
        with tempfile.TemporaryDirectory(prefix='robb wrapper ') as directory:
            root = Path(directory)
            uv = root / 'test-uv'
            uv.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            uv.chmod(0o755)
            (root / 'sample.py').write_text('# fixture\n')
            env = dict(os.environ, CRAFT_UV='test-uv', CRAFT_SCRIPTS=str(root), PATH=str(root)+os.pathsep+os.environ['PATH'])
            result = subprocess.run([str(WRAPPER), 'sample.py', 'argument with spaces'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines(), ['run', '--python', '3.12', str(root / 'sample.py'), 'argument with spaces'])
            env['CRAFT_UV'] = str(uv)
            self.assertEqual(subprocess.run([str(WRAPPER), 'sample.py'], env=env, capture_output=True).returncode, 0)
            env['CRAFT_UV'] = 'missing-robb-runtime'
            result = subprocess.run([str(WRAPPER), 'sample.py'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 127)
            self.assertIn('runtime not found', result.stderr)

if __name__ == '__main__':
    unittest.main()
