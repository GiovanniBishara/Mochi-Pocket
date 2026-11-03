"""Inspect and explicitly reapply editable yellow on one verified source booking."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sys


class ValidationError(Exception):
    pass


YELLOW = {"backgroundColorStyle": {"rgbColor": {"red": 1, "green": 1, "blue": 0}}}


def read_json(path, maximum=4 * 1024 * 1024):
    if path.stat().st_size > maximum:
        raise ValidationError("Archivio colori troppo grande. Ripeti la simulazione.")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def iso_date(value):
    try:
        return isinstance(value, str) and dt.date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def revision(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def name(value, maximum=160):
    return "".join(c for c in str(value or "") if c >= " " and c != "\x7f")[:maximum]


def latest_scope(config_path):
    config = read_json(config_path)
    if config.get("version") != 1 or not isinstance(config.get("calendars"), list):
        raise ValidationError("Configurazione Kross non disponibile.")
    local = (config_path.parent / config.get("dataDirectory", ".local")).resolve()
    reports = sorted((local / "rapporti").glob("*.json"), reverse=True)
    if not reports:
        raise ValidationError("Premi prima Simula per preparare le date da controllare.")
    report_path = reports[0]
    report = read_json(report_path, 32 * 1024 * 1024)
    if report.get("scopeMode") != "source_dates" or not isinstance(report.get("calendars"), list):
        raise ValidationError("Ripeti Simula con Mochi aggiornato prima di controllare i colori.")
    return config, local, report_path, report


def valid_scope(item, calendar):
    dates = item.get("scope", {}).get("dates")
    if (not isinstance(dates, list) or len(dates) > 366 or len(set(dates)) != len(dates)
            or any(not iso_date(value) or value[:4] != calendar["sheetName"] for value in dates)):
        raise ValidationError("Le date del riepilogo non sono valide. Ripeti Simula.")
    return sorted(dates)


def matching_binding(binding, rows, dates, booking_id):
    if (not isinstance(binding, dict) or not isinstance(binding.get("reference"), str)
            or not binding["reference"].strip() or not isinstance(binding.get("dates"), list)
            or not isinstance(binding.get("values"), dict)):
        return False
    by_date = {row["date"]: row for row in rows}
    return all(date in binding["dates"] and date in by_date
               and by_date[date].get("krossId") == booking_id
               and by_date[date].get("guest") == binding["values"].get(date)
               and not by_date[date].get("guestFormula") and not by_date[date].get("idFormula")
               for date in dates)


def inspect_colors(config_path, selection, google, *, calendar_id=None):
    """Read only. Returned private contexts remain inside this process."""
    config, local, report_path, report = latest_scope(config_path)
    calendars = {item.get("id"): item for item in config["calendars"]
                 if isinstance(item, dict) and item.get("type") == "google"}
    bookings, contexts, skipped = [], {}, 0
    for item in report["calendars"]:
        calendar = calendars.get(item.get("id")) if isinstance(item, dict) else None
        if not calendar or not calendar.get("highlightBookings"):
            continue
        initial = str(calendar.get("name", "")).strip()[:1].upper()
        if initial not in selection or (calendar_id is not None and calendar.get("id") != calendar_id):
            continue
        dates = valid_scope(item, calendar)
        if not dates:
            continue
        state = read_json(local / (calendar["id"] + ".state.json"))
        expected = {"type": "google", "target": calendar["spreadsheet"], "sheetName": calendar["sheetName"],
                    "roomName": calendar["roomName"], "idColumn": calendar["idColumn"]}
        if state.get("version") != 1 or json.loads(state.get("target", "null")) != expected:
            raise ValidationError("Il registro non corrisponde al calendario. Ripeti Simula.")
        bindings = state.get("planner", {}).get("bindings", {})
        if not isinstance(bindings, dict):
            raise ValidationError("Registro prenotazioni non valido.")
        client = google.GoogleSheets(config_path.parent / calendar["credentials"],
                                     config_path.parent / calendar["token"])
        snapshot = client.read_calendar(calendar["spreadsheet"], calendar["sheetName"],
                                        calendar["idColumn"], scope_dates=dates)
        highlight_path = local / (calendar["id"] + ".highlight.json")
        highlight = read_json(highlight_path) if highlight_path.exists() else None
        pending_path = highlight_path.with_name(highlight_path.name + ".pending.json")
        pending = read_json(pending_path, 16 * 1024 * 1024) if pending_path.exists() else None
        grouped = {}
        for row in snapshot["calendar"]:
            if row["date"] in dates and row.get("krossId"):
                grouped.setdefault(row["krossId"], []).append(row)
        for booking_id, rows in grouped.items():
            if not isinstance(booking_id, str) or not re.fullmatch(r"[\w-]{1,120}", booking_id):
                continue
            selected_dates = sorted(row["date"] for row in rows)
            binding = bindings.get(booking_id)
            if not matching_binding(binding, rows, selected_dates, booking_id):
                skipped += 1
                continue
            not_yellow = sum(any(not google.same_background(row["backgrounds"][column], YELLOW)
                                  for column in "CDEFGHIJKL") for row in rows)
            interrupted = pending and pending.get("plan", {}).get("reapply")
            interrupted = interrupted if isinstance(interrupted, dict) and interrupted.get("bookingId") == booking_id else None
            if not not_yellow and not interrupted:
                continue
            if interrupted and pending["plan"].get("scopeDates") != selected_dates:
                raise ValidationError("Un ripristino colori interrotto riguarda altre date. Riprendi il riepilogo originale.")
            canonical = {"calendarId": calendar["id"], "bookingId": booking_id, "report": report_path.name,
                         "dates": selected_dates, "binding": binding,
                         "rows": [{key: row[key] for key in ("date", "row", "guest", "krossId", "backgrounds")}
                                  for row in rows],
                         "colors": {date: highlight.get("rows", {}).get(date) for date in selected_dates} if highlight else None}
            token = interrupted["revision"] if interrupted else revision(canonical)
            if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token):
                raise ValidationError("Registro colori interrotto non valido.")
            public = {"calendarId": calendar["id"], "bookingId": booking_id, "initial": initial,
                      "year": int(calendar["sheetName"]), "reference": name(binding["reference"]),
                      "dates": selected_dates, "nonYellowNights": not_yellow, "revision": token,
                      "pending": bool(interrupted)}
            bookings.append(public)
            contexts[(calendar["id"], booking_id)] = (client, calendar, highlight_path, public, rows)
    public = {"ok": True, "sourceFile": name(Path(report.get("bookingFile", "")).name),
              "checkedAt": report.get("createdAt"), "bookings": bookings, "skipped": skipped}
    return public, contexts


def execute(config_path, request, google):
    operation = request.get("operation")
    selection = request.get("calendars", ["T", "B", "D"])
    if (not isinstance(selection, list) or not selection or len(selection) > 26
            or any(not isinstance(value, str) or not re.fullmatch(r"[A-Z]", value) for value in selection)):
        raise ValidationError("Seleziona almeno un calendario valido.")
    if operation == "audit":
        return inspect_colors(config_path, selection, google)[0]
    if (operation != "apply" or request.get("confirmed") is not True
            or not isinstance(request.get("calendarId"), str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", request["calendarId"])
            or not isinstance(request.get("bookingId"), str)
            or not re.fullmatch(r"[\w-]{1,120}", request["bookingId"])
            or not isinstance(request.get("revision"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", request["revision"])):
        raise ValidationError("Scegli una prenotazione e conferma il ripristino del giallo.")
    _audit, contexts = inspect_colors(config_path, selection, google, calendar_id=request["calendarId"])
    context = contexts.get((request["calendarId"], request["bookingId"]))
    if context is None or context[3]["revision"] != request["revision"]:
        raise ValidationError("Prenotazione o colori cambiati. Premi Controlla colori e riprova.")
    client, calendar, highlight_path, public, rows = context
    result = client.ensure_booking_highlight(calendar["spreadsheet"], calendar["sheetName"], calendar["idColumn"],
                                             highlight_path, scope_dates=public["dates"],
                                             reapply={"bookingId": public["bookingId"], "revision": public["revision"]},
                                             expected_rows=rows)
    return {"ok": True, "message": "Giallo riapplicato. Puoi modificare nuovamente i colori nel foglio.",
            "updatedCells": result["updatedCells"], "dates": public["dates"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--engine-dir", type=Path, required=True)
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.path.insert(0, str(args.engine_dir.resolve()))
    import google_sheets as google
    try:
        raw = sys.stdin.read(65537)
        if len(raw) > 65536:
            raise ValidationError("Richiesta colori non valida.")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValidationError("Richiesta colori non valida.")
        result = execute(args.config.resolve(), request, google)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ValidationError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
    except google.WriteOutcomeUnknown:
        print(json.dumps({"ok": False, "outcomeUnknown": True,
                          "error": "Verifica colori non completata. Premi Controlla colori e riprendi il ripristino della stessa prenotazione."}))
    except Exception:
        print(json.dumps({"ok": False, "error": "Controllo colori non completato. Verifica il collegamento Google e riprova."}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
