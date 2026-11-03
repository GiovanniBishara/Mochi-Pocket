"""Read-only, ephemeral receipt suggestions from the configured annual calendars.

The Kross D column contains host net receipts, so it is deliberately never a
receipt rent source. Only unambiguous headings or explicitly labelled notes
may supply fiscal amounts. No spreadsheet mutation or login is exposed here.
"""

from __future__ import annotations

import argparse
import datetime as dt
from decimal import Decimal, InvalidOperation
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import unicodedata

FREE = {"", "libero", "libera", "disponibile", "chiuso", "chiusa", "bloccato", "bloccata",
        "manutenzione", "uso proprietario"}
RENT_HEADERS = {"canone", "canone locazione", "canone di locazione", "importo canone",
                "canone lordo", "affitto"}
TAX_HEADERS = {"tassa", "tassa di soggiorno", "tassa soggiorno", "imposta di soggiorno",
               "imposta soggiorno", "city tax", "tourist tax"}
DAY = dt.timedelta(days=1)


class CalendarError(Exception):
    pass


def normalized(value):
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    return " ".join(re.sub(r"[^\w ]", " ", text.casefold()).split())


def text_value(cell):
    value = cell.get("effectiveValue") or cell.get("userEnteredValue", {})
    text = value.get("stringValue", "")
    return text.strip() if isinstance(text, str) else ""


def scalar(cell):
    value = cell.get("effectiveValue") or cell.get("userEnteredValue", {})
    if "errorValue" in value or "boolValue" in value:
        return None
    return value.get("numberValue", value.get("stringValue"))


def money(value):
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        value = str(value)
    if not isinstance(value, str):
        return None
    value = value.strip().replace("€", "").replace("EUR", "").strip()
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+,\d{1,2}", value):
        value = value.replace(".", "")
    if not re.fullmatch(r"\d+(?:[.,]\d{1,2})?", value):
        return None
    try:
        result = Decimal(value.replace(",", "."))
        return format(result, ".2f") if result <= Decimal("999999999.99") else None
    except InvalidOperation:
        return None


def parse_date(value):
    if not isinstance(value, str):
        return None
    for pattern, fmt in ((r"\d{4}-\d{2}-\d{2}", "%Y-%m-%d"),
                         (r"\d{2}/\d{2}/\d{4}", "%d/%m/%Y")):
        if re.fullmatch(pattern, value.strip()):
            try:
                return dt.datetime.strptime(value.strip(), fmt).date()
            except ValueError:
                return None
    return None


def decode_snapshot(snapshot, sheet_name, id_column, google):
    """Decode date rows independently of month headings and vertical merges."""
    matches = [sheet for sheet in snapshot.get("sheets", [])
               if sheet.get("properties", {}).get("title") == sheet_name]
    if len(matches) != 1:
        raise CalendarError("calendar_invalid")
    sheet = matches[0]
    _, id_index = google.id_column_spec(id_column)
    cells = {}
    for block in sheet.get("data", []):
        for offset, row in enumerate(block.get("rowData", [])):
            row_index = block.get("startRow", 0) + offset
            for column_offset, cell in enumerate(row.get("values", [])):
                cells[(row_index, block.get("startColumn", 0) + column_offset)] = cell
    # Propagate only unambiguous vertical merges; never infer dates from a merge.
    for merge in sheet.get("merges", []):
        start_column = merge.get("startColumnIndex", 0)
        end_column = merge.get("endColumnIndex", start_column + 1)
        if end_column != start_column + 1 or start_column == 1:
            continue
        start_row = merge.get("startRowIndex", 0)
        anchor = cells.get((start_row, start_column), {})
        for row_index in range(start_row + 1, merge.get("endRowIndex", start_row + 1)):
            existing = scalar(cells.get((row_index, start_column), {}))
            if existing is None or existing == "":
                cells[(row_index, start_column)] = anchor
    rows = {}
    for row_index in sorted({key[0] for key in cells}):
        date = google.cell_date(cells.get((row_index, 1), {}))
        if date is None or date.year != int(sheet_name):
            continue
        if date in rows:
            raise CalendarError("calendar_invalid")
        guest = text_value(cells.get((row_index, 2), {}))
        try:
            identity = google.cell_kross_id(cells.get((row_index, id_index), {}), f"{id_column}{row_index + 1}") if id_index is not None else ""
        except google.GoogleSheetsError:
            raise CalendarError("calendar_invalid") from None
        rows[date] = {"date": date, "guest": guest, "krossId": identity,
                      "row": row_index, "cells": {column: cell for (row, column), cell in cells.items() if row == row_index}}
    if not rows:
        raise CalendarError("calendar_invalid")
    first_date_row = min(row["row"] for row in rows.values())
    headers = {}
    for (row_index, column), cell in cells.items():
        # Headings above the first date define a column; arbitrary guest-row text
        # is not interpreted as a monetary label.
        if row_index < first_date_row:
            header = normalized(text_value(cell))
            if header in RENT_HEADERS:
                headers.setdefault("rent", set()).add(column)
            if header in TAX_HEADERS:
                headers.setdefault("cityTax", set()).add(column)
    return {"rows": rows, "headers": headers, "year": int(sheet_name)}


def same_booking(left, right):
    if not left or not right or normalized(left["guest"]) in FREE or normalized(right["guest"]) in FREE:
        return False
    if left["krossId"] or right["krossId"]:
        return bool(left["krossId"]) and left["krossId"] == right["krossId"]
    return normalized(left["guest"]) == normalized(right["guest"])


def labelled_notes(rows):
    values = {}
    labels = {"canone": "rent", "canone di locazione": "rent", "canone locazione": "rent",
              "imposta di soggiorno": "cityTax", "tassa di soggiorno": "cityTax", "city tax": "cityTax",
              "indirizzo": "recipientAddress", "indirizzo ospite": "recipientAddress",
              "codice fiscale": "recipientTaxId", "c f": "recipientTaxId", "cf": "recipientTaxId",
              "partita iva": "recipientTaxId", "check in": "arrival", "arrivo": "arrival",
              "check out": "departure", "partenza": "departure"}
    for row in rows:
        # A note attached to this booking can carry explicitly labelled details.
        for cell in row["cells"].values():
            note = cell.get("note", "")
            if not isinstance(note, str):
                continue
            for line in note.splitlines():
                match = re.fullmatch(r"\s*([^:=]{1,40})\s*[:=]\s*(.{1,600})\s*", line)
                if not match:
                    continue
                key = labels.get(normalized(match[1]))
                if not key:
                    continue
                raw = match[2].strip()
                value = money(raw) if key in ("rent", "cityTax") else parse_date(raw) if key in ("arrival", "departure") else raw
                if value is not None:
                    values.setdefault(key, set()).add(value)
    return values


def suggest_booking(snapshots, initial, selected_date):
    """Select the occupied night, excluding checkout, and retain unknown bounds."""
    all_rows = {}
    for snapshot in snapshots:
        all_rows.update(snapshot["rows"])
    selected = all_rows.get(selected_date)
    if selected is None:
        raise CalendarError("calendar_invalid")
    if normalized(selected["guest"]) in FREE:
        return None
    start = end = selected_date
    while same_booking(selected, all_rows.get(start - DAY)):
        start -= DAY
    while same_booking(selected, all_rows.get(end + DAY)):
        end += DAY
    rows = [all_rows[start + offset * DAY] for offset in range((end - start).days + 1)]
    arrival = start if start - DAY in all_rows else None
    departure = end + DAY if end + DAY in all_rows else None
    warnings = []
    if not selected["krossId"]:
        warnings.append("Date ricostruite dal nome contiguo: controlla che non ci siano soggiorni consecutivi della stessa persona.")
    if not arrival or not departure:
        warnings.append("Un confine del soggiorno non è visibile nel calendario: completa le date mancanti.")
    notes = labelled_notes(rows)
    for key, current in (("arrival", arrival), ("departure", departure)):
        choices = notes.get(key, set())
        if len(choices) == 1:
            noted = next(iter(choices))
            plausible = noted <= start if key == "arrival" else noted > end
            # A note may recover a missing year boundary, but may never contradict
            # a visible boundary or expand over another booking's visible night.
            if plausible and (current is None or current == noted):
                if key == "arrival":
                    arrival = noted
                else:
                    departure = noted
            elif current != noted:
                warnings.append("Date nelle note diverse dalle notti visibili: verifica il soggiorno.")
    suggestion = {"id": hashlib.sha256(f"{initial}:{selected['krossId']}:{start}:{end}".encode()).hexdigest()[:16],
                  "recipientName": selected["guest"], "arrival": arrival.isoformat() if arrival else None,
                  "departure": departure.isoformat() if departure else None,
                  "rent": None, "cityTax": None, "recipientAddress": "", "recipientTaxId": "", "warnings": warnings}
    for key in ("rent", "cityTax"):
        amounts = set(notes.get(key, set()))
        for snapshot in snapshots:
            for column in snapshot["headers"].get(key, set()):
                if column == 3 and key == "rent":
                    # Even a renamed D header does not change its known Kross
                    # semantics: host net receipts cannot become guest rent.
                    continue
                for row in rows:
                    if row["date"].year == snapshot["year"]:
                        value = money(scalar(row["cells"].get(column, {})))
                        if value is not None:
                            amounts.add(value)
        if len(amounts) == 1:
            suggestion[key] = next(iter(amounts))
        elif len(amounts) > 1:
            warnings.append("Più importi diversi nel soggiorno: completa manualmente il canone o l’imposta.")
    for key in ("recipientAddress", "recipientTaxId"):
        choices = notes.get(key, set())
        if len(choices) == 1:
            suggestion[key] = next(iter(choices))
    if suggestion["rent"] is None:
        warnings.append("Il netto del calendario non determina il canone della ricevuta: inserisci l’importo corretto.")
    required = ["recipientName", "recipientAddress", "arrival", "departure", "rent", "cityTax"]
    suggestion["missingFields"] = [key for key in required if not suggestion[key]]
    return suggestion


def import_google(engine_dir):
    module_path = Path(engine_dir) / "google_sheets.py"
    spec = importlib.util.spec_from_file_location("mochi_receipt_google", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_snapshot(config, config_root, google):
    class ReadOnlySheets(google.GoogleSheets):
        def api(self, identifier, *, parameters=None, body=None):
            if body is not None:
                raise CalendarError("calendar_invalid")
            return super().api(identifier, parameters=parameters)

    client = ReadOnlySheets(config_root / config["credentials"], config_root / config["token"])
    sheet = config["sheetName"]
    if not re.fullmatch(r"20\d{2}", sheet):
        raise CalendarError("configuration")
    ranges = [f"'{sheet}'!B:S"]
    id_column, id_index = google.id_column_spec(config.get("idColumn"))
    if id_index is not None and id_index > 18:
        ranges.append(f"'{sheet}'!{id_column}:{id_column}")
    raw = client.api(google.spreadsheet_id(config["spreadsheet"]), parameters={
        "ranges": ranges,
        "fields": "sheets(properties(sheetId,title),merges,data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,effectiveFormat(numberFormat),note))))"})
    return decode_snapshot(raw, sheet, id_column, google)


def lookup(config_file, engine_dir, request):
    initial, date_text = request.get("initial"), request.get("date")
    selected_date = parse_date(date_text)
    if not isinstance(initial, str) or not re.fullmatch(r"[A-Z]", initial) or selected_date is None or not 2000 <= selected_date.year <= 2099:
        raise CalendarError("validation")
    config_file = Path(config_file)
    with config_file.open(encoding="utf-8-sig") as source:
        config = json.load(source)
    google = import_google(engine_dir)
    calendars = [item for item in config.get("calendars", []) if item.get("type") == "google"
                 and str(item.get("name", "")).strip()[:1].upper() == initial]
    by_year = {}
    for item in calendars:
        year = int(item["sheetName"])
        if year in by_year:
            raise CalendarError("configuration")
        by_year[year] = item
    if selected_date.year not in by_year:
        raise CalendarError("validation")
    try:
        first = read_snapshot(by_year[selected_date.year], config_file.parent, google)
        snapshots = [first]
        selected = first["rows"].get(selected_date)
        if selected is None:
            raise CalendarError("calendar_invalid")
        if normalized(selected["guest"]) in FREE:
            return {"ok": True, "bookings": [], "source": "google"}
        # Load adjacent annual sheets only if this same booking reaches a year
        # boundary. Missing neighbours leave dates blank instead of guessing.
        for year, boundary in ((selected_date.year - 1, dt.date(selected_date.year, 1, 1)),
                               (selected_date.year + 1, dt.date(selected_date.year, 12, 31))):
            current = selected_date
            step = -DAY if year < selected_date.year else DAY
            while current != boundary and same_booking(selected, first["rows"].get(current + step)):
                current += step
            if current == boundary and year in by_year:
                snapshots.append(read_snapshot(by_year[year], config_file.parent, google))
        booking = suggest_booking(snapshots, initial, selected_date)
        return {"ok": True, "bookings": [booking] if booking else [], "source": "google"}
    except google.GoogleSheetsError as exc:
        # Do not emit raw HTTP messages, document IDs, local paths or token data.
        description = str(exc).casefold()
        auth = any(value in description for value in ("token", "oauth", "login", "credentials", "http 401", "http 403"))
        raise CalendarError("google_auth" if auth else "google_unavailable") from None


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-dir", required=True)
    parser.add_argument("--config", required=True)
    arguments = parser.parse_args()
    try:
        request_text = sys.stdin.read(4097)
        if len(request_text) > 4096:
            raise CalendarError("validation")
        result = lookup(arguments.config, arguments.engine_dir, json.loads(request_text))
    except CalendarError as exc:
        result = {"ok": False, "errorCode": str(exc)}
    except Exception:
        result = {"ok": False, "errorCode": "configuration"}
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
