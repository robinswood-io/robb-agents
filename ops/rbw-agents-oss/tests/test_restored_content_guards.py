"""Actual greeting and PDF guards exercised entirely with QA data."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import contact_salutation as salutation
import evergreen_offline_test_guard as offline
import outbound_content_guard as content
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


def write_pdf(path: Path, text: str | None) -> None:
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=200)
    if text is not None:
        font = DictionaryObject()
        font[NameObject("/Type")] = NameObject("/Font")
        font[NameObject("/Subtype")] = NameObject("/Type1")
        font[NameObject("/BaseFont")] = NameObject("/Helvetica")
        fonts = DictionaryObject()
        fonts[NameObject("/F1")] = font
        resources = DictionaryObject()
        resources[NameObject("/Font")] = fonts
        page[NameObject("/Resources")] = resources
        stream = DecodedStreamObject()
        stream.set_data(("BT /F1 12 Tf 10 100 Td (" + text + ") Tj ET").encode("ascii"))
        page[NameObject("/Contents")] = stream
    writer.add_metadata({"/QA": "fixture " * 3000})
    with path.open("wb") as output:
        _ = writer.write(output)
    writer.close()

class ContentGuardTests(unittest.TestCase):
    def test_names_and_roles_never_infer_civility(self) -> None:
        for first, role in [("Alice", "Directrice"), ("Pierre", "CEO"), ("Alex", "Président")]:
            result = content.safe_salutation({"first_name": first, "last_name": "QA", "role": role})
            self.assertEqual(result["salutation"], "Bonjour,")
            self.assertEqual(result["mode"], "neutral-generic")
            self.assertIsNone(result["civility"])
            self.assertIsNone(result["civilitySource"])
            self.assertIs(result["inferenceUsed"], False)

    def test_explicit_civility_is_preserved_and_guessed_source_is_refused(self) -> None:
        contact = {"first_name": "Alex", "last_name": "QA", "civility": "Madame", "civility_source": "official_source"}
        self.assertEqual(content.safe_salutation(contact)["salutation"], "Bonjour Madame QA,")
        contact["civility_source"] = "name_guess"
        self.assertEqual(content.safe_salutation(contact)["salutation"], "Bonjour,")
        self.assertIn("unverified_gendered_civility_forbidden", content.salutation_reasons("Bonjour Madame QA,", contact))

    def test_body_replacement_and_mutable_contact_metadata_remain_consistent(self) -> None:
        contact: salutation.JsonObject = {"first_name": "Alex", "last_name": "QA"}
        result = salutation.apply_formal_salutation(contact)
        self.assertEqual(contact["salutation"], "Bonjour,")
        self.assertEqual(result["salutationMode"], "neutral-generic")
        self.assertEqual(salutation.apply_salutation_to_body("Bonjour Monsieur QA,\n\nQA body", contact), "Bonjour,\n\nQA body")
        self.assertEqual(content.safe_salutation({"first_name": "Alex"})["salutation"], "Bonjour,")

    def test_existing_attachment_and_delivery_challenge_selfchecks_pass(self) -> None:
        self.assertIs(content.selftest()["ok"], True)
        self.assertIs(salutation.selftest()["ok"], True)
        self.assertIn("body_mentions_attachment_but_exactly_one_not_expected", content.attachment_semantic_reasons("Document attached.", 0))

    def test_real_readable_branded_pdf_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "qa.pdf"
            write_pdf(path, "Robinswood QA report")
            result = content.pdf_attachment_quality(path)
            self.assertIs(result["ok"], True)
            self.assertGreater(result["textChars"], 0)
            self.assertEqual(result["reasons"], [])

    def test_real_blank_or_unbranded_pdf_cannot_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "qa.pdf"
            for text, reason in [(None, "pdf_attachment_text_unreadable"), ("QA unrelated brand", "pdf_attachment_text_missing_robinswood")]:
                with self.subTest(text=text):
                    write_pdf(path, text)
                    result = content.pdf_attachment_quality(path)
                    self.assertIs(result["ok"], False)
                    self.assertIn(reason, result["reasons"])

    def test_missing_pdf_is_rejected_without_optional_parser_fallbacks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = content.pdf_attachment_quality(Path(directory) / "missing.pdf")
            self.assertIs(result["ok"], False)
            self.assertIn("pdf_attachment_file_missing", result["reasons"])


def tearDownModule() -> None:
    offline.assert_no_external_attempts()
