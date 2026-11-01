"""Wrapper contract tests include a real uv interpreter-selection smoke test."""
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from ._tool_test_harness import parse_json_array, resolve_uv_binary, resolve_wrapper

RESOURCES = Path(__file__).resolve().parents[2]
WRAPPER = RESOURCES / 'bin' / '_python-tool'
WINDOWS_WRAPPER = RESOURCES / 'bin' / '_python-tool.cmd'
MARKITDOWN = RESOURCES / 'scripts' / 'markitdown_cli.py'


def minimum_python(script: Path) -> tuple[int, int]:
    match = re.search(r"^# requires-python = [\"']>=([0-9]+)\.([0-9]+)", script.read_text(), re.MULTILINE)
    if match is None:
        raise AssertionError(f'No simple minimum Python version found in {script}')
    return int(match.group(1)), int(match.group(2))


class PythonWrapperTests(unittest.TestCase):
    def test_wrappers_select_python_compatible_with_document_tool(self):
        required = minimum_python(MARKITDOWN)
        for wrapper in (WRAPPER, WINDOWS_WRAPPER):
            match = re.search(r'run --python ([0-9]+)\.([0-9]+)', wrapper.read_text())
            if match is None:
                self.fail(f'No Python runtime selection found in {wrapper}')
            selected = (int(match.group(1)), int(match.group(2)))
            self.assertGreaterEqual(selected, required, f'{wrapper} selects {selected}, requires {required}')

    def test_real_uv_launcher_runs_a_compatible_interpreter_without_warning(self):
        required = minimum_python(MARKITDOWN)
        uv_binary = resolve_uv_binary()
        wrapper = resolve_wrapper('_python-tool')
        with tempfile.TemporaryDirectory(prefix='robb-wrapper-runtime ') as directory:
            root = Path(directory)
            probe = root / 'version_probe.py'
            requirement = f'>={required[0]}.{required[1]}'
            probe_text = '\n'.join([
                '# /// script',
                f'# requires-python = \"{requirement}\"',
                '# dependencies = []',
                '# ///',
                'import json',
                'import sys',
                'print(json.dumps(list(sys.version_info[:3])))',
                '',
            ])
            _ = probe.write_text(probe_text)
            env = dict(os.environ)
            python_bin = str(Path(sys.executable).parent)
            env['PATH'] = os.pathsep.join([python_bin, str(uv_binary.parent), env.get('PATH', '')])
            env.update({
                'CRAFT_UV': str(uv_binary),
                'CRAFT_SCRIPTS': str(root),
                'UV_PYTHON_DOWNLOADS': 'never',
                'UV_OFFLINE': '1',
                'UV_CACHE_DIR': str(root / 'uv-cache'),
            })
            _ = env.pop('CRAFT_TOOL_SCRIPT', None)
            if os.name == 'nt':
                env['CRAFT_TOOL_SCRIPT'] = probe.name
                command = [str(wrapper)]
            else:
                command = [str(wrapper), probe.name]
            result = subprocess.run(
                command, env=env, capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('incompatible', result.stderr.lower(), result.stderr)
            parts = parse_json_array(result.stdout)
            if len(parts) != 3:
                self.fail(f'Expected three version components, received {parts}')
            major, minor, patch = parts
            if not isinstance(major, int) or isinstance(major, bool):
                self.fail(f'Expected integer version components, received {parts}')
            if not isinstance(minor, int) or isinstance(minor, bool):
                self.fail(f'Expected integer version components, received {parts}')
            if not isinstance(patch, int) or isinstance(patch, bool):
                self.fail(f'Expected integer version components, received {parts}')
            version = (major, minor, patch)
            self.assertGreaterEqual(version[:2], required, f'uv selected Python {version}, requires {required}')

    def test_bare_command_path_with_spaces_and_missing_runtime(self):
        with tempfile.TemporaryDirectory(prefix='robb wrapper ') as directory:
            root = Path(directory)
            uv = root / 'test-uv'
            _ = uv.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            uv.chmod(0o755)
            _ = (root / 'sample.py').write_text('# fixture\n')
            env = dict(os.environ, CRAFT_UV='test-uv', CRAFT_SCRIPTS=str(root), PATH=str(root)+os.pathsep+os.environ['PATH'])
            result = subprocess.run([str(WRAPPER), 'sample.py', 'argument with spaces'], env=env, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines(), ['run', '--python', '3.15', str(root / 'sample.py'), 'argument with spaces'])
            env['CRAFT_UV'] = str(uv)
            self.assertEqual(subprocess.run([str(WRAPPER), 'sample.py'], env=env, capture_output=True, check=False).returncode, 0)
            env['CRAFT_UV'] = 'missing-robb-runtime'
            result = subprocess.run([str(WRAPPER), 'sample.py'], env=env, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 127)
            self.assertIn('runtime not found', result.stderr)


if __name__ == '__main__':
    _ = unittest.main()
