"""Native PDF commands, registered on the shared Click group."""

from pdf_common import (
    io,
    json,
    math,
    sys,
    zlib,
    Path,
    click,
    pdfium,
    PdfReader,
    PdfWriter,
    BooleanObject,
    NameObject,
    RectangleObject,
    PAGE_SIZES,
    write_output,
    write_pdf,
    parse_page_range,
    check_output_differs,
    parse_color,
    _render_page_to_pil,
    _make_watermark_pdf,
    _pdf_escape,
    _make_text_overlay_pdf,
    _pil_to_image_pdf_page,
    cli,
)


@cli.command("to-image")
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--format", "fmt", type=click.Choice(["png", "jpg"]), default="png", help="Image format (default: png).")
@click.option("--dpi", type=int, default=150, help="Resolution in DPI (default: 150).")
@click.option("--pages", type=str, default=None, help="Page range to convert (default: all).")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output directory.")
def to_image(file: str, fmt: str, dpi: int, pages: str | None, output: str) -> None:
    """Convert PDF pages to images (PNG or JPG)."""
    try:
        pdf = pdfium.PdfDocument(file)
        total = len(pdf)
        indices = parse_page_range(pages, total) if pages else list(range(total))
        out_dir = Path(output)
        out_dir.mkdir(parents=True, exist_ok=True)

        for idx in indices:
            page = pdf[idx]
            img = _render_page_to_pil(page, dpi=dpi)
            ext = "jpg" if fmt == "jpg" else "png"
            out_path = out_dir / f"page_{idx + 1}.{ext}"
            if fmt == "jpg":
                img.save(str(out_path), "JPEG", quality=85)
            else:
                img.save(str(out_path), "PNG")
            click.echo(f"Saved {out_path}", err=True)

        click.echo(f"Converted {len(indices)} pages to {fmt.upper()} in {output}", err=True)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command("from-image")
@click.argument("files", nargs=-1, required=True, type=click.Path(exists=True, dir_okay=False))
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def from_image(files: tuple[str, ...], output: str) -> None:
    """Convert images to a PDF document.

    Each image becomes one page. Supports PNG, JPG, BMP, GIF, TIFF, WebP.
    """
    try:
        import img2pdf

        img_data = []
        for img_path in files:
            img_data.append(Path(img_path).read_bytes())

        pdf_bytes = img2pdf.convert(img_data)
        Path(output).write_bytes(pdf_bytes)
        click.echo(f"PDF written to {output} ({len(files)} pages from images)", err=True)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command("to-docx")
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--pages", type=str, default=None, help="Page range to convert (default: all).")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output DOCX file path.")
def to_docx(file: str, pages: str | None, output: str) -> None:
    """Convert PDF to Word document (text extraction based)."""
    from docx import Document as DocxDocument

    try:
        pdf = pdfium.PdfDocument(file)
        total = len(pdf)
        indices = parse_page_range(pages, total) if pages else list(range(total))

        docx_doc = DocxDocument()
        for i, idx in enumerate(indices):
            page = pdf[idx]
            textpage = page.get_textpage()
            text = textpage.get_text_bounded()
            for line in text.splitlines():
                if line.strip():
                    docx_doc.add_paragraph(line.strip())
            if i < len(indices) - 1:
                docx_doc.add_page_break()

        docx_doc.save(output)
        click.echo(f"DOCX written to {output}", err=True)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command("to-pptx")
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--dpi", type=int, default=200, help="Image resolution for slides (default: 200).")
@click.option("--pages", type=str, default=None, help="Page range to convert (default: all).")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PPTX file path.")
def to_pptx(file: str, dpi: int, pages: str | None, output: str) -> None:
    """Convert PDF pages to PowerPoint slides (image-based)."""
    from pptx import Presentation
    from pptx.util import Emu

    try:
        pdf = pdfium.PdfDocument(file)
        total = len(pdf)
        indices = parse_page_range(pages, total) if pages else list(range(total))

        if not indices:
            click.echo("Error: no pages selected for conversion.", err=True)
            sys.exit(1)

        prs = Presentation()

        # Set slide size to match first page aspect ratio (points -> EMU: 1pt = 12700 EMU)
        first_page = pdf[indices[0]]
        first_w, first_h = first_page.get_size()
        prs.slide_width = Emu(int(first_w * 12700))
        prs.slide_height = Emu(int(first_h * 12700))
        blank_layout = prs.slide_layouts[6]  # blank slide

        for idx in indices:
            page = pdf[idx]
            img = _render_page_to_pil(page, dpi=dpi)

            img_buffer = io.BytesIO()
            img.save(img_buffer, format="PNG")
            img_buffer.seek(0)

            slide = prs.slides.add_slide(blank_layout)
            slide.shapes.add_picture(
                img_buffer, 0, 0,
                prs.slide_width, prs.slide_height,
            )

        prs.save(output)
        click.echo(f"PPTX written to {output} ({len(indices)} slides)", err=True)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
