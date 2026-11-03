"""Summarize the months present in a Kross export without exposing guest data."""
from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
from pathlib import Path
import sys


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError("invalid_arguments")


def summarize_months(bookings):
    if not isinstance(bookings, list) or len(bookings) > 100000:
        raise ValueError("invalid_export")
    totals = {}
    for booking in bookings:
        start = dt.date.fromisoformat(booking["checkIn"])
        end = dt.date.fromisoformat(booking["checkOut"])
        if (start.isoformat() != booking["checkIn"] or end.isoformat() != booking["checkOut"]
                or not 1900 <= start.year <= 2199 or not 1900 <= end.year <= 2199
                or not 1 <= (end - start).days <= 3660):
            raise ValueError("invalid_dates")
        current = start
        while current < end:
            next_month = dt.date(current.year + (current.month == 12), current.month % 12 + 1, 1)
            stop = min(end, next_month)
            month = current.strftime("%Y-%m")
            total = totals.setdefault(month, {"month": month, "stays": 0, "nights": 0})
            total["stays"] += 1
            total["nights"] += (stop - current).days
            current = stop
        if len(totals) > 1200:
            raise ValueError("too_many_months")
    months = [totals[month] for month in sorted(totals)]
    dominant = max(months, key=lambda value: (value["nights"], value["stays"], value["month"]), default=None)
    return {"ok": True, "months": months, "suggestedMonth": dominant["month"] if dominant else None}


def read_scope(engine_dir, export_path):
    engine_dir, export_path = Path(engine_dir).absolute(), Path(export_path).absolute()
    if (not export_path.is_file() or export_path.suffix.lower() != ".xlsx"
            or export_path.stat().st_size > 64 * 1024 * 1024):
        raise ValueError("invalid_export")
    reader_path = engine_dir / "read_workbooks.py"
    if not reader_path.is_file():
        raise ValueError("invalid_reader")
    spec = importlib.util.spec_from_file_location("kross_scope_workbook_reader", reader_path)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    import openpyxl
    warnings = []
    bookings = reader.read_bookings(openpyxl, export_path, warnings)
    # Names, IDs, notes, warnings and original paths never enter the result.
    return summarize_months(bookings)


def main(argv=None):
    try:
        parser = Parser(add_help=False)
        parser.add_argument("--engine-dir", required=True)
        parser.add_argument("--export", required=True)
        args = parser.parse_args(argv)
        result = read_scope(args.engine_dir, args.export)
        code = 0
    except Exception:
        result, code = {"ok": False, "errorCode": "invalid_export"}, 1
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    return code


if __name__ == "__main__":
    sys.exit(main())
