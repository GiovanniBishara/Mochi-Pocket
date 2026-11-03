"""Create pristine 2027 tabs from 2026; plan is read-only, apply is explicit."""
from __future__ import annotations

import argparse
import calendar
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import sys

from google_sheets import (EPOCH, GoogleSheets, GoogleSheetsError, WriteOutcomeUnknown,
                          atomic_json, cell_date, is_id_header, plan_booking_highlight,
                          read_json, spreadsheet_id)

YEAR = 2027
SOURCE_YEAR = "2026"
FIRST_ROW, LAST_ROW = 3, 367
MARKER_KEY = "MochiPocket annual-template"
MARKER_VALUE = "2027:v1"
MONTHS = ("Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno",
          "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre")
WHITE = {"red": 1, "green": 1, "blue": 1}
GREEN = {"red": 0, "green": 1, "blue": 0}
BACKGROUND_FIELDS = "userEnteredFormat.backgroundColor,userEnteredFormat.backgroundColorStyle"
READ_FIELDS = (
    "spreadsheetId,properties(locale,timeZone),developerMetadata,"
    "sheets(properties,merges,conditionalFormats,filterViews,basicFilter,protectedRanges,"
    "bandedRanges,charts,developerMetadata,rowGroups,columnGroups,"
    "data(startRow,startColumn,columnMetadata,rowMetadata,"
    "rowData(values(userEnteredValue,userEnteredFormat,effectiveValue,"
    "effectiveFormat(numberFormat),note,dataValidation,textFormatRuns,chipRuns,pivotTable))))"
)


def sheet_cells(sheet):
    result = {}
    for block in sheet.get("data", []):
        for offset, row in enumerate(block.get("rowData", [])):
            row_number = block.get("startRow", 0) + offset + 1
            for column_offset, cell in enumerate(row.get("values", [])):
                if cell:
                    result[(row_number, block.get("startColumn", 0) + column_offset + 1)] = cell
    return result


def _stable(value):
    ignored = {"effectiveValue", "effectiveFormat", "formattedValue", "hyperlink",
               "dataExecutionStatus", "dataExecutionState"}
    if isinstance(value, dict):
        return {key: _stable(item) for key, item in value.items() if key not in ignored}
    if isinstance(value, list):
        return [_stable(item) for item in value]
    return value


def existing_hash(document):
    """Guard all existing tabs; indices shift normally when the new tab is added."""
    sheets = []
    new_ids = {sheet["properties"]["sheetId"] for sheet in document.get("sheets", [])
               if sheet["properties"]["title"] == str(YEAR)}
    for sheet in document.get("sheets", []):
        if sheet["properties"]["title"] == str(YEAR):
            continue
        stable = _stable({key: value for key, value in sheet.items() if key != "data"})
        stable["properties"].pop("index", None)
        # Coordinate-based storage avoids volatile calculation-only cells
        # changing the returned GridData array lengths, without masking edits.
        stable["userCells"] = []
        for (row, column), cell in sorted(sheet_cells(sheet).items()):
            entered = {key: value for key, value in _stable(cell).items() if value not in ({}, [])}
            if entered:
                stable["userCells"].append([row, column, entered])
        dimensions = {"rows": {}, "columns": {}}
        for block in sheet.get("data", []):
            for key, start, kind in (("rowMetadata", "startRow", "rows"),
                                     ("columnMetadata", "startColumn", "columns")):
                for offset, value in enumerate(block.get(key, [])):
                    if value:
                        dimensions[kind][block.get(start, 0) + offset] = _stable(value)
        stable["dimensions"] = dimensions
        sheets.append(stable)
    metadata = [item for item in document.get("developerMetadata", [])
                if item.get("location", {}).get("sheetId") not in new_ids]
    content = {"sheets": sheets, "properties": _stable(document.get("properties", {})),
               "developerMetadata": _stable(metadata)}
    return hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False,
                                      separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def _sheet(document, title):
    matches = [sheet for sheet in document.get("sheets", []) if sheet.get("properties", {}).get("title") == title]
    if len(matches) != 1:
        raise GoogleSheetsError(f"Serve una sola scheda '{title}' nel documento.")
    return matches[0]


def _entered(value):
    if value is None:
        return {}
    if isinstance(value, str):
        return {"formulaValue" if value.startswith("=") else "stringValue": value}
    return {"numberValue": value}


def canonical_body():
    """Only public template labels, zero inputs and local formulas, without 2026 data."""
    rows = []
    for offset in range(365):
        date = dt.date(YEAR, 1, 1) + dt.timedelta(days=offset)
        row = FIRST_ROW + offset
        month_start = FIRST_ROW + (date.replace(day=1) - dt.date(YEAR, 1, 1)).days
        month_end = FIRST_ROW + (date.replace(day=calendar.monthrange(YEAR, date.month)[1])
                                 - dt.date(YEAR, 1, 1)).days
        values = [None] * 19
        if date.day == 1:
            values[0] = MONTHS[date.month - 1] + " '27"
        elif row == month_end:
            values[0] = f"=SUM(N{month_start}:N{month_end})+SUM(P{month_start}:P{month_end})"
        values[1] = (date - EPOCH).days if row == FIRST_ROW else f"=B{row - 1}+1"
        values[2] = "libero"
        for column in (3, 4, 7, 8, 10, 11):
            values[column] = 0
        values[12] = (date - EPOCH).days if row == FIRST_ROW else f"=M{row - 1}+1"
        values[13] = f"=D{row}+E{row}+H{row}+I{row}"
        values[14] = f"=F{row}+G{row}"
        values[15] = f"=K{row}+L{row}"
        values[16] = f"=N{row}*20%"
        if row == month_end:
            values[17] = f"=SUM(Q{month_start}:Q{month_end})"
        rows.append({"values": [{"userEnteredValue": _entered(value)} if value is not None else {}
                                for value in values]})
    return rows


def green_dates():
    holidays = {dt.date(YEAR, month, day) for month, day in
                ((1, 1), (1, 6), (4, 25), (5, 1), (6, 2), (8, 15),
                 (11, 1), (12, 8), (12, 25), (12, 26), (3, 29))}
    return {dt.date(YEAR, 1, 1) + dt.timedelta(days=offset) for offset in range(365)
            if (dt.date(YEAR, 1, 1) + dt.timedelta(days=offset)).weekday() >= 5
            or dt.date(YEAR, 1, 1) + dt.timedelta(days=offset) in holidays}


def _background_request(sheet_id, start_row, end_row, start_column, end_column, rgb):
    return {"repeatCell": {"range": {"sheetId": sheet_id, "startRowIndex": start_row,
                                    "endRowIndex": end_row, "startColumnIndex": start_column,
                                    "endColumnIndex": end_column},
                           "cell": {"userEnteredFormat": {"backgroundColorStyle": {"rgbColor": rgb}}},
                           "fields": BACKGROUND_FIELDS}}


def _highlight(sheet_id):
    return plan_booking_highlight({
        "spreadsheetId": "template", "sheetId": sheet_id, "sheetName": str(YEAR), "idColumn": "S",
        "conditionalFormats": [], "calendar": [
            {"row": FIRST_ROW + offset, "date": (dt.date(YEAR, 1, 1) + dt.timedelta(days=offset)).isoformat(),
             "guest": "libero", "krossId": "", "guestFormula": False, "idFormula": False,
             "backgrounds": {column: {} for column in "CDEFGHIJKL"}}
            for offset in range(365)]}, "S")


def _validate_source(source):
    grid = source.get("properties", {}).get("gridProperties", {})
    if source["properties"].get("sheetType", "GRID") != "GRID" or grid.get("rowCount", 0) < LAST_ROW or grid.get("columnCount", 0) < 19:
        raise GoogleSheetsError("Il modello 2026 non ha la struttura annuale attesa.")
    if grid.get("frozenRowCount", 0) != 2 or grid.get("frozenColumnCount", 0) != 2:
        raise GoogleSheetsError("Il modello 2026 deve avere due righe e due colonne bloccate.")
    cells = sheet_cells(source)
    if not is_id_header(cells.get((2, 19), {})):
        raise GoogleSheetsError("Il modello 2026 deve avere l'intestazione ID Kross in S2.")
    start = (dt.date(2026, 1, 1) - EPOCH).days
    for column, letter in ((2, "B"), (13, "M")):
        entered = cells.get((FIRST_ROW, column), {}).get("userEnteredValue", {})
        # The checked native templates retain a stale 2025 seed on the right.
        # Accept only this known anomaly; canonical 2027 regenerates both dates.
        seeds = {start} if letter == "B" else {start, (dt.date(2025, 1, 1) - EPOCH).days}
        if (set(entered) != {"numberValue"} or isinstance(entered["numberValue"], bool)
                or entered["numberValue"] not in seeds):
            raise GoogleSheetsError(f"Il modello 2026 non inizia con la data attesa in {letter}3.")
        for row in range(FIRST_ROW + 1, LAST_ROW + 1):
            if cells.get((row, column), {}).get("userEnteredValue") != {"formulaValue": f"={letter}{row - 1}+1"}:
                raise GoogleSheetsError(f"La sequenza delle date 2026 in {letter} non è quella verificata.")


def _layout(sheet):
    dimensions = {"rows": {}, "columns": {}}
    for block in sheet.get("data", []):
        for key, start, result in (("rowMetadata", "startRow", "rows"), ("columnMetadata", "startColumn", "columns")):
            for offset, value in enumerate(block.get(key, [])):
                dimensions[result][block.get(start, 0) + offset] = {
                    name: item for name, item in value.items() if name in ("pixelSize", "hiddenByUser")}
    return dimensions


def _same_value(actual, expected):
    if set(actual) != set(expected):
        return False
    if "numberValue" in expected:
        number = actual["numberValue"]
        return isinstance(number, (int, float)) and not isinstance(number, bool) and number == expected["numberValue"]
    return actual == expected


def _rgb(formatting):
    style = formatting.get("backgroundColorStyle")
    color = style.get("rgbColor") if isinstance(style, dict) else formatting.get("backgroundColor")
    if not isinstance(color, dict):
        return None
    return tuple(color.get(key, 0) for key in ("red", "green", "blue"))


def verify_pristine_year(document, target):
    """Validate only; an existing tab with any user data is never modified."""
    new = _sheet(document, str(YEAR))
    source = _sheet(document, SOURCE_YEAR)
    sheet_id = new["properties"]["sheetId"]
    if "newSheetId" in target and sheet_id != target["newSheetId"]:
        raise GoogleSheetsError("La scheda 2027 esistente ha un ID diverso dal piano.")
    markers = document.get("developerMetadata", []) + new.get("developerMetadata", [])
    marker = [item for item in markers if item.get("metadataKey") == MARKER_KEY
              and item.get("metadataValue") == MARKER_VALUE
              and item.get("location", {}).get("sheetId") == sheet_id]
    if not marker:
        raise GoogleSheetsError("La scheda 2027 esiste ma non ha il marcatore del modello: nessuna sovrascrittura.")
    if new["properties"].get("gridProperties") != source["properties"].get("gridProperties") or _layout(new) != _layout(source):
        raise GoogleSheetsError("La geometria 2027 non coincide con il modello verificato.")
    cells, source_cells = sheet_cells(new), sheet_cells(source)
    expected_rows = canonical_body()
    greens = green_dates()
    for (row, column), cell in cells.items():
        if cell.get("note") or cell.get("effectiveValue", {}).get("errorValue"):
            raise GoogleSheetsError("La scheda 2027 contiene note oppure errori di formula.")
        if row <= 2:
            if not _same_value(cell.get("userEnteredValue", {}), source_cells.get((row, column), {}).get("userEnteredValue", {})):
                raise GoogleSheetsError("Le intestazioni 2027 differiscono dal modello verificato.")
        else:
            expected = expected_rows[row - FIRST_ROW]["values"][column - 1].get("userEnteredValue", {}) \
                if FIRST_ROW <= row <= LAST_ROW and column <= 19 else {}
            if not _same_value(cell.get("userEnteredValue", {}), expected):
                raise GoogleSheetsError("La scheda 2027 contiene dati o formule diversi dal modello vuoto: nessuna sovrascrittura.")
    for offset, expected_row in enumerate(expected_rows):
        row = FIRST_ROW + offset
        date = dt.date(YEAR, 1, 1) + dt.timedelta(days=offset)
        for column, expected in enumerate(expected_row["values"], 1):
            cell = cells.get((row, column), {})
            if not _same_value(cell.get("userEnteredValue", {}), expected.get("userEnteredValue", {})):
                raise GoogleSheetsError("La scheda 2027 non ha tutte le celle canoniche del modello vuoto.")
            rgb = (0, 1, 0) if date in greens and 2 <= column <= 13 else (1, 1, 1)
            if _rgb(cell.get("userEnteredFormat", {})) != rgb:
                raise GoogleSheetsError("I colori 2027 non corrispondono al calendario vuoto.")
            if column in (2, 13) and cell_date(cell) != date:
                raise GoogleSheetsError("Le 365 date 2027 non risultano calcolate correttamente.")
            original_format = copy.deepcopy(source_cells.get((row, column), {}).get("userEnteredFormat", {}))
            new_format = copy.deepcopy(cell.get("userEnteredFormat", {}))
            for key in ("backgroundColor", "backgroundColorStyle"):
                original_format.pop(key, None)
                new_format.pop(key, None)
            if new_format != original_format:
                raise GoogleSheetsError("Font, bordi o formati numerici 2027 differiscono dal modello.")
    if not is_id_header(cells.get((2, 19), {})):
        raise GoogleSheetsError("Manca l'intestazione ID Kross in S2 nel nuovo modello.")
    if new.get("conditionalFormats", []) != []:
        raise GoogleSheetsError("Il modello 2027 deve avere colori modificabili senza regole condizionali.")
    return {"verified": True, "sheetId": sheet_id, "calendarNights": 365, "occupiedNights": 0,
            "greenDates": len(greens), "range": f"C{FIRST_ROW}:L{LAST_ROW}"}


def plan_year_document(document, target):
    source = _sheet(document, SOURCE_YEAR)
    _validate_source(source)
    identifier = spreadsheet_id(target.get("spreadsheetId", document.get("spreadsheetId", "")))
    if document.get("spreadsheetId", identifier) != identifier:
        raise GoogleSheetsError("Documento Google diverso dalla destinazione del piano.")
    source_id = source["properties"]["sheetId"]
    if target.get("sourceSheetId", source_id) != source_id:
        raise GoogleSheetsError("Il modello 2026 ha un ID diverso dal piano.")
    result = {key: copy.deepcopy(value) for key, value in target.items() if key not in ("requests", "beforeHash", "action")}
    result.update({"spreadsheetId": identifier, "sourceSheetId": source_id, "beforeHash": existing_hash(document)})
    current = [sheet for sheet in document.get("sheets", []) if sheet["properties"]["title"] == str(YEAR)]
    if current:
        result["newSheetId"] = current[0]["properties"]["sheetId"]
        verify_pristine_year(document, {**result, "newSheetId": target.get("newSheetId", result["newSheetId"])})
        result.update({"action": "alreadyExists", "requests": []})
        return result
    used = {sheet["properties"]["sheetId"] for sheet in document.get("sheets", [])}
    new_id = target.get("newSheetId", YEAR)
    if isinstance(new_id, bool) or not isinstance(new_id, int) or new_id < 0 or new_id > 2**31 - 1:
        raise GoogleSheetsError("ID della nuova scheda non valido.")
    if "newSheetId" in target and new_id in used:
        raise GoogleSheetsError("L'ID previsto per la nuova scheda è già occupato.")
    while new_id in used:
        new_id += 1
    result["newSheetId"] = new_id
    geometry = source["properties"]["gridProperties"]
    full_body = {"sheetId": new_id, "startRowIndex": 2, "endRowIndex": geometry["rowCount"],
                 "startColumnIndex": 0, "endColumnIndex": geometry["columnCount"]}
    requests = [
        {"duplicateSheet": {"sourceSheetId": source_id, "insertSheetIndex": 1,
                            "newSheetId": new_id, "newSheetName": str(YEAR)}},
        {"updateCells": {"range": full_body, "rows": [], "fields": "userEnteredValue,note"}},
        {"updateCells": {"range": {"sheetId": new_id, "startRowIndex": 0, "endRowIndex": 2,
                                   "startColumnIndex": 0, "endColumnIndex": geometry["columnCount"]},
                         "rows": [], "fields": "note"}},
        {"updateCells": {"range": {"sheetId": new_id, "startRowIndex": 2, "endRowIndex": LAST_ROW,
                                   "startColumnIndex": 0, "endColumnIndex": 19},
                         "rows": canonical_body(), "fields": "userEnteredValue"}},
        _background_request(new_id, 2, LAST_ROW, 0, 19, WHITE),
    ]
    for date in sorted(green_dates()):
        row = 2 + (date - dt.date(YEAR, 1, 1)).days
        requests.append(_background_request(new_id, row, row + 1, 1, 13, GREEN))
    requests.extend({"deleteConditionalFormatRule": {"sheetId": new_id, "index": index}}
                    for index in reversed(range(len(source.get("conditionalFormats", [])))))
    requests.append({"createDeveloperMetadata": {"developerMetadata": {
        "metadataKey": MARKER_KEY, "metadataValue": MARKER_VALUE, "visibility": "DOCUMENT",
        "location": {"sheetId": new_id}}}})
    result.update({"action": "create", "requests": requests, "calendarNights": 365,
                   "sourceGeometry": copy.deepcopy(geometry)})
    return result


def read_document(client, identifier):
    return client.api(identifier, parameters={"fields": READ_FIELDS})


def build_plan(config_path, *, client_factory=GoogleSheets):
    config_path = Path(config_path).resolve()
    config = read_json(config_path)
    targets, seen = [], set()
    for entry in config.get("calendars", []):
        if entry.get("type") != "google" or entry.get("sheetName") != SOURCE_YEAR:
            continue
        identifier = spreadsheet_id(entry["spreadsheet"])
        if identifier in seen:
            continue
        seen.add(identifier)
        target = {"name": entry["name"], "spreadsheetId": identifier,
                  "credentials": str((config_path.parent / entry["credentials"]).resolve()),
                  "token": str((config_path.parent / entry["token"]).resolve())}
        client = client_factory(target["credentials"], target["token"])
        targets.append(plan_year_document(read_document(client, identifier), target))
    if not targets:
        raise GoogleSheetsError("La configurazione non contiene modelli Google 2026 da duplicare.")
    return {"version": 1, "year": YEAR, "targets": targets}


def apply_plan(plan, *, client_factory=GoogleSheets):
    if not isinstance(plan, dict) or plan.get("version") != 1 or plan.get("year") != YEAR or not isinstance(plan.get("targets"), list) or not plan["targets"]:
        raise GoogleSheetsError("Piano di creazione 2027 non valido.")
    prepared, seen = [], set()
    # Validate every target before posting anything to any document.
    for target in plan["targets"]:
        if not isinstance(target, dict) or any(key not in target for key in
                ("spreadsheetId", "credentials", "token", "beforeHash", "newSheetId", "sourceSheetId", "requests", "action")):
            raise GoogleSheetsError("Destinazione del piano incompleta.")
        identifier = spreadsheet_id(target["spreadsheetId"])
        if identifier in seen:
            raise GoogleSheetsError("Un documento compare più volte nel piano.")
        seen.add(identifier)
        client = client_factory(target["credentials"], target["token"])
        document = read_document(client, identifier)
        if existing_hash(document) != target["beforeHash"]:
            raise GoogleSheetsError("Un foglio originale è cambiato dopo il piano: rigenerare il piano prima di creare il 2027.")
        fresh = plan_year_document(document, target)
        if fresh["action"] == "create" and (target["action"] != "create" or fresh["requests"] != target["requests"]):
            raise GoogleSheetsError("Le richieste del piano non coincidono con la creazione verificata della sola nuova scheda.")
        if fresh["action"] == "alreadyExists" and target["action"] == "alreadyExists" and target["requests"]:
            raise GoogleSheetsError("Una scheda 2027 già presente può essere soltanto verificata.")
        prepared.append((client, target, fresh))
    results = []
    for client, target, fresh in prepared:
        identifier = target["spreadsheetId"]
        # A fresh read also guards edits made while other documents were checked.
        before = read_document(client, identifier)
        if existing_hash(before) != target["beforeHash"]:
            raise GoogleSheetsError("Un foglio originale è cambiato durante la verifica: nessuna nuova richiesta inviata a questo documento.")
        latest = plan_year_document(before, target)
        created = latest["action"] == "create"
        if created:
            if latest["requests"] != target["requests"]:
                raise GoogleSheetsError("Il piano non è più applicabile: rigenerarlo.")
            client.api(identifier, body={"requests": latest["requests"], "includeSpreadsheetInResponse": False})
        try:
            after = read_document(client, identifier) if created else before
            verification = verify_pristine_year(after, target)
            if existing_hash(after) != target["beforeHash"]:
                raise GoogleSheetsError("La verifica dei fogli originali dopo la creazione non coincide.")
        except (GoogleSheetsError, KeyError, TypeError, ValueError) as exc:
            if created:
                raise WriteOutcomeUnknown("Scheda 2027 inviata ma verifica non completata: rileggere; nessuna scheda esistente verrà sovrascritta.") from exc
            raise
        results.append({"name": target.get("name"), "created": created, **verification,
                        "spreadsheetId": identifier,
                        "url": f"https://docs.google.com/spreadsheets/d/{identifier}/edit#gid={verification['sheetId']}"})
    return {"year": YEAR, "targets": results}


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    planning = commands.add_parser("plan")
    planning.add_argument("--config", type=Path, required=True)
    planning.add_argument("--output", type=Path, required=True)
    applying = commands.add_parser("apply")
    applying.add_argument("--plan", type=Path, required=True)
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "plan":
            plan = build_plan(arguments.config)
            atomic_json(arguments.output, plan)
            result = {"planPath": str(arguments.output.resolve()), "year": YEAR,
                      "targets": [{"name": item.get("name"), "action": item["action"],
                                   "sourceSheetId": item["sourceSheetId"], "newSheetId": item["newSheetId"],
                                   "requestCount": len(item["requests"])} for item in plan["targets"]]}
        else:
            result = apply_plan(read_json(arguments.plan))
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except GoogleSheetsError as exc:
        unknown = isinstance(exc, WriteOutcomeUnknown)
        print(json.dumps({"error": str(exc), "outcomeUnknown": unknown}, ensure_ascii=False), file=sys.stderr)
        return 3 if unknown else 2
    except KeyboardInterrupt:
        unknown = arguments.command == "apply"
        print(json.dumps({"error": "Operazione interrotta.", "outcomeUnknown": unknown}), file=sys.stderr)
        return 3 if unknown else 2


if __name__ == "__main__":
    raise SystemExit(main())
