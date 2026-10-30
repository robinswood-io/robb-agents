"""Exercise the shipped wrappers on synthetic documents, including failure paths."""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from functools import cached_property
from pathlib import Path
from zipfile import ZipFile

from ._tool_test_harness import build_env, run_tool


def pdf_fixture(text: str) -> bytes:
    stream = f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] "
        + b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream",
    ]
    result = b"%PDF-1.4\n"
    offsets: list[int] = []
    for index, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(result)
    result += b"xref\n0 6\n0000000000 65535 f \n"
    result += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    result += f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return result


class DocumentConversionTests(unittest.TestCase):
    @cached_property
    def directory(self) -> Path:
        return Path(self.enterContext(tempfile.TemporaryDirectory(prefix="robb document QA ")))

    @cached_property
    def environment(self) -> dict[str, str]:
        return build_env()

    def tool(self, command: str, *args: str) -> subprocess.CompletedProcess[str]:
        return run_tool(command, *args, env=self.environment)

    def converted(self, path: Path) -> str:
        result = self.tool("markitdown", str(path))
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_docx_create_convert_compare_and_save(self) -> None:
        paths = [self.directory / name for name in ("before.docx", "after.docx")]
        for path, text in zip(paths, ("Montant 100 EUR", "Montant 120 EUR"), strict=True):
            result = self.tool("docx-tool", "create", "--text", text, "-o", str(path))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(text, self.converted(path))
        report = self.directory / "report.md"
        result = self.tool("doc-diff", *(str(path) for path in paths), "-o", str(report))
        self.assertEqual(result.returncode, 0, result.stderr)
        content = report.read_text()
        self.assertIn("-Montant 100 EUR", content)
        self.assertIn("+Montant 120 EUR", content)

    def test_spreadsheet_and_presentation(self) -> None:
        book = self.directory / "table.xlsx"
        created = self.tool("xlsx-tool", "write", str(book), "--cell", "A1", "--value", "Client QA")
        self.assertEqual(created.returncode, 0, created.stderr)
        self.assertIn("Client QA", self.converted(book))
        deck = self.directory / "slides.pptx"
        created = self.tool("pptx-tool", "create", "--title", "Mission QA", "--text", "# Resultat\nTermine", "-o", str(deck))
        self.assertEqual(created.returncode, 0, created.stderr)
        self.assertIn("Termine", self.converted(deck))

    def test_pdf_conversion_and_comparison(self) -> None:
        before, after = (self.directory / name for name in ("before.pdf", "after.pdf"))
        _ = before.write_bytes(pdf_fixture("Balance 100"))
        _ = after.write_bytes(pdf_fixture("Balance 120"))
        self.assertIn("Balance 100", self.converted(before))
        result = self.tool("doc-diff", str(before), str(after))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("-Balance 100", result.stdout)
        self.assertIn("+Balance 120", result.stdout)

    def test_text_output_and_identical_comparison(self) -> None:
        source, output = self.directory / "rapport.txt", self.directory / "rapport.md"
        text = "Compte client : été 2026\nMontant : 42 €"
        _ = source.write_text(text)
        result = self.tool("markitdown", str(source), "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output.read_text(), text)
        result = self.tool("doc-diff", str(source), str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("identical", result.stdout)

    def test_notebook_email_and_archive(self) -> None:
        notebook = self.directory / "notes.ipynb"
        _ = notebook.write_text(json.dumps({"cells": [{"cell_type": "markdown", "source": ["Rapport QA"]}]}))
        self.assertIn("Rapport QA", self.converted(notebook))
        email = self.directory / "mail.eml"
        _ = email.write_text("Subject: Mission QA\nContent-Type: text/plain; charset=utf-8\n\nRapport termine")
        self.assertIn("Rapport termine", self.converted(email))
        archive = self.directory / "documents.zip"
        with ZipFile(archive, "w") as zipped:
            zipped.writestr(f"../{self.directory.name}-outside.txt", "Archive QA")
            zipped.write(notebook, "notes.ipynb")
        text = self.converted(archive)
        self.assertIn("Archive QA", text)
        self.assertIn("Rapport QA", text)
        self.assertFalse((self.directory.parent / f"{self.directory.name}-outside.txt").exists())

    def test_summary_and_side_by_side_keep_change_details(self) -> None:
        before, after = self.directory / "before.txt", self.directory / "after.txt"
        _ = before.write_text("alpha old omega")
        _ = after.write_text("alpha new omega")
        result = self.tool("doc-diff", str(before), str(after), "--format", "summary", "--word-level")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Insertions: 1 (3 characters)", result.stdout)
        self.assertIn("Deletions:  1 (3 characters)", result.stdout)
        self.assertIn("alpha [-old-]{+new+} omega", result.stdout)
        result = self.tool("doc-diff", str(before), str(after), "--format", "side-by-side")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("alpha old omega", result.stdout)
        self.assertIn("alpha new omega", result.stdout)

    def test_archive_entry_limit_is_enforced(self) -> None:
        archive = self.directory / "oversized.zip"
        with ZipFile(archive, "w") as zipped:
            for index in range(1001):
                zipped.writestr(f"{index}.txt", "QA")
        result = self.tool("markitdown", str(archive))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("size limits", result.stderr)

    def test_invalid_documents_fail_without_creating_output(self) -> None:
        for extension in (".pdf", ".docx", ".xlsx", ".pptx", ".ipynb", ".zip", ".unsupported"):
            with self.subTest(extension=extension):
                source = self.directory / f"invalid{extension}"
                _ = source.write_bytes(b"not a document")
                output = self.directory / "should-not-exist.md"
                result = self.tool("markitdown", str(source), "-o", str(output))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Error", result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                self.assertFalse(output.exists())

    def test_invalid_notebook_shape_and_empty_pdf_fail(self) -> None:
        for content in ("[]", '{"cells": [false]}', '{"cells": [{"source": 7}]}'):
            source = self.directory / "invalid.ipynb"
            _ = source.write_text(content)
            result = self.tool("markitdown", str(source))
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("Traceback", result.stderr)
        source = self.directory / "empty.pdf"
        _ = source.write_bytes(pdf_fixture(""))
        result = self.tool("markitdown", str(source))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OCR", result.stderr)

    def test_conversion_failure_does_not_make_a_comparison_report(self) -> None:
        before, after = self.directory / "before.txt", self.directory / "after.pdf"
        _ = before.write_text("valid")
        _ = after.write_text("invalid PDF")
        report = self.directory / "report.md"
        result = self.tool("doc-diff", str(before), str(after), "-o", str(report))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(report.exists())
        self.assertNotIn("identical", result.stdout)


if __name__ == "__main__":
    _ = unittest.main()
