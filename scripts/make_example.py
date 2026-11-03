"""Builds the example data in examples/: three invented properties and invented bookings.

    python scripts/make_example.py

Nothing here is real: names, rooms and guests are made up, so the app can be
tried (and tested) without anyone's calendar.
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import openpyxl
from openpyxl.styles import Font, PatternFill

ROOT = Path(__file__).resolve().parents[1] / "examples"
YEAR = 2026
HOUSES = [  # name (its first letter is the shortcut), room name as Kross exports it
    ("Glicine", "Appartamento Glicine"),
    ("Lavanda", "Loft Lavanda"),
    ("Ortensia", "Casa Ortensia"),
]
BOOKINGS = [  # id, room, guest, check-in, check-out, status, channel, guests, amount, commission
    (90001, "Appartamento Glicine", "Mario Esempio", "2026-03-06", "2026-03-09", "Confermata", "Airbnb", 2, 312.0, 46.8),
    (90002, "Appartamento Glicine", "Giulia Prova", "2026-03-12", "2026-03-15", "Confermata", "Booking.com", 3, 405.0, 60.75),
    (90003, "Loft Lavanda", "John Sample", "2026-03-07", "2026-03-11", "Confermata", "Airbnb", 2, 520.0, 78.0),
    (90004, "Loft Lavanda", "Ana Ejemplo", "2026-03-20", "2026-03-22", "Cancellata", "Booking.com", 1, 0.0, 0.0),
    (90005, "Casa Ortensia", "Lea Muster", "2026-03-02", "2026-03-05", "Confermata", "Diretta", 4, 690.0, 0.0),
    (90006, "Casa Ortensia", "Paolo Fittizio", "2026-03-18", "2026-03-24", "Confermata", "Airbnb", 2, 1140.0, 171.0),
]


def calendar(path: Path) -> None:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = str(YEAR)
    ws["B1"], ws["C1"] = f"Calendario {YEAR}", ""
    ws["B2"], ws["C2"], ws["D2"] = "Data", "Ospite", "Note"
    for cell in ("B2", "C2", "D2"):
        ws[cell].font = Font(bold=True)
        ws[cell].fill = PatternFill("solid", fgColor="DCE6F2")
    day, row = dt.date(YEAR, 1, 1), 3
    while day.year == YEAR:
        ws.cell(row=row, column=2, value=day).number_format = "dd/mm/yyyy"
        row += 1
        day += dt.timedelta(days=1)
    ws.column_dimensions["B"].width = 14
    ws.column_dimensions["C"].width = 28
    wb.save(path)


def kross_export(path: Path) -> None:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Prenotazioni"
    ws.append(["ID", "Camere", "Riferimento", "Check in", "Check-out", "Stato", "Canale", "Ospiti",
               "Addebito soggiorno", "Commissioni", "Note"])
    for (bid, room, guest, cin, cout, state, channel, guests, amount, fee) in BOOKINGS:
        ws.append([bid, room, guest, dt.date.fromisoformat(cin), dt.date.fromisoformat(cout), state, channel,
                   guests, amount, fee, ""])
    for row in ws.iter_rows(min_row=2, min_col=4, max_col=5):
        for cell in row:
            cell.number_format = "dd/mm/yyyy"
    wb.save(path)


def main() -> None:
    folder = ROOT / "calendari"
    folder.mkdir(parents=True, exist_ok=True)
    calendars = []
    for name, room in HOUSES:
        calendar(folder / f"{name}.xlsx")
        calendars.append({"id": name.lower(), "name": name, "type": "excel", "file": f"{name}.xlsx",
                          "sheetName": str(YEAR), "roomName": room})
    (folder / "config.json").write_text(json.dumps({"version": 1, "calendars": calendars}, indent=2) + "\n", encoding="utf-8")
    kross_export(ROOT / "kross-export-esempio.xlsx")
    profiles = {"schemaVersion": 1, "profiles": [
        {"id": name.lower(), "label": name, "calendarInitial": name[0],
         "issuer": {"name": "Host Esempio", "taxId": "INSERIRE-CODICE-FISCALE-O-PARTITA-IVA", "taxLabel": "C.F.",
                    "address": [f"Via Esempio {i + 1}", "00000 Città (XX)", "Italia"]},
         "property": {"name": name, "address": f"Via Esempio {i + 1}", "city": "Città", "kind": "CAV"}}
        for i, (name, _) in enumerate(HOUSES)]}
    (ROOT / "receipt-profiles.json").write_text(json.dumps(profiles, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("examples/ ready")


if __name__ == "__main__":
    main()
