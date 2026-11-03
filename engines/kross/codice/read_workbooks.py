"""Read booking and calendar snapshots without changing either workbook."""

from __future__ import annotations

import argparse
import calendar as calendar_module
import datetime as dt
import json
import math
import re
import sys
from decimal import Decimal, InvalidOperation
from itertools import zip_longest
from pathlib import Path


class ReaderError(Exception):
    """A workbook cannot be used safely for the requested import."""


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ReaderError(f"Argomenti non validi: {message}")


REQUIRED_HEADERS = ("ID", "Camere", "Riferimento", "Check in", "Check-out", "Stato")
MAX_SAFE_INTEGER = 2**53 - 1
OPTIONAL_HEADERS = {
    "channel": "Canale",
    "stayAmount": "Addebito soggiorno",
    "commission": "Commissioni",
    "guestCount": "Ospiti",
    "adultCount": "Ospiti maggiorenni",
    "childCount": "Ospiti minorenni",
    "notes": "Note",
}


def is_blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def parse_money(value):
    """Accept explicit amounts without rounding or guessing ambiguous grouping."""
    if isinstance(value, bool):
        raise ValueError("valore booleano")
    if isinstance(value, (int, float, Decimal)):
        amount = Decimal(str(value))
    elif isinstance(value, str):
        number = value.strip()
        number = re.sub(r"^(?:EUR\s*|€\s*)|(?:\s*EUR|\s*€)$", "", number).strip()
        sign = ""
        if number[:1] in ("+", "-"):
            sign, number = number[0], number[1:]
        # Spaces are accepted only as properly grouped thousands separators.
        if re.search(r"[ \u00a0\u202f]", number):
            if not re.fullmatch(r"\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?", number):
                raise ValueError("raggruppamento non valido")
            number = re.sub(r"[ \u00a0\u202f]", "", number)
        if "." in number and "," in number:
            decimal, grouping = (",", ".") if number.rfind(",") > number.rfind(".") else (".", ",")
            if not re.fullmatch(r"\d{1,3}(?:" + re.escape(grouping) + r"\d{3})+"
                                + re.escape(decimal) + r"\d+", number):
                raise ValueError("separatore ambiguo")
            number = number.replace(grouping, "").replace(decimal, ".")
        elif "." in number or "," in number:
            if not re.fullmatch(r"\d+[.,]\d+", number):
                raise ValueError("numero non valido")
            if len(re.split(r"[.,]", number)[1]) == 3:
                raise ValueError("separatore decimale o delle migliaia ambiguo")
            number = number.replace(",", ".")
        elif not re.fullmatch(r"\d+", number):
            raise ValueError("numero non valido")
        amount = Decimal(sign + number)
    else:
        raise ValueError("tipo non numerico")
    if not amount.is_finite() or abs(amount) > MAX_SAFE_INTEGER:
        raise ValueError("importo non finito o numericamente non sicuro")
    result = float(amount)
    if not math.isfinite(result):
        raise ValueError("importo non finito")
    return result


def parse_count(value):
    if isinstance(value, bool):
        raise ValueError("conteggio booleano")
    if isinstance(value, str):
        if not re.fullmatch(r"\d+", value.strip()):
            raise ValueError("conteggio non intero")
        number = int(value.strip())
    elif isinstance(value, (int, float)):
        if not math.isfinite(value) or value != int(value):
            raise ValueError("conteggio non intero o non finito")
        number = int(value)
    else:
        raise ValueError("tipo del conteggio non valido")
    if not 0 <= number <= MAX_SAFE_INTEGER:
        raise ValueError("conteggio negativo o numericamente non sicuro")
    return number


def optional_booking_fields(row, headers, row_number, warnings):
    fields = {field: None for field in OPTIONAL_HEADERS}
    fields.update({"infantCount": None, "hostPayoutBeforeWithholding": None, "hostPayoutSource": None})

    def warn(message):
        warnings.append(f"Export riga {row_number}: {message}")

    for field, header in OPTIONAL_HEADERS.items():
        index = headers.get(header)
        if index is None:
            continue
        cell = row[index] if index < len(row) else None
        if cell is not None and cell.data_type in ("f", "e", "b"):
            warn(f"'{header}' contiene una formula, errore o booleano: dato opzionale ignorato.")
            continue
        value = cell.value if cell is not None else None
        if is_blank(value):
            if field == "channel":
                fields[field] = ""
            continue
        try:
            if field in ("stayAmount", "commission"):
                fields[field] = parse_money(value)
            elif field.endswith("Count"):
                fields[field] = parse_count(value)
            elif not isinstance(value, str):
                raise ValueError("valore non testuale")
            else:
                fields[field] = value.strip() if field == "channel" else value
        except (ValueError, InvalidOperation, OverflowError):
            warn(f"'{header}' non valido: dato opzionale ignorato.")

    notes = fields["notes"]
    has_count_marker = isinstance(notes, str) and any(marker in notes for marker in ("Adulti:", "Bambini:", "Neonati:"))
    if has_count_marker:
        # Airbnb can count guests either with or without infants. Both forms
        # are checked against the aggregate instead of inventing adult counts.
        matches = list(re.finditer(r"(?m)^[ \t]*Adulti:[ \t]*(\d+)[ \t]+Bambini:[ \t]*(\d+)"
                                   r"[ \t]+Neonati:[ \t]*(\d+)[ \t]*$", notes))
        counts = None
        if len(matches) == 1 and all(notes.count(marker) == 1 for marker in ("Adulti:", "Bambini:", "Neonati:")):
            candidate = tuple(int(value) for value in matches[0].groups())
            guests = fields["guestCount"]
            if all(value <= MAX_SAFE_INTEGER for value in candidate) and guests is not None:
                if candidate[0] + candidate[1] + candidate[2] == guests:
                    counts = candidate
                elif (fields["channel"] or "").casefold() == "airbnb" and candidate[0] + candidate[1] == guests:
                    counts = candidate
        fields.update({"adultCount": None, "childCount": None, "infantCount": None})
        if counts is None:
            warn("conteggi adulti/bambini/neonati nelle Note incompleti o incoerenti con Ospiti: conservato solo il totale affidabile.")
        else:
            fields.update(dict(zip(("adultCount", "childCount", "infantCount"), counts)))
    else:
        adults, children, guests = fields["adultCount"], fields["childCount"], fields["guestCount"]
        if adults is None or children is None or guests is None or adults + children != guests:
            # Kross often leaves both age columns at zero until guest details
            # are entered. This means unavailable detail, not an inconsistency.
            unavailable_defaults = guests is not None and guests > 0 and adults == 0 and children == 0
            if not unavailable_defaults and (adults is not None or children is not None):
                warn("conteggi maggiorenni/minorenni non verificabili rispetto a Ospiti: conservato solo il totale affidabile.")
            fields.update({"adultCount": None, "childCount": None})

    if (fields["channel"] or "").casefold() == "airbnb" and isinstance(notes, str):
        marker = "Cancellation payout:"
        occurrences = notes.count(marker)
        if occurrences:
            match = re.search(r"(?m)^[ \t]*Cancellation payout:[ \t]*([^\r\n]+?)[ \t]+EUR[ \t]*$", notes)
            try:
                if occurrences != 1 or match is None:
                    raise ValueError("marker non univoco o non valido")
                payout = parse_money(match.group(1))
                if payout <= 0:
                    raise ValueError("payout non positivo")
                fields["hostPayoutBeforeWithholding"] = payout
                fields["hostPayoutSource"] = "notes_cancellation_payout"
            except (ValueError, InvalidOperation, OverflowError):
                warn("Cancellation payout nelle Note non univoco, non valido o non positivo: importo ignorato.")
    return fields


def parse_date(value, location):
    if isinstance(value, dt.datetime):
        if value.time() != dt.time():
            raise ReaderError(f"{location}: la data contiene un orario inatteso.")
        return value.date()
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str):
        formats = (
            (r"\d{2}/\d{2}/\d{4}", "%d/%m/%Y"),
            (r"\d{4}-\d{2}-\d{2}", "%Y-%m-%d"),
        )
        for pattern, date_format in formats:
            if re.fullmatch(pattern, value):
                try:
                    return dt.datetime.strptime(value, date_format).date()
                except ValueError:
                    break
    raise ReaderError(f"{location}: data non valida; usare gg/mm/aaaa o aaaa-mm-gg.")


def booking_id(value, location):
    if isinstance(value, bool) or is_blank(value):
        raise ReaderError(f"{location}: ID prenotazione mancante o non valido.")
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not value.is_integer():
            raise ReaderError(f"{location}: l'ID numerico non è un intero.")
        return str(int(value))
    if isinstance(value, str):
        return value.strip()
    raise ReaderError(f"{location}: ID prenotazione di tipo non supportato.")


def id_column_index(column):
    if column is None:
        return None
    if not isinstance(column, str) or not re.fullmatch(r"[A-Z]{1,3}", column):
        raise ReaderError("Colonna ID non valida: usare lettere maiuscole da D a XFD.")
    index = 0
    for character in column:
        index = index * 26 + ord(character) - ord('A') + 1
    if not 4 <= index <= 16384:
        raise ReaderError("Colonna ID non valida: deve essere da D a XFD, senza spostare date e ospiti.")
    return index


def calendar_id(value, location, data_type=None):
    if data_type in ("f", "e", "b") or isinstance(value, bool):
        raise ReaderError(f"{location}: ID Kross con formula, errore o valore booleano non consentito.")
    if is_blank(value):
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        if abs(value) > MAX_SAFE_INTEGER or not math.isfinite(value) or not value == int(value):
            raise ReaderError(f"{location}: ID Kross numerico non intero o fuori dall'intervallo sicuro.")
        return str(int(value))
    raise ReaderError(f"{location}: ID Kross di tipo non supportato.")


def is_id_header(value):
    return isinstance(value, str) and re.sub(r'[.\s]+', '', value).casefold() == 'idkross'


def load_workbook(openpyxl, path, *, data_only):
    try:
        return openpyxl.load_workbook(path, read_only=True, data_only=data_only)
    except Exception as exc:
        raise ReaderError(
            f"Impossibile leggere il file '{path}': {type(exc).__name__}: {exc}"
        ) from exc


def input_path(path, label):
    try:
        # Reading a supplied file does not require resolving its reparse points;
        # Windows sandboxes may allow the file but deny that metadata operation.
        resolved = path.expanduser().absolute()
        is_file = resolved.is_file()
    except (OSError, RuntimeError) as exc:
        raise ReaderError(f"{label}: percorso non accessibile: {path}.") from exc
    if not is_file or resolved.suffix.lower() != ".xlsx":
        raise ReaderError(f"{label}: indicare un file Excel .xlsx esistente: {path}.")
    return resolved


def read_bookings(openpyxl, path, warnings):
    workbook = load_workbook(openpyxl, path, data_only=False)
    try:
        sheet = workbook.active
        if sheet is None:
            raise ReaderError("L'export delle prenotazioni non contiene fogli.")
        sheet.reset_dimensions()
        rows = sheet.iter_rows()
        header_row = next(rows, ())
        headers = {}
        for index, cell in enumerate(header_row):
            if is_blank(cell.value):
                continue
            if cell.data_type == "f":
                raise ReaderError(f"Export {sheet.title}!{cell.coordinate}: intestazione con formula.")
            header = str(cell.value).strip()
            if header in headers:
                raise ReaderError(f"Export: intestazione duplicata '{header}'.")
            headers[header] = index
        missing = [header for header in REQUIRED_HEADERS if header not in headers]
        if missing:
            raise ReaderError("Export: intestazioni obbligatorie mancanti: " + ", ".join(missing) + ".")
        if "Canale" not in headers:
            warnings.append("Export: intestazione opzionale 'Canale' assente; provenienza delle prenotazioni non disponibile.")

        result = []
        seen_ids = {}
        for row_number, row in enumerate(rows, start=2):
            if all(is_blank(cell.value) for cell in row):
                continue
            required_cells = {}
            for header in REQUIRED_HEADERS:
                index = headers[header]
                cell = row[index] if index < len(row) else None
                if cell is not None and cell.data_type == "f":
                    raise ReaderError(f"Export riga {row_number}, {header}: formule non consentite.")
                required_cells[header] = cell.value if cell is not None else None

            identifier = booking_id(required_cells["ID"], f"Export riga {row_number}")
            if identifier in seen_ids:
                raise ReaderError(
                    f"Export: ID prenotazione duplicato alle righe {seen_ids[identifier]} e {row_number}."
                )
            seen_ids[identifier] = row_number
            for header in ("Camere", "Stato"):
                if not isinstance(required_cells[header], str) or is_blank(required_cells[header]):
                    raise ReaderError(f"Export riga {row_number}: campo '{header}' mancante o non testuale.")

            reference = required_cells["Riferimento"]
            if is_blank(reference):
                reference = "Prenotazione " + identifier
                warnings.append(
                    f"Export riga {row_number}: Riferimento vuoto; usata l'etichetta 'Prenotazione {identifier}'."
                )
            elif not isinstance(reference, str):
                raise ReaderError(f"Export riga {row_number}: Riferimento non testuale.")

            check_in = parse_date(required_cells["Check in"], f"Export riga {row_number}, Check in")
            check_out = parse_date(required_cells["Check-out"], f"Export riga {row_number}, Check-out")
            if check_out <= check_in:
                raise ReaderError(f"Export riga {row_number}: il check-out deve seguire il check-in.")
            if (check_out - check_in).days > 3660:
                raise ReaderError(f"Export riga {row_number}: soggiorno superiore a 3660 notti.")
            result.append(
                {
                    "id": identifier,
                    "room": required_cells["Camere"],
                    "reference": reference,
                    "checkIn": check_in.isoformat(),
                    "checkOut": check_out.isoformat(),
                    "status": required_cells["Stato"],
                    **optional_booking_fields(row, headers, row_number, warnings),
                }
            )
        if not result:
            warnings.append("L'export non contiene prenotazioni.")
        return result
    finally:
        workbook.close()


def read_calendar(openpyxl, path, sheet_name, warnings, id_column=None):
    if not re.fullmatch(r"\d{4}", sheet_name) or not 1 <= int(sheet_name) <= 9999:
        raise ReaderError("Il foglio calendario deve avere come nome un anno a quattro cifre.")
    year = int(sheet_name)
    id_index = id_column_index(id_column)
    cached = load_workbook(openpyxl, path, data_only=True)
    formulas = None
    try:
        formulas = load_workbook(openpyxl, path, data_only=False)
        sheet_names = cached.sheetnames
        if sheet_name not in sheet_names:
            raise ReaderError(f"Calendario: il foglio '{sheet_name}' non esiste.")
        values_sheet = cached[sheet_name]
        formulas_sheet = formulas[sheet_name]
        values_sheet.reset_dimensions()
        formulas_sheet.reset_dimensions()

        result = []
        invalid_rows = []
        seen_dates = {}
        outside_year = 0
        id_headers = []
        if id_index is None:
            values_rows = values_sheet.iter_rows(min_col=2, max_col=3)
            formula_rows = formulas_sheet.iter_rows(min_col=2, max_col=3)
        else:
            # Read all header columns so a second ID header cannot be silently
            # accepted just because it falls outside the configured column.
            values_rows = values_sheet.iter_rows(min_col=1)
            formula_rows = formulas_sheet.iter_rows(min_col=1)
        for row_number, (value_row, formula_row) in enumerate(
            zip_longest(values_rows, formula_rows), start=1
        ):
            if value_row is None or formula_row is None:
                raise ReaderError("Calendario: le letture delle date e delle formule non coincidono.")
            if id_index is None:
                date_cell, guest_cell = value_row
                formula_date, formula_guest = formula_row
            else:
                def at(row, index):
                    return row[index - 1] if index <= len(row) else None
                date_cell, guest_cell = at(value_row, 2), at(value_row, 3)
                formula_date, formula_guest = at(formula_row, 2), at(formula_row, 3)
                if date_cell is None or guest_cell is None or formula_date is None or formula_guest is None:
                    invalid_rows.append(row_number)
                    continue
                if not result:
                    for index, (cached_cell, formula_cell) in enumerate(zip_longest(value_row, formula_row), start=1):
                        candidates = [cell.value for cell in (cached_cell, formula_cell) if cell is not None]
                        if any(is_id_header(item) for item in candidates):
                            if formula_cell is None or formula_cell.data_type == "f":
                                raise ReaderError(f"Calendario riga {row_number}: intestazione ID Kross con formula non consentita.")
                            id_headers.append((row_number, index))
            if formula_date.data_type == "f" and is_blank(date_cell.value):
                if openpyxl.styles.numbers.is_date_format(formula_date.number_format):
                    raise ReaderError(
                        f"Calendario {sheet_name}!B{row_number}: formula data senza valore salvato; "
                        "aprire e ricalcolare il foglio, poi esportarlo nuovamente."
                    )
            try:
                date = parse_date(date_cell.value, f"Calendario {sheet_name}!B{row_number}")
            except ReaderError:
                invalid_rows.append(row_number)
                continue
            if date.year != year:
                outside_year += 1
                invalid_rows.append(row_number)
                continue
            date_iso = date.isoformat()
            if date_iso in seen_dates:
                raise ReaderError(
                    f"Calendario: data duplicata {date_iso} alle righe "
                    f"{seen_dates[date_iso]} e {row_number}."
                )
            seen_dates[date_iso] = row_number
            if formula_guest.data_type == "f":
                raise ReaderError(
                    f"Calendario {sheet_name}!C{row_number}: la cella ospite contiene una formula; "
                    "l'importazione non può sovrascriverla."
                )
            if not is_blank(guest_cell.value) and not isinstance(guest_cell.value, str):
                raise ReaderError(f"Calendario {sheet_name}!C{row_number}: ospite non testuale.")
            snapshot = {
                    "row": row_number,
                    "date": date_iso,
                    "guest": guest_cell.value if guest_cell.value is not None else "",
                }
            if id_index is not None:
                formula_id = at(formula_row, id_index)
                snapshot["krossId"] = calendar_id(
                    formula_id.value if formula_id is not None else None,
                    f"Calendario {sheet_name}!{id_column}{row_number}",
                    formula_id.data_type if formula_id is not None else None,
                )
                snapshot["idFormula"] = False
            result.append(snapshot)

        if not result:
            raise ReaderError(f"Calendario: nessuna data valida dell'anno {year} nel foglio '{sheet_name}'.")
        first_row, last_row = result[0]["row"], result[-1]["row"]
        if id_index is not None and (len(id_headers) != 1 or id_headers[0][1] != id_index):
            raise ReaderError(f"Calendario: intestazione ID Kross assente, duplicata o fuori dalla colonna {id_column}.")
        if id_index is not None and id_headers[0][0] >= first_row:
            raise ReaderError(f"Calendario: l'intestazione ID Kross in {id_column} deve precedere la prima data.")
        invalid_main_rows = [row for row in invalid_rows if first_row <= row <= last_row]
        if invalid_main_rows:
            coordinates = ", ".join(f"B{row}" for row in invalid_main_rows[:10])
            raise ReaderError(f"Calendario: date mancanti o non valide nelle righe del calendario: {coordinates}.")

        expected_dates = {
            dt.date(year, month, day).isoformat()
            for month in range(1, 13)
            for day in range(1, calendar_module.monthrange(year, month)[1] + 1)
        }
        missing_dates = sorted(expected_dates.difference(seen_dates))
        if missing_dates:
            preview = ", ".join(missing_dates[:10])
            raise ReaderError(
                f"Calendario incompleto: attese {len(expected_dates)} date univoche dell'anno {year}; "
                f"trovate {len(result)}. Date mancanti: {preview}."
            )
        if outside_year:
            warnings.append(f"Calendario: ignorate {outside_year} date esterne all'anno {year}.")
        return result, sheet_names
    finally:
        cached.close()
        if formulas is not None:
            formulas.close()


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    try:
        parser = ArgumentParser(description=__doc__)
        parser.add_argument("--bookings", type=Path, required=True)
        parser.add_argument("--calendar", type=Path)
        parser.add_argument("--bookings-only", action="store_true")
        parser.add_argument("--sheet", default="2026")
        parser.add_argument("--id-column")
        arguments = parser.parse_args(argv)
        if not arguments.bookings_only and arguments.calendar is None:
            raise ReaderError("Manca --calendar; usare --bookings-only per leggere soltanto l'export.")
        try:
            import openpyxl
        except ImportError as exc:
            raise ReaderError("Manca openpyxl: avviare lo script con il runtime Python predisposto.") from exc
        warnings = []
        bookings = read_bookings(openpyxl, input_path(arguments.bookings, "Export"), warnings)
        result = {"bookings": bookings, "structuralWarnings": warnings}
        if not arguments.bookings_only:
            calendar_rows, sheet_names = read_calendar(
                openpyxl, input_path(arguments.calendar, "Calendario"), arguments.sheet, warnings, arguments.id_column
            )
            result.update({"calendar": calendar_rows, "sheets": sheet_names})
        print(
            json.dumps(
                result,
                ensure_ascii=False,
                allow_nan=False,
            )
        )
        return 0
    except ReaderError as exc:
        print(f"Errore: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Errore di lettura: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
