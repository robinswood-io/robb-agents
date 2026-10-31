from pypdf.errors import PyPdfError

"""Native PDF commands, registered on the shared Click group."""

from collections.abc import Mapping
from numbers import Real
from typing import cast

from pdf_common import (
    Path,
    PdfReader,
    PdfWriter,
    RectangleObject,
    check_output_differs,
    cli,
    click,
    json,
    parse_page_range,
    pdfium,
    sys,
    write_output,
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
@click.option("--pages", type=str, default=None, help="Page range to extract (e.g. '1-3,5,7-9'). 1-based.")
@click.option("-o", "--output", type=click.Path(), default=None, help="Write output to file.")
def extract(file: str, pages: str | None, output: str | None) -> None:
    """Extract text from a PDF file.

    Extracts all text by default, or specific pages with --pages.
    """
    try:
        pdf = pdfium.PdfDocument(file)
        total = len(pdf)
        page_indices = parse_page_range(pages, total) if pages else list(range(total))

        parts: list[str] = []
        for idx in page_indices:
            page = pdf[idx]
            textpage = page.get_textpage()
            text = textpage.get_text_bounded()
            parts.append(f"--- Page {idx + 1} ---\n{text}")

        write_output("\n".join(parts), output)
    except _PDF_OPERATION_ERRORS as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("-o", "--output", type=click.Path(), default=None, help="Write output to file.")
@click.option("--set", "set_mode", is_flag=True, default=False, help="Edit metadata (use with --title, --author, etc.).")
@click.option("--title", type=str, default=None, help="Set document title (requires --set).")
@click.option("--author", type=str, default=None, help="Set document author (requires --set).")
@click.option("--subject", type=str, default=None, help="Set document subject (requires --set).")
@click.option("--keywords", type=str, default=None, help="Set document keywords (requires --set).")
def info(file: str, output: str | None, set_mode: bool, title: str | None, author: str | None, subject: str | None, keywords: str | None) -> None:
    """Show or edit PDF metadata and information.

    Use --set with --title, --author, --subject, --keywords to edit metadata.
    """
    if set_mode:
        if not output:
            click.echo("Error: -o/--output is required when using --set.", err=True)
            sys.exit(1)
        check_output_differs(file, output)
        try:
            reader = PdfReader(file)
            writer = PdfWriter()
            writer.append(reader)
            meta: dict[str, str] = {}
            if title is not None:
                meta["/Title"] = title
            if author is not None:
                meta["/Author"] = author
            if subject is not None:
                meta["/Subject"] = subject
            if keywords is not None:
                meta["/Keywords"] = keywords
            if not meta:
                click.echo("Error: provide at least one of --title, --author, --subject, --keywords.", err=True)
                sys.exit(1)
            writer.add_metadata(meta)
            write_pdf(writer, output)
        except _PDF_OPERATION_ERRORS as e:
            click.echo(f"Error: {e}", err=True)
            sys.exit(1)
        return

    # Read mode (existing behavior)
    try:
        reader = PdfReader(file)

        info_dict: dict[str, object] = {
            "file": str(Path(file).resolve()),
            "encrypted": reader.is_encrypted,
        }

        if reader.is_encrypted:
            info_dict["pages"] = None
            info_dict["note"] = "PDF is encrypted. Decrypt to view full metadata."
        else:
            info_dict["pages"] = len(reader.pages)
            meta_obj = reader.metadata

            if meta_obj:
                info_dict["metadata"] = {
                    "title": meta_obj.title,
                    "author": meta_obj.author,
                    "subject": meta_obj.subject,
                    "creator": meta_obj.creator,
                    "producer": meta_obj.producer,
                    "creation_date": str(meta_obj.creation_date) if meta_obj.creation_date else None,
                    "modification_date": str(meta_obj.modification_date) if meta_obj.modification_date else None,
                }

            # Page dimensions from first page
            if reader.pages:
                page = reader.pages[0]
                width, height = _page_dimensions(page)
                info_dict["page_size"] = {
                    "width": width,
                    "height": height,
                    "width_inches": round(width / 72, 2),
                    "height_inches": round(height / 72, 2),
                }

            # Form fields
            fields_value: object = reader.get_fields()
            if isinstance(fields_value, dict):
                field_info: list[dict[str, str]] = []
                fields = cast(dict[object, object], fields_value)
                for name, raw_field in fields.items():
                    field: object = raw_field
                    field_mapping: Mapping[str, object] = {}
                    if isinstance(field, dict):
                        field_entries = cast(dict[object, object], field)
                        if all(isinstance(key, str) for key in field_entries):
                            field_mapping = cast(Mapping[str, object], field_entries)
                    field_info.append({
                        "name": str(name),
                        "type": str(field_mapping.get("/FT", "Unknown")),
                        "value": str(field_mapping.get("/V", "")),
                    })
                info_dict["form_fields"] = field_info

        write_output(json.dumps(info_dict, indent=2, default=str), output)
    except _PDF_OPERATION_ERRORS as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("files", nargs=-1, required=True, type=click.Path(exists=True, dir_okay=False))
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def merge(files: tuple[str, ...], output: str) -> None:
    """Merge multiple PDF files into one.

    Files are merged in the order provided.
    """
    if len(files) < 2:
        click.echo("Error: at least 2 PDF files are required for merge.", err=True)
        sys.exit(1)

    resolved_output = str(Path(output).resolve())
    for f in files:
        if str(Path(f).resolve()) == resolved_output:
            click.echo("Error: output file cannot be one of the input files.", err=True)
            sys.exit(1)

    try:
        writer = PdfWriter()
        for f in files:
            reader = PdfReader(f)
            for page in reader.pages:
                _ = writer.add_page(page)

        write_pdf(writer, output)
    except _PDF_OPERATION_ERRORS as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--pages", type=str, required=True, help="Page range to extract (e.g. '1-3,5,7-9'). 1-based.")
@click.option("--exclude", is_flag=True, default=False, help="Exclude specified pages instead of extracting them.")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def split(file: str, pages: str, exclude: bool, output: str) -> None:
    """Split a PDF by extracting or excluding specific pages.

    Use --exclude to delete pages instead of extracting them.
    """
    check_output_differs(file, output)

    try:
        reader = PdfReader(file)
        total = len(reader.pages)
        page_indices = parse_page_range(pages, total)

        if exclude:
            page_indices = [i for i in range(total) if i not in set(page_indices)]

        if not page_indices:
            click.echo("Error: no valid pages in the specified range.", err=True)
            sys.exit(1)

        writer = PdfWriter()
        for idx in page_indices:
            _ = writer.add_page(reader.pages[idx])

        write_pdf(writer, output)
    except _PDF_OPERATION_ERRORS as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--angle", type=click.Choice(["90", "180", "270"]), required=True, help="Rotation angle in degrees.")
@click.option("--pages", type=str, default=None, help="Page range to rotate (default: all).")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def rotate(file: str, angle: str, pages: str | None, output: str) -> None:
    """Rotate PDF pages by 90, 180, or 270 degrees."""
    check_output_differs(file, output)
    try:
        reader = PdfReader(file)
        writer = PdfWriter()
        total = len(reader.pages)
        target = set(parse_page_range(pages, total)) if pages else set(range(total))
        for i, page in enumerate(reader.pages):
            if i in target:
                _ = page.rotate(int(angle))
            _ = writer.add_page(page)
        write_pdf(writer, output)
    except _PDF_OPERATION_ERRORS as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--order", type=str, default=None, help="Comma-separated 1-based page order (e.g. '3,1,2,4').")
@click.option("--reverse", is_flag=True, default=False, help="Reverse page order.")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def reorder(file: str, order: str | None, reverse: bool, output: str) -> None:
    """Reorder PDF pages by custom order or reverse them."""
    check_output_differs(file, output)
    if order and reverse:
        click.echo("Error: --order and --reverse are mutually exclusive. Provide only one.", err=True)
        sys.exit(1)
    if not order and not reverse:
        click.echo("Error: provide --order or --reverse.", err=True)
        sys.exit(1)
    try:
        reader = PdfReader(file)
        total = len(reader.pages)
        if reverse:
            indices = list(reversed(range(total)))
        else:
            if order is None:
                raise ValueError("Page order is required")
            indices = [int(x.strip()) - 1 for x in order.split(",")]
            for idx in indices:
                if idx < 0 or idx >= total:
                    click.echo(f"Error: page {idx + 1} out of range (1-{total}).", err=True)
                    sys.exit(1)
        writer = PdfWriter()
        for idx in indices:
            _ = writer.add_page(reader.pages[idx])
        write_pdf(writer, output)
    except ValueError:
        click.echo("Error: --order must be comma-separated page numbers.", err=True)
        sys.exit(1)
    except _PDF_OPERATION_ERRORS as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@cli.command()
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
@click.option("--pages", type=str, required=True, help="Page range to duplicate (e.g. '1,3').")
@click.option("--copies", type=click.IntRange(min=2), default=2, help="Total copies of each page (min: 2, default: 2).")
@click.option("-o", "--output", type=click.Path(), required=True, help="Output PDF file path.")
def duplicate(file: str, pages: str, copies: int, output: str) -> None:
    """Duplicate specific pages within a PDF."""
    check_output_differs(file, output)
    try:
        reader = PdfReader(file)
        total = len(reader.pages)
        dup_set = set(parse_page_range(pages, total))
        writer = PdfWriter()
        for i, page in enumerate(reader.pages):
            _ = writer.add_page(page)
            if i in dup_set:
                for _ in range(copies - 1):
                    _ = writer.add_page(page)
        write_pdf(writer, output)
    except _PDF_OPERATION_ERRORS as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
