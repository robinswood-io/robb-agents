# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "pypdfium2>=5.5,<6",
#   "pypdf>=6.7,<7",
#   "img2pdf>=0.5,<1",
#   "Pillow>=10,<12",
#   "click>=8.3,<9",
#   "python-pptx>=1.0,<2",
#   "python-docx>=1.1,<2",
# ]
# ///
"""PDF operations tool.

Commands:
  Organize:  extract, info, merge, split, rotate, reorder, duplicate
  Edit:      watermark, fill-form, compress, crop, resize, flatten, header-footer
  Security:  encrypt, decrypt, redact, sanitize
  Convert:   to-image, from-image, to-docx, to-pptx

Usage:
    uv run pdf_tool.py COMMAND [OPTIONS]

Validation note:
    Page range parsing is strict. Out-of-range pages and malformed --pages input now
    return explicit errors instead of being silently ignored.
"""

from pdf_common import (
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
from pdf_organize import extract, info, merge, split, rotate, reorder, duplicate
from pdf_edit import watermark, fill_form, compress, crop, resize, flatten, header_footer
from pdf_security import encrypt, decrypt, redact, sanitize
from pdf_convert import to_image, from_image, to_docx, to_pptx

if __name__ == "__main__":
    cli()
