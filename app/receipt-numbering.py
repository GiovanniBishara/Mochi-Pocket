"""Read only receipt number/year from legacy PDFs; never print document text."""

from __future__ import annotations

import contextlib
from datetime import datetime
import json
import logging
import os
from pathlib import Path
import re
import stat
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "engines" / "alloggiati" / "vendor"))
logging.getLogger("pypdf").addHandler(logging.NullHandler())
logging.getLogger("pypdf").propagate = False
logging.getLogger("pypdf").setLevel(logging.CRITICAL)

MAX_INPUT = 64 * 1024
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 50 * 1024 * 1024
MAX_FILES = 100
MAX_PAGES = 5
LEGACY_NAME = re.compile(r"^Ricevuta\s+n\.?\s+(\d{1,24})(?:\s+\(\d+\))?\.pdf$", re.I)
HEADER = re.compile(r"\bRICEVUTA\s+N[.\u00b0\u00ba:]?\s*(\d{1,24})(?:\s*/\s*(\d{4}|\d{2}))?(?=\s|$)", re.I)
ISSUE_DATE = re.compile(r"\bDATA\s+(?:DI\s+)?EMISSIONE\s*:?\s*(\d{1,2}/\d{1,2}/\d{4})\b", re.I)
HEADER_DATE = re.compile(r"\s+DEL\s+(\d{1,2}/\d{1,2}/\d{4})\b", re.I)


class MetadataError(Exception):
    pass


class DiscardOutput:
    def write(self, value):
        return len(value)

    def flush(self):
        pass


def metadata_from_text(text, expected_number):
    """No money or guest/address patterns are parsed here."""
    if not isinstance(text, str) or len(text) > 128 * 1024:
        raise MetadataError("metadata")
    flat = " ".join(text.split())
    headers = list(HEADER.finditer(flat))
    values = {(str(int(match[1])), match[2]) for match in headers}
    if len(values) != 1:
        raise MetadataError("metadata")
    number, annual = next(iter(values))
    if number != str(int(expected_number)):
        raise MetadataError("mismatch")
    dates = [match[1] for match in ISSUE_DATE.finditer(flat)]
    for header in headers:
        suffix = HEADER_DATE.match(flat[header.end():])
        if suffix:
            dates.append(suffix[1])
    try:
        parsed_dates = {datetime.strptime(value, "%d/%m/%Y").date() for value in dates}
    except ValueError:
        raise MetadataError("metadata") from None
    if len(parsed_dates) > 1:
        raise MetadataError("metadata")
    emission = next(iter(parsed_dates), None)
    if emission and not 1900 <= emission.year <= 9999:
        raise MetadataError("metadata")
    if annual is not None:
        if len(annual) == 4 and not 1900 <= int(annual) <= 9999:
            raise MetadataError("metadata")
        if emission and str(emission.year)[-len(annual):] != annual:
            raise MetadataError("mismatch")
        year = str(emission.year) if emission else annual
    elif emission:
        year = str(emission.year)
    else:
        raise MetadataError("metadata")
    return {"number": number, "year": year, "fullYear": annual is not None and len(annual) == 4}


def inspect_legacy(payload, *, deadline=None):
    if not isinstance(payload, dict) or not isinstance(payload.get("files"), list) or not 1 <= len(payload["files"]) <= MAX_FILES:
        return {"ok": False, "code": "input"}
    try:
        root = Path(payload["directory"])
        if not root.is_absolute() or root.is_symlink() or not root.is_dir():
            raise MetadataError("input")
        root = root.resolve(strict=True)
        files = []
        total = 0
        for item in payload["files"]:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str) or len(item["path"]) > 4096:
                raise MetadataError("input")
            file = Path(item["path"])
            match = LEGACY_NAME.fullmatch(file.name)
            if not file.is_absolute() or match is None or file.is_symlink() or file.parent.resolve(strict=True) != root:
                raise MetadataError("input")
            expected = item.get("number")
            if not isinstance(expected, str) or not re.fullmatch(r"\d{1,24}", expected) or int(match[1]) != int(expected):
                raise MetadataError("input")
            info = file.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
                raise MetadataError("limit")
            total += info.st_size
            if total > MAX_TOTAL_BYTES:
                raise MetadataError("limit")
            files.append((file, expected, info))
        from pypdf import PdfReader

        result = []
        deadline = deadline if deadline is not None else time.monotonic() + 12
        for file, expected, before in files:
            if time.monotonic() >= deadline:
                raise MetadataError("timeout")
            with file.open("rb") as stream:
                opened = os.fstat(stream.fileno())
                if ((opened.st_dev, opened.st_ino, opened.st_size) != (before.st_dev, before.st_ino, before.st_size)
                        or opened.st_size > MAX_FILE_BYTES or stream.read(5) != b"%PDF-"):
                    raise MetadataError("metadata")
                stream.seek(0)
                with contextlib.redirect_stdout(DiscardOutput()), contextlib.redirect_stderr(DiscardOutput()):
                    reader = PdfReader(stream, strict=False)
                    if reader.is_encrypted or not 1 <= len(reader.pages) <= MAX_PAGES:
                        raise MetadataError("metadata")
                    text = reader.pages[0].extract_text() or ""
                metadata = metadata_from_text(text, expected)
                after = os.fstat(stream.fileno())
                if (after.st_size, after.st_mtime_ns) != (before.st_size, before.st_mtime_ns):
                    raise MetadataError("metadata")
            if time.monotonic() >= deadline:
                raise MetadataError("timeout")
            result.append(metadata)
        return {"ok": True, "receipts": result}
    except MetadataError as error:
        return {"ok": False, "code": str(error)}
    except Exception:
        return {"ok": False, "code": "unreadable"}


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            result = {"ok": False, "code": "input"}
        else:
            result = inspect_legacy(json.loads(raw.decode("utf-8")))
    except Exception:
        result = {"ok": False, "code": "input"}
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
