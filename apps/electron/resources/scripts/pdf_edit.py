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


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--text", type=str, required=True, help="Watermark text.")
@click.option("--font-size", type=float, default=48, help="Font size (default: 48).")
@click.option("--opacity", type=float, default=0.3, help="Opacity 0-1 (default: 0.3).")
@click.option("--angle", type=float, default=45, help="Rotation angle in degrees (default: 45).")
@click.option("--color", type=str, default="gray", help="Color name or hex (default: gray).")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def watermark(file: str, text: str, font_size: float, opacity: float, angle: float, color: str, output: str) -> None:
    """Add a text watermark to every page of a PDF."""
    check_output_differs(file, output)

    try:
        reader = PdfReader(file)
        writer = PdfWriter()
        rgb = parse_color(color)

        for page in reader.pages:
            box = page.mediabox
            w = float(box.width)
            h = float(box.height)

            wm_bytes = _make_watermark_pdf(w, h, text, font_size, opacity, angle, rgb)
            wm_reader = PdfReader(io.BytesIO(wm_bytes))
            wm_page = wm_reader.pages[0]

            page.merge_page(wm_page)
            writer.add_page(page)

        write_pdf(writer, output)
        click.echo(f"Watermarked PDF written to {output}", err=True)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command("fill-form")
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--data", type=str, required=True, help="JSON string or path to JSON file with field values.")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def fill_form(file: str, data: str, output: str) -> None:
    """Fill PDF form fields with data from JSON.

    The JSON should map field names to values, e.g. {"name": "John", "date": "2024-01-01"}.
    """
    try:
        # Parse data - either JSON string or file path
        data_path = Path(data)
        if data_path.exists() and data_path.is_file():
            field_data = json.loads(data_path.read_text(encoding="utf-8"))
        else:
            field_data = json.loads(data)

        if not isinstance(field_data, dict):
            click.echo("Error: JSON data must be an object mapping field names to values.", err=True)
            sys.exit(1)

        reader = PdfReader(file)
        writer = PdfWriter()
        writer.append(reader)

        # Fill form fields
        for page_num in range(len(writer.pages)):
            writer.update_page_form_field_values(writer.pages[page_num], field_data)

        # Flatten if possible by setting NeedAppearances
        if "/AcroForm" in writer._root_object:
            writer._root_object["/AcroForm"][NameObject("/NeedAppearances")] = BooleanObject(True)

        write_pdf(writer, output)
    except json.JSONDecodeError as e:
        click.echo(f"Error parsing JSON data: {e}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def compress(file: str, output: str) -> None:
    """Compress a PDF to reduce file size."""
    check_output_differs(file, output)
    try:
        reader = PdfReader(file)
        writer = PdfWriter()
        writer.append(reader)

        for page in writer.pages:
            page.compress_content_streams()

        with open(output, "wb") as f:
            writer.write(f)

        original = Path(file).stat().st_size
        compressed = Path(output).stat().st_size
        ratio = (1 - compressed / original) * 100 if original > 0 else 0
        click.echo(
            f"Compressed: {original:,} -> {compressed:,} bytes ({ratio:.1f}% reduction). Written to {output}",
            err=True,
        )
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--left", type=float, default=0, help="Points to trim from left.")
@click.option("--right", type=float, default=0, help="Points to trim from right.")
@click.option("--top", type=float, default=0, help="Points to trim from top.")
@click.option("--bottom", type=float, default=0, help="Points to trim from bottom.")
@click.option("--pages", type=str, default=None, help="Page range to crop (default: all).")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def crop(file: str, left: float, right: float, top: float, bottom: float, pages: str | None, output: str) -> None:
    """Crop PDF page margins by trimming points from each side."""
    check_output_differs(file, output)
    try:
        reader = PdfReader(file)
        writer = PdfWriter()
        total = len(reader.pages)
        target = set(parse_page_range(pages, total)) if pages else set(range(total))
        for i, page in enumerate(reader.pages):
            if i in target:
                box = page.mediabox
                page.cropbox = RectangleObject([
                    float(box.left) + left,
                    float(box.bottom) + bottom,
                    float(box.right) - right,
                    float(box.top) - top,
                ])
            writer.add_page(page)
        write_pdf(writer, output)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--size", type=click.Choice(list(PAGE_SIZES.keys()), case_sensitive=False), required=True, help="Target page size.")
@click.option("--pages", type=str, default=None, help="Page range to resize (default: all).")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def resize(file: str, size: str, pages: str | None, output: str) -> None:
    """Resize PDF pages to a standard page size (A4, Letter, etc.)."""
    check_output_differs(file, output)
    target_w, target_h = PAGE_SIZES[size.lower()]
    try:
        reader = PdfReader(file)
        writer = PdfWriter()
        total = len(reader.pages)
        target_pages = set(parse_page_range(pages, total)) if pages else set(range(total))
        for i, page in enumerate(reader.pages):
            if i in target_pages:
                current_w = float(page.mediabox.width)
                current_h = float(page.mediabox.height)
                sx = target_w / current_w if current_w else 1
                sy = target_h / current_h if current_h else 1
                page.scale(float(sx), float(sy))
                page.mediabox = RectangleObject([0, 0, target_w, target_h])
            writer.add_page(page)
        write_pdf(writer, output)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def flatten(file: str, output: str) -> None:
    """Flatten PDF forms and annotations into static content.

    Renders each page as a high-DPI image and re-embeds it. This produces a visually
    identical PDF where forms and annotations are baked into the page content.
    """
    check_output_differs(file, output)
    try:
        pdf = pdfium.PdfDocument(file)
        writer = PdfWriter()

        for i in range(len(pdf)):
            page = pdf[i]
            w_pt, h_pt = page.get_size()

            # Render at 300 DPI for high quality
            img = _render_page_to_pil(page, dpi=300)

            # Create a single-page image PDF and merge into output
            img_pdf_bytes = _pil_to_image_pdf_page(img)
            img_reader = PdfReader(io.BytesIO(img_pdf_bytes))
            img_page = img_reader.pages[0]

            # Scale the image page to match original point dimensions
            img_w = float(img_page.mediabox.width)
            img_h = float(img_page.mediabox.height)
            if img_w > 0 and img_h > 0:
                img_page.scale(w_pt / img_w, h_pt / img_h)
                img_page.mediabox = RectangleObject([0, 0, w_pt, h_pt])

            writer.add_page(img_page)

        write_pdf(writer, output)
        click.echo(f"Flattened PDF written to {output}", err=True)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command("header-footer")
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--header", "header_text", type=str, default=None, help="Header text. Use {n} for page number, {total} for total.")
@click.option("--footer", "footer_text", type=str, default=None, help="Footer text. Use {n} for page number, {total} for total.")
@click.option("--font-size", type=float, default=10, help="Font size (default: 10).")
@click.option("--color", type=str, default="black", help="Text color (default: black).")
@click.option("--margin", type=float, default=36, help="Margin from edge in points (default: 36 = 0.5in).")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def header_footer(file: str, header_text: str | None, footer_text: str | None, font_size: float, color: str, margin: float, output: str) -> None:
    """Add header and/or footer text to PDF pages.

    Use {n} for page number and {total} for total page count.
    Example: --footer "Page {n} of {total}"
    """
    check_output_differs(file, output)
    if not header_text and not footer_text:
        click.echo("Error: provide --header and/or --footer.", err=True)
        sys.exit(1)
    try:
        reader = PdfReader(file)
        writer = PdfWriter()
        total = len(reader.pages)
        rgb = parse_color(color)

        for i, page in enumerate(reader.pages):
            box = page.mediabox
            w = float(box.width)
            h = float(box.height)
            page_num = i + 1

            texts: list[dict] = []
            if header_text:
                text = header_text.replace("{n}", str(page_num)).replace("{total}", str(total))
                approx_width = len(text) * font_size * 0.5
                x = (w - approx_width) / 2
                y = h - margin
                texts.append({"x": x, "y": y, "text": text, "font_size": font_size, "color": rgb})
            if footer_text:
                text = footer_text.replace("{n}", str(page_num)).replace("{total}", str(total))
                approx_width = len(text) * font_size * 0.5
                x = (w - approx_width) / 2
                y = margin - font_size
                texts.append({"x": x, "y": y, "text": text, "font_size": font_size, "color": rgb})

            overlay_bytes = _make_text_overlay_pdf(w, h, texts)
            overlay_reader = PdfReader(io.BytesIO(overlay_bytes))
            page.merge_page(overlay_reader.pages[0])
            writer.add_page(page)

        write_pdf(writer, output)
        click.echo(f"Header/footer added, written to {output}", err=True)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
