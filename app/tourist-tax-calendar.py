"""Read calendar stays for manual fiscal confirmation; never modify Google."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import unicodedata


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:32]


def next_day(value):
    return (dt.date.fromisoformat(value) + dt.timedelta(days=1)).isoformat()


def fiscal_fingerprint(item):
    return digest({key: item.get(key, False if key == "cancelled" else None)
                   for key in ("id", "initial", "name", "arrival", "departure", "channel", "cancelled")})


def guest_breakdown(booking):
    """An unverified display suggestion; notes and ages never leave this reader."""
    maximum = 2 ** 53 - 1
    def count(value):
        return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= maximum
    total = booking.get("guestCount")
    if not count(total) or total <= 0:
        return None, None
    notes = booking.get("notes")
    notes = notes.replace("\r\n", "\n").replace("\r", "\n") if isinstance(notes, str) else ""
    italian = any(marker in notes for marker in ("Adulti:", "Bambini:", "Neonati:"))
    adult, child, infant = booking.get("adultCount"), booking.get("childCount"), booking.get("infantCount")
    if infant is None:
        infant = 0
    if all(count(value) for value in (adult, child, infant)) and adult + child + infant == total:
        return {"adults": adult, "minors": child + infant, "basis": "notes" if italian else "kross"}, None
    if italian:
        return None, "Conteggi ospiti nelle note incompleti o incoerenti: verifica le fasce d’età."
    adult_markers = re.findall(r"\badult\s*:", notes, re.I)
    child_markers = re.findall(r"\bchild\s*:", notes, re.I)
    if not adult_markers and not child_markers:
        return None, None
    adults = re.findall(r"^[ \t]*adult:[ \t]*(\d+)[ \t]*$", notes, re.I | re.M)
    children = re.findall(r"^[ \t]*child:[ \t]*(\d+)[ \t]+age:[ \t]*(\d+)[ \t]*$", notes, re.I | re.M)
    if len(adults) != 1 or len(adult_markers) != 1 or len(children) != len(child_markers):
        return None, "Conteggi ospiti nelle note incompleti o incoerenti: verifica le fasce d’età."
    adults = int(adults[0])
    children = [(int(amount), int(age)) for amount, age in children]
    if (not count(adults) or any(not count(amount) or not 0 <= age <= 130 for amount, age in children)
            or adults + sum(amount for amount, _age in children) != total):
        return None, "Conteggi ospiti nelle note incompleti o incoerenti: verifica le fasce d’età."
    return {"adults": adults + sum(amount for amount, age in children if age >= 18),
            "minors": sum(amount for amount, age in children if age < 18), "basis": "notes"}, None


def export_stays(bookings, entry, initial, year, quarter):
    def normalized(value):
        return " ".join("".join(character for character in unicodedata.normalize("NFD", str(value or ""))
                                if unicodedata.category(character) != "Mn").lower().split())
    start = dt.date(year, (quarter - 1) * 3 + 1, 1).isoformat()
    end = dt.date(year + (quarter == 4), quarter * 3 % 12 + 1, 1).isoformat()
    room = normalized(entry["roomName"])
    results = []
    for booking in bookings:
        if normalized(booking["room"]) != room or booking["checkIn"] >= end or booking["checkOut"] <= start:
            continue
        status = normalized(booking["status"])
        if status not in ("confermata", "cancellata", "cancellato", "annullata"):
            continue
        cancelled = status != "confermata"
        raw_channel = normalized(booking.get("channel"))
        channel = "Airbnb" if raw_channel in ("airbnb", "airbnb.com") else "Booking" if raw_channel in ("booking", "booking.com") else "Diretta" if raw_channel in ("", "frontoffice", "diretta", "manuale", "sito", "telefono", "direct") else str(booking.get("channel") or "")
        item = {"id": digest([initial, ("id", booking["id"]), 0]), "initial": initial,
                "name": booking["reference"].strip(), "arrival": booking["checkIn"], "departure": booking["checkOut"],
                "channel": channel, "guestCount": booking.get("guestCount"), "cancelled": cancelled,
                "warnings": ["Prenotazione cancellata nell'export: verifica il soggiorno e, se non effettuato, escludilo."] if cancelled else []}
        breakdown, warning = guest_breakdown(booking)
        if breakdown is not None:
            item["guestBreakdown"] = breakdown
        if warning:
            item["warnings"].append(warning)
        item["sourceFingerprint"] = fiscal_fingerprint(item)
        results.append(item)
    return results


def group_stays(snapshots, initial, year, quarter):
    start = dt.date(year, (quarter - 1) * 3 + 1, 1).isoformat()
    end = dt.date(year + (quarter == 4), quarter * 3 % 12 + 1, 1).isoformat()
    all_rows, available_years = [], set()
    for snapshot in snapshots:
        available_years.add(int(snapshot["sheetName"]))
        for row in snapshot["calendar"]:
            all_rows.append({**row, "document": snapshot["spreadsheetId"]})
    all_rows.sort(key=lambda row: row["date"])
    seen_dates, groups, last = set(), [], None
    for row in all_rows:
        date = row["date"]
        if date in seen_dates:
            raise ValueError("Date duplicate nei calendari della struttura.")
        seen_dates.add(date)
        name = str(row.get("guest", "")).strip()
        if not name or name.casefold() == "libero":
            last = None
            continue
        booking = row.get("krossId", "").strip()
        owner = ("id", booking) if booking else ("manual", name.casefold())
        if last is None or last["owner"] != owner or next_day(last["rows"][-1]["date"]) != date:
            last = {"owner": owner, "rows": []}
            groups.append(last)
        last["rows"].append(row)
    owner_counts = {}
    results = []
    for group in groups:
        rows = group["rows"]
        arrival, departure = rows[0]["date"], next_day(rows[-1]["date"])
        owner = group["owner"]
        index = owner_counts.get(owner, 0)
        owner_counts[owner] = index + 1
        if arrival >= end or departure <= start:
            continue
        warnings = []
        first_year, last_year = int(arrival[:4]), int(rows[-1]["date"][:4])
        if arrival.endswith("-01-01") and first_year - 1 not in available_years:
            warnings.append("Il soggiorno tocca l'inizio del calendario: verifica l'arrivo effettivo e le notti precedenti.")
        if rows[-1]["date"].endswith("-12-31") and last_year + 1 not in available_years:
            warnings.append("Il soggiorno tocca la fine del calendario: verifica la partenza effettiva.")
        names = {row["guest"].strip() for row in rows}
        if len(names) > 1:
            warnings.append("Il nome cambia nel soggiorno: verifica che gli ospiti e le date siano corretti.")
        if owner[0] == "manual":
            warnings.append("Soggiorno riconosciuto dal nome, senza ID Kross: controlla le date e gli eventuali soggiorni consecutivi.")
        descriptions = [str(row.get("cells", {}).get("J", {}).get("value") or "") for row in rows]
        channel = next(("Airbnb" if re.search(r"\bairbnb\b", value, re.I) else
                        "Booking" if re.search(r"\bbooking\b", value, re.I) else
                        "Diretta" if re.search(r"\bdirett[ao]\b", value, re.I) else None
                        for value in descriptions if re.search(r"\bairbnb\b|\bbooking\b|\bdirett[ao]\b", value, re.I)), None)
        guest_count = None
        for value in descriptions:
            total = re.search(r"\b(\d+)\s+ospit[ei]\b", value, re.I)
            if total:
                guest_count = int(total[1])
                break
        identifier = digest([initial, owner, index if owner[0] == "id" else arrival])
        item = {"id": identifier, "initial": initial, "name": rows[0]["guest"].strip(),
                "arrival": arrival, "departure": departure, "channel": channel,
                "guestCount": guest_count, "warnings": warnings, "cancelled": False}
        item["sourceFingerprint"] = fiscal_fingerprint(item)
        results.append(item)
    return results


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-dir", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--export", type=Path)
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    stage = "input"
    try:
        request = json.loads(sys.stdin.read(16384))
        initial, year, quarter = request.get("initial"), request.get("year"), request.get("quarter")
        if (not isinstance(initial, str) or not re.fullmatch("[A-Z]", initial)
                or isinstance(year, bool) or not isinstance(year, int) or not 2020 <= year <= 2100
                or isinstance(quarter, bool) or quarter not in (1, 2, 3, 4)):
            raise ValueError("Seleziona struttura, anno e trimestre validi.")
        stage = "engine"
        spec = importlib.util.spec_from_file_location("mochi_tax_google", args.engine_dir / "google_sheets.py")
        google = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(google)

        class ReadOnlySheets(google.GoogleSheets):
            def api(self, identifier, *, parameters=None, body=None):
                if body is not None:
                    raise ValueError("La lettura per i rendiconti non può modificare i calendari.")
                return super().api(identifier, parameters=parameters)

        stage = "configuration"
        config = json.loads(args.config.read_text(encoding="utf-8-sig"))
        if config.get("version") != 1 or not isinstance(config.get("calendars"), list):
            raise ValueError("Configurazione calendari non valida.")
        entries = [entry for entry in config["calendars"] if entry.get("type") == "google"
                   and str(entry.get("name", "")).strip().upper().startswith(initial)
                   and str(entry.get("sheetName", "")) in {str(year - 1), str(year), str(year + 1)}]
        if sum(entry["sheetName"] == str(year) for entry in entries) != 1:
            raise ValueError("Calendario annuale non configurato o ambiguo per questa struttura.")
        if len({entry["sheetName"] for entry in entries}) != len(entries):
            raise ValueError("Più calendari configurati per lo stesso anno.")
        if args.export is not None:
            stage = "export"
            import openpyxl
            reader_spec = importlib.util.spec_from_file_location("mochi_tax_export", args.engine_dir / "read_workbooks.py")
            reader = importlib.util.module_from_spec(reader_spec)
            reader_spec.loader.exec_module(reader)
            bookings = reader.read_bookings(openpyxl, reader.input_path(args.export, "Export"), [])
            entry = next(entry for entry in entries if entry["sheetName"] == str(year))
            print(json.dumps({"ok": True, "stays": export_stays(bookings, entry, initial, year, quarter)}, ensure_ascii=False))
            return 0
        snapshots = []
        stage = "google_read"
        for entry in entries:
            client = ReadOnlySheets(args.config.parent / entry["credentials"], args.config.parent / entry["token"])
            snapshots.append(client.read_calendar(entry["spreadsheet"], entry["sheetName"], entry.get("idColumn")))
        stage = "grouping"
        result = {"ok": True, "stays": group_stays(snapshots, initial, year, quarter)}
    except Exception as error:
        # Never expose guest cells, notes, credentials or raw HTTP errors.
        result = {"ok": False, "errorCode": stage + ":" + type(error).__name__,
                  "error": "Non riesco a leggere i soggiorni. Verifica Google e la configurazione dei calendari."}
        if stage == "google_read" and isinstance(error, google.GoogleSheetsError):
            message = str(error).casefold()
            if any(term in message for term in ("login", "token", "http 401")):
                result.update({"errorCode": "google_auth",
                               "error": "Google richiede un nuovo accesso. Apri Impostazioni e premi Collega Google, poi ripeti la lettura."})
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
