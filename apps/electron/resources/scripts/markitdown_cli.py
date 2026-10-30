# /// script
# requires-python = ">=3.15"
# dependencies = ["python-docx==1.2.0", "openpyxl==3.1.5", "python-pptx==1.0.2", "pypdf==6.21.4", "Pillow==13.0.0", "click==8.5.0"]
# ///
"""Compatibility CLI for Robb's local document-to-text converter."""

from pathlib import Path

import click
from document_text import CONVERSION_ERRORS, convert_document


@click.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("-o", "--output", type=click.Path(), default=None, help="Write output to file.")
def main(file: str, output: str | None) -> None:
    """Extract text from Office, PDF, text, notebook, email or ZIP documents.

    Images provide metadata only. Scanned PDFs require OCR before conversion.
    """
    try:
        text = convert_document(Path(file))
    except CONVERSION_ERRORS as error:
        raise click.ClickException(f"Error converting {Path(file).name}: {error}") from error
    if output:
        _ = Path(output).write_text(text, encoding="utf-8")
        click.echo(f"Output written to {output}", err=True)
    else:
        click.echo(text)


if __name__ == "__main__":
    main()
