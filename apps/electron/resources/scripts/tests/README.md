# Document Tool Smoke Tests

This folder contains smoke tests for bundled CLI tools under `apps/electron/resources/scripts/`.

## Run all tool smoke tests

From repo root:

```bash
python3 -m unittest \
  apps.electron.resources.scripts.tests.test_pdf_tool_smoke \
  apps.electron.resources.scripts.tests.test_xlsx_tool_smoke \
  apps.electron.resources.scripts.tests.test_docx_tool_smoke \
  apps.electron.resources.scripts.tests.test_pptx_tool_smoke \
  apps.electron.resources.scripts.tests.test_img_tool_smoke \
  apps.electron.resources.scripts.tests.test_ical_tool_smoke \
  apps.electron.resources.scripts.tests.test_doc_diff_smoke \
  apps.electron.resources.scripts.tests.test_markitdown_smoke
```

Or use the root script:

```bash
bun run test:doc-tools
```

## Run a single suite

```bash
python3 -m unittest apps.electron.resources.scripts.tests.test_xlsx_tool_smoke
```

## Notes

- Tests execute the **wrapper binaries** in `resources/bin/*` (not scripts directly).
- The shared harness configures `CRAFT_UV`, `CRAFT_SCRIPTS`, and `PATH`.
- If bundled `uv` is missing for your platform, harness falls back to `uv` on PATH.
- Tests create temporary fixtures at runtime and clean them up automatically.

## Contributor expectation

If you modify any script in `apps/electron/resources/scripts/` or wrapper in `apps/electron/resources/bin/`, update/add relevant smoke tests in this folder.

## Python 3.15 document conversion

`markitdown` remains the existing CLI name; the Microsoft MarkItDown dependency
has been replaced by the bundled `document_text.py` extractor. Conversion and
`doc-diff` use the same extraction. Word, Excel, PowerPoint and PDF reuse the
existing libraries; comparisons use Python's standard `difflib`.

Run `bun run test:doc-tools` with Python 3.15 and uv 0.13.6 on PATH. The suite
creates synthetic documents, converts them through the shipped wrappers,
compares them and reads back saved reports. It also rejects damaged documents,
unsupported formats and textless PDFs without writing a misleading report.
Archive members are read in memory; paths are never extracted to disk.

Supported: DOCX, XLSX, PPTX, text PDFs, UTF-8 text/markup, notebooks, EML, ZIP
with supported members, and image metadata. Legacy DOC/XLS/PPT, Outlook MSG,
RTF, OCR and audio transcription require a separate conversion step. These
formats are not advertised as working through an unavailable optional backend.
