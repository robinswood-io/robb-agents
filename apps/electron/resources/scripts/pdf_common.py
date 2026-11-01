"""Shared helpers for PDF commands with strict page-range validation."""

import copy
import io
import json
import math
import re
import sys
import zlib
from importlib import import_module
from pathlib import Path
from typing import IO, Protocol, Self, TypedDict, runtime_checkable

import click
from pypdf import PdfReader, PdfWriter
from pypdf.generic import BooleanObject, NameObject, RectangleObject


class _ImageLike(Protocol):
    size: tuple[int, int]

    def convert(self, mode: str) -> Self: ...

    def tobytes(self) -> bytes: ...

    def save(self, file: str | IO[bytes], format: str | None = None, **params: int) -> None: ...


class _PdfBitmapLike(Protocol):
    def to_pil(self) -> _ImageLike: ...


class _PdfTextSearcherLike(Protocol):
    def get_next(self) -> tuple[int, int] | None: ...


class _PdfTextPageLike(Protocol):
    def get_text_bounded(self) -> str: ...

    def search(self, text: str) -> _PdfTextSearcherLike: ...

    def get_charbox(self, index: int) -> tuple[float, float, float, float]: ...


class _PdfPageLike(Protocol):
    def render(self, scale: float = 1.0) -> _PdfBitmapLike: ...

    def get_textpage(self) -> _PdfTextPageLike: ...

    def get_size(self) -> tuple[float, float]: ...


class _PdfDocumentLike(Protocol):
    def __len__(self) -> int: ...

    def __getitem__(self, index: int) -> _PdfPageLike: ...

    def close(self) -> None: ...


@runtime_checkable
class _PdfiumModuleLike(Protocol):
    def PdfDocument(self, file: str) -> _PdfDocumentLike: ...


def _load_pdfium() -> _PdfiumModuleLike:
    """Load pypdfium2 through its documented document factory interface."""
    module = import_module("pypdfium2")
    if not isinstance(module, _PdfiumModuleLike):
        raise TypeError("pypdfium2 does not expose the PdfDocument interface")
    return module


pdfium = _load_pdfium()

__all__ = [
    "PAGE_SIZES",
    "BooleanObject",
    "NameObject",
    "Path",
    "PdfReader",
    "PdfWriter",
    "RectangleObject",
    "_TextOverlay",
    "_make_text_overlay_pdf",
    "_make_watermark_pdf",
    "_pil_to_image_pdf_page",
    "_render_page_to_pil",
    "check_output_differs",
    "cli",
    "click",
    "copy",
    "io",
    "json",
    "math",
    "parse_page_range",
    "pdfium",
    "re",
    "sys",
    "write_output",
    "write_pdf",
]

# Standard page sizes in points (width x height)
PAGE_SIZES: dict[str, tuple[float, float]] = {
    "a3": (841.89, 1190.55),
    "a4": (595.28, 841.89),
    "a5": (419.53, 595.28),
    "letter": (612, 792),
    "legal": (612, 1008),
    "tabloid": (792, 1224),
}


# --- Helpers ---


def write_output(text: str, output_path: str | None) -> None:
    """Write text to file or stdout."""
    if output_path:
        _ = Path(output_path).write_text(text, encoding="utf-8")
        click.echo(f"Output written to {output_path}", err=True)
    else:
        click.echo(text)


def write_pdf(writer: PdfWriter, output_path: str) -> None:
    """Write a PdfWriter to a file."""
    with open(output_path, "wb") as f:
        _ = writer.write(f)
    click.echo(f"PDF written to {output_path}", err=True)


def parse_page_range(range_str: str, total_pages: int) -> list[int]:
    """Parse a strict page range string like '1-3,5,7-9' into zero-based page indices.

    Validation is intentionally strict:
    - empty segments are invalid
    - pages must be in range 1..total_pages
    - range bounds must be ascending (start <= end)
    - invalid tokens fail fast (no silent dropping)
    """
    if total_pages <= 0:
        raise ValueError("PDF has no pages.")

    if not range_str or not range_str.strip():
        raise ValueError("Page range cannot be empty.")

    pages: list[int] = []
    seen: set[int] = set()
    parts = range_str.split(",")

    for raw_part in parts:
        part = raw_part.strip()
        if not part:
            raise ValueError("Invalid page range: empty segment detected.")

        if "-" in part:
            if part.count("-") != 1:
                raise ValueError(f"Invalid page range: '{part}'. Expected format: '1-3' or '5'.")
            start_s, end_s = part.split("-", 1)
            if not start_s.strip() or not end_s.strip():
                raise ValueError(f"Invalid page range: '{part}'. Expected format: '1-3' or '5'.")
            try:
                start = int(start_s)
                end = int(end_s)
            except ValueError:
                raise ValueError(f"Invalid page range: '{part}'. Expected format: '1-3' or '5'.")

            if start < 1 or end < 1:
                raise ValueError(f"Invalid page range: '{part}'. Pages must be >= 1.")
            if start > end:
                raise ValueError(f"Invalid page range: '{part}'. Start page must be <= end page.")
            if start > total_pages or end > total_pages:
                raise ValueError(f"Page range '{part}' out of bounds. Valid pages: 1-{total_pages}.")

            for page_num in range(start, end + 1):
                idx = page_num - 1
                if idx not in seen:
                    seen.add(idx)
                    pages.append(idx)
        else:
            try:
                page_num = int(part)
            except ValueError:
                raise ValueError(f"Invalid page number: '{part}'. Expected a number.")

            if page_num < 1 or page_num > total_pages:
                raise ValueError(f"Page '{page_num}' out of bounds. Valid pages: 1-{total_pages}.")

            idx = page_num - 1
            if idx not in seen:
                seen.add(idx)
                pages.append(idx)

    if not pages:
        raise ValueError("No pages selected.")

    return pages


def check_output_differs(file: str, output: str) -> None:
    """Ensure output file differs from input file."""
    if str(Path(file).resolve()) == str(Path(output).resolve()):
        click.echo("Error: output file cannot be the same as input file.", err=True)
        sys.exit(1)


def parse_color(color: str) -> tuple[float, float, float]:
    """Parse a color name or hex string to RGB tuple (0-1 range)."""
    color_map: dict[str, tuple[float, float, float]] = {
        "gray": (0.5, 0.5, 0.5), "grey": (0.5, 0.5, 0.5),
        "red": (1.0, 0.0, 0.0), "blue": (0.0, 0.0, 1.0),
        "green": (0.0, 0.5, 0.0), "black": (0.0, 0.0, 0.0),
        "white": (1.0, 1.0, 1.0),
    }
    if color.startswith("#") and len(color) == 7:
        try:
            r = int(color[1:3], 16) / 255.0
            g = int(color[3:5], 16) / 255.0
            b = int(color[5:7], 16) / 255.0
            return (r, g, b)
        except ValueError:
            pass
    return color_map.get(color.lower(), (0.5, 0.5, 0.5))


def _render_page_to_pil(page: _PdfPageLike, dpi: int = 150) -> _ImageLike:
    """Render a pypdfium2 page to a PIL Image at the given DPI."""
    scale = dpi / 72
    bitmap = page.render(scale=scale)
    return bitmap.to_pil()


def _make_watermark_pdf(width: float, height: float, text: str, font_size: float,
                        opacity: float, angle: float, color: tuple[float, float, float]) -> bytes:
    """Generate a single-page transparent PDF with centered rotated text.

    Builds a minimal valid PDF from raw bytes — no extra dependencies needed.
    """
    r, g, b = color
    angle_rad = math.radians(angle)
    cos_a = math.cos(angle_rad)
    sin_a = math.sin(angle_rad)

    # Approximate text width (Helvetica ~0.5 * font_size per char)
    approx_text_width = len(text) * font_size * 0.5
    cx, cy = width / 2, height / 2
    tx = cx - (approx_text_width * cos_a) / 2 + (font_size * sin_a) / 3
    ty = cy - (approx_text_width * sin_a) / 2 - (font_size * cos_a) / 3

    # PDF content stream: set color, font, position via rotation matrix, show text
    stream_content = (
        f"q\n"
        f"/GS1 gs\n"
        f"BT\n"
        f"{r:.3f} {g:.3f} {b:.3f} rg\n"
        f"/F1 {font_size:.1f} Tf\n"
        f"{cos_a:.6f} {sin_a:.6f} {-sin_a:.6f} {cos_a:.6f} {tx:.2f} {ty:.2f} Tm\n"
        f"({_pdf_escape(text)}) Tj\n"
        f"ET\n"
        f"Q\n"
    )
    stream_bytes = stream_content.encode("latin-1")

    # Build minimal PDF structure
    objects: list[str] = []

    # 1: Catalog
    objects.append("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj")
    # 2: Pages
    objects.append("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj")
    # 3: Page
    objects.append(
        "".join((
            f"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width:.2f} {height:.2f}] ",
            "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /ExtGState << /GS1 6 0 R >> >> >>\nendobj",
        ))
    )
    # 4: Content stream
    objects.append(
        f"4 0 obj\n<< /Length {len(stream_bytes)} >>\nstream\n".rstrip()
    )
    # 5: Font
    objects.append("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj")
    # 6: ExtGState for opacity
    objects.append(f"6 0 obj\n<< /Type /ExtGState /ca {opacity:.2f} /CA {opacity:.2f} >>\nendobj")

    # Assemble PDF
    pdf_lines = ["%PDF-1.4"]
    offsets: list[int] = []

    for i, obj in enumerate(objects):
        offset = sum(len(line.encode("latin-1")) + 1 for line in pdf_lines)
        offsets.append(offset)
        if i == 3:  # content stream object — inject binary stream
            pdf_lines.append(obj)
            # We need special handling for stream content
        else:
            pdf_lines.append(obj)

    # Rebuild properly with stream
    output = io.BytesIO()
    _ = output.write(b"%PDF-1.4\n")

    obj_offsets: list[int] = []

    # Obj 1: Catalog
    obj_offsets.append(output.tell())
    _ = output.write(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")

    # Obj 2: Pages
    obj_offsets.append(output.tell())
    _ = output.write(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n")

    # Obj 3: Page
    obj_offsets.append(output.tell())
    _ = output.write(
        "".join((
            f"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width:.2f} {height:.2f}] ",
            "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /ExtGState << /GS1 6 0 R >> >> >>\nendobj\n",
        )).encode("latin-1")
    )

    # Obj 4: Content stream
    obj_offsets.append(output.tell())
    _ = output.write(f"4 0 obj\n<< /Length {len(stream_bytes)} >>\nstream\n".encode("latin-1"))
    _ = output.write(stream_bytes)
    _ = output.write(b"\nendstream\nendobj\n")

    # Obj 5: Font
    obj_offsets.append(output.tell())
    _ = output.write(b"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n")

    # Obj 6: ExtGState
    obj_offsets.append(output.tell())
    _ = output.write(f"6 0 obj\n<< /Type /ExtGState /ca {opacity:.2f} /CA {opacity:.2f} >>\nendobj\n".encode("latin-1"))

    # Cross-reference table
    xref_offset = output.tell()
    _ = output.write(b"xref\n")
    _ = output.write(f"0 {len(obj_offsets) + 1}\n".encode("latin-1"))
    _ = output.write(b"0000000000 65535 f \n")
    for off in obj_offsets:
        _ = output.write(f"{off:010d} 00000 n \n".encode("latin-1"))

    # Trailer
    _ = output.write(f"trailer\n<< /Size {len(obj_offsets) + 1} /Root 1 0 R >>\n".encode("latin-1"))
    _ = output.write(b"startxref\n")
    _ = output.write(f"{xref_offset}\n".encode("latin-1"))
    _ = output.write(b"%%EOF\n")

    return output.getvalue()


def _pdf_escape(text: str) -> str:
    """Escape text for PDF string literal."""
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


class _TextOverlay(TypedDict):
    x: float
    y: float
    text: str
    font_size: float
    color: tuple[float, float, float]


def _make_text_overlay_pdf(width: float, height: float, texts: list[_TextOverlay]) -> bytes:
    """Generate a single-page PDF with positioned text elements.

    Each text dict: {"x": float, "y": float, "text": str, "font_size": float, "color": (r,g,b)}
    """
    parts: list[str] = []
    parts.append("BT\n")
    for t in texts:
        r, g, b = t["color"]
        parts.append(f"{r:.3f} {g:.3f} {b:.3f} rg\n")
        parts.append(f"/F1 {t['font_size']:.1f} Tf\n")
        parts.append(f"{t['x']:.2f} {t['y']:.2f} Td\n")
        parts.append(f"({_pdf_escape(t['text'])}) Tj\n")
        # Reset position for next element
        parts.append(f"{-t['x']:.2f} {-t['y']:.2f} Td\n")
    parts.append("ET\n")

    stream_bytes = "".join(parts).encode("latin-1")

    output = io.BytesIO()
    _ = output.write(b"%PDF-1.4\n")

    obj_offsets: list[int] = []

    obj_offsets.append(output.tell())
    _ = output.write(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")

    obj_offsets.append(output.tell())
    _ = output.write(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n")

    obj_offsets.append(output.tell())
    _ = output.write(
        "".join((
            f"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width:.2f} {height:.2f}] ",
            "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
        )).encode("latin-1")
    )

    obj_offsets.append(output.tell())
    _ = output.write(f"4 0 obj\n<< /Length {len(stream_bytes)} >>\nstream\n".encode("latin-1"))
    _ = output.write(stream_bytes)
    _ = output.write(b"\nendstream\nendobj\n")

    obj_offsets.append(output.tell())
    _ = output.write(b"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n")

    xref_offset = output.tell()
    _ = output.write(b"xref\n")
    _ = output.write(f"0 {len(obj_offsets) + 1}\n".encode("latin-1"))
    _ = output.write(b"0000000000 65535 f \n")
    for off in obj_offsets:
        _ = output.write(f"{off:010d} 00000 n \n".encode("latin-1"))

    _ = output.write(f"trailer\n<< /Size {len(obj_offsets) + 1} /Root 1 0 R >>\n".encode("latin-1"))
    _ = output.write(b"startxref\n")
    _ = output.write(f"{xref_offset}\n".encode("latin-1"))
    _ = output.write(b"%%EOF\n")

    return output.getvalue()


def _pil_to_image_pdf_page(img: _ImageLike) -> bytes:
    """Convert a PIL Image to a single-page PDF with the image embedded (raw RGB, flate-compressed).

    Returns raw PDF bytes. Used for flatten and redact where we need to replace
    page content with a rasterized image.
    """
    width_px, height_px = img.size
    rgb_data = img.convert("RGB").tobytes()
    compressed = zlib.compress(rgb_data, 6)

    # Page size in points — match original aspect ratio at 72 DPI equivalent
    # The caller should set the page size; we use pixel dimensions as points here
    # and let the caller scale appropriately.
    output = io.BytesIO()
    _ = output.write(b"%PDF-1.4\n")

    obj_offsets: list[int] = []

    obj_offsets.append(output.tell())
    _ = output.write(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")

    obj_offsets.append(output.tell())
    _ = output.write(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n")

    # Content stream: draw image scaled to full page
    cs = f"q\n{width_px} 0 0 {height_px} 0 0 cm\n/Im1 Do\nQ\n".encode("latin-1")

    obj_offsets.append(output.tell())
    _ = output.write(
        "".join((
            f"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width_px} {height_px}] ",
            "/Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>\nendobj\n",
        )).encode("latin-1")
    )

    obj_offsets.append(output.tell())
    _ = output.write(f"4 0 obj\n<< /Length {len(cs)} >>\nstream\n".encode("latin-1"))
    _ = output.write(cs)
    _ = output.write(b"\nendstream\nendobj\n")

    obj_offsets.append(output.tell())
    _ = output.write(
        "".join((
            f"5 0 obj\n<< /Type /XObject /Subtype /Image /Width {width_px} /Height {height_px} ",
            "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ",
            f"/Length {len(compressed)} >>\nstream\n",
        )).encode("latin-1")
    )
    _ = output.write(compressed)
    _ = output.write(b"\nendstream\nendobj\n")

    xref_offset = output.tell()
    _ = output.write(b"xref\n")
    _ = output.write(f"0 {len(obj_offsets) + 1}\n".encode("latin-1"))
    _ = output.write(b"0000000000 65535 f \n")
    for off in obj_offsets:
        _ = output.write(f"{off:010d} 00000 n \n".encode("latin-1"))

    _ = output.write(f"trailer\n<< /Size {len(obj_offsets) + 1} /Root 1 0 R >>\n".encode("latin-1"))
    _ = output.write(b"startxref\n")
    _ = output.write(f"{xref_offset}\n".encode("latin-1"))
    _ = output.write(b"%%EOF\n")

    return output.getvalue()


@click.group()
def cli() -> None:
    """PDF operations tool."""
