# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "pypdfium2==5.14.0",
#   "pypdf==6.21.4",
#   "img2pdf==0.6.3",
#   "Pillow==13.0.0",
#   "click==8.5.0",
#   "python-pptx==1.0.2",
#   "python-docx==1.2.0",
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

from importlib import import_module

from pdf_common import cli

# Import command modules so their Click decorators register on the shared group.
for _module_name in ("pdf_convert", "pdf_edit", "pdf_organize", "pdf_security"):
    _ = import_module(_module_name)

if __name__ == "__main__":
    cli()
