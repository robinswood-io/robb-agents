from pypdf.errors import PyPdfError

"""Native PDF commands, registered on the shared Click group."""

from numbers import Real
from typing import cast

from pdf_common import (
    PdfReader,
    PdfWriter,
    RectangleObject,
    _pil_to_image_pdf_page,
    _render_page_to_pil,
    check_output_differs,
    cli,
    click,
    io,
    pdfium,
    sys,
    write_pdf,
)


def _page_dimensions(page: object) -> tuple[float, float]:
    box = getattr(page, "mediabox", None)
    if not isinstance(box, RectangleObject):
        raise TypeError("PDF page has no readable media box")
    coordinates = cast(tuple[object, ...], tuple(box))
    if len(coordinates) != 4 or not all(isinstance(value, Real) for value in coordinates):
        raise ValueError("PDF media box must contain four numeric coordinates")
    numeric = cast(tuple[Real, ...], coordinates)
    return float(numeric[2]) - float(numeric[0]), float(numeric[3]) - float(numeric[1])



_PDF_OPERATION_ERRORS = (OSError, ValueError, TypeError, RuntimeError, KeyError, IndexError, PyPdfError)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--password", type=str, required=True, help="Password to set.")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def encrypt(file: str, password: str, output: str) -> None:
    """Password-protect a PDF with encryption."""
    check_output_differs(file, output)
    try:
        reader = PdfReader(file)
        writer = PdfWriter()
        writer.append(reader)
        writer.encrypt(user_password=password, owner_password=password)
        write_pdf(writer, output)
    except _PDF_OPERATION_ERRORS as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--password", type=str, required=True, help="Password to unlock the PDF.")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def decrypt(file: str, password: str, output: str) -> None:
    """Remove password protection from an encrypted PDF."""
    check_output_differs(file, output)
    try:
        reader = PdfReader(file, password=password)
        if reader.is_encrypted:
            _ = reader.decrypt(password)
        writer = PdfWriter()
        writer.append(reader)
        write_pdf(writer, output)
        click.echo(f"Decrypted PDF written to {output}", err=True)
    except _PDF_OPERATION_ERRORS as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--text", "texts", type=str, multiple=True, help="Text to redact (can specify multiple).")
@click.option("--area", "areas", type=str, multiple=True, help="Area to redact as 'page:x1,y1,x2,y2' (1-based page, points).")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def redact(file: str, texts: tuple[str, ...], areas: tuple[str, ...], output: str) -> None:
    """Permanently redact text or areas from a PDF.

    Redact by text:  --text "confidential" --text "SSN: 123-45-6789"
    Redact by area:  --area "1:100,200,300,250"  (page 1, rectangle in points)

    Redacted pages are re-rendered as images, destroying the original content.
    This is a true redaction — original text is irrecoverably removed.
    """
    check_output_differs(file, output)
    if not texts and not areas:
        click.echo("Error: provide --text and/or --area to redact.", err=True)
        sys.exit(1)
    try:
        from PIL import ImageDraw

        pdf = pdfium.PdfDocument(file)
        total = len(pdf)

        # Build a map of page_index -> list of redaction rectangles (in points)
        page_redactions: dict[int, list[tuple[float, float, float, float]]] = {}

        # Text-based redactions: search each page
        for search_text in texts:
            for idx in range(total):
                page = pdf[idx]
                textpage = page.get_textpage()
                searcher = textpage.search(search_text)
                match = searcher.get_next()
                while match:
                    char_idx, char_count = match
                    # Build bounding rect from per-character boxes
                    left = float("inf")
                    bottom = float("inf")
                    right = float("-inf")
                    top = float("-inf")
                    for ci in range(char_count):
                        box = textpage.get_charbox(char_idx + ci)
                        left = min(left, box[0])
                        bottom = min(bottom, box[1])
                        right = max(right, box[2])
                        top = max(top, box[3])
                    page_redactions.setdefault(idx, []).append((left, bottom, right, top))
                    match = searcher.get_next()

        # Area-based redactions
        for area_spec in areas:
            try:
                page_str, coords_str = area_spec.split(":", 1)
                page_num = int(page_str) - 1
                coords = [float(c.strip()) for c in coords_str.split(",")]
                if len(coords) != 4:
                    raise ValueError("Need 4 coordinates")
                if page_num < 0 or page_num >= total:
                    raise ValueError(f"Page {page_num + 1} out of range")
                page_redactions.setdefault(page_num, []).append((coords[0], coords[1], coords[2], coords[3]))
            except (ValueError, IndexError) as e:
                click.echo(f"Error: invalid area spec '{area_spec}': {e}", err=True)
                sys.exit(1)

        # Re-render affected pages with black rectangles over redacted areas
        reader = PdfReader(file)
        writer = PdfWriter()

        for idx in range(total):
            if idx in page_redactions:
                page = pdf[idx]
                w_pt, h_pt = page.get_size()
                dpi = 300
                scale = dpi / 72

                img = _render_page_to_pil(page, dpi=dpi)

                from PIL import Image

                if not isinstance(img, Image.Image):
                    raise TypeError("PDF renderer did not return a Pillow image")
                draw = ImageDraw.Draw(img)
                for rect in page_redactions[idx]:
                    # Convert PDF points to pixel coords
                    # PDF coords: (left, bottom, right, top) with origin at bottom-left
                    # PIL coords: origin at top-left
                    left = rect[0] * scale
                    bottom = rect[1] * scale
                    right = rect[2] * scale
                    top = rect[3] * scale
                    # Flip Y: PIL y = (page_height_px - pdf_y)
                    h_px = h_pt * scale
                    pil_top = h_px - top
                    pil_bottom = h_px - bottom
                    draw.rectangle([left, pil_top, right, pil_bottom], fill="black")

                # Create image PDF page
                img_pdf_bytes = _pil_to_image_pdf_page(img)
                img_reader = PdfReader(io.BytesIO(img_pdf_bytes))
                img_page = img_reader.pages[0]

                # Scale to original page dimensions
                img_w, img_h = _page_dimensions(img_page)
                if img_w > 0 and img_h > 0:
                    img_page.scale(w_pt / img_w, h_pt / img_h)
                    img_page.mediabox = RectangleObject([0, 0, w_pt, h_pt])

                _ = writer.add_page(img_page)
            else:
                # Pass through unmodified pages
                _ = writer.add_page(reader.pages[idx])

        write_pdf(writer, output)
        click.echo(f"Redacted PDF written to {output}", err=True)
    except SystemExit:
        raise
    except _PDF_OPERATION_ERRORS as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def sanitize(file: str, output: str) -> None:
    """Clear metadata and perform PDF cleanup.

    This command:
    - clears standard document metadata fields
    - saves with content stream compression

    Note: it does not guarantee removal of every possible active-content pattern
    across all PDFs.
    """
    check_output_differs(file, output)
    try:
        reader = PdfReader(file)
        writer = PdfWriter()
        writer.append(reader)

        # Clear all standard metadata
        writer.add_metadata({
            "/Title": "",
            "/Author": "",
            "/Subject": "",
            "/Keywords": "",
            "/Creator": "",
            "/Producer": "",
        })

        # Remove XMP metadata if present
        root = getattr(writer, "_root_object", None)
        if not isinstance(root, dict):
            raise TypeError("PDF writer has no readable document root")
        if "/Metadata" in root:
            del root["/Metadata"]

        # Compress content streams
        for page in writer.pages:
            page.compress_content_streams()

        write_pdf(writer, output)
        click.echo(f"Sanitized PDF written to {output}", err=True)
    except _PDF_OPERATION_ERRORS as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
