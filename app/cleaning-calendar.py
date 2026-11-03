"""Read expected cleaning dates from calendar checkouts. Never write Google."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import threading


def load_module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stays_reader = load_module("mochi_cleaning_stays", Path(__file__).with_name("tourist-tax-calendar.py"))


def month_bounds(year, month):
    if (isinstance(year, bool) or not isinstance(year, int) or not 2020 <= year <= 2100
            or isinstance(month, bool) or not isinstance(month, int) or not 1 <= month <= 12):
        raise ValueError("Seleziona anno e mese validi.")
    start = dt.date(year, month, 1)
    end = dt.date(year + (month == 12), month % 12 + 1, 1)
    return start.isoformat(), end.isoformat()


def continuous_manual_extensions(snapshots):
    """A missing ID cannot create another checkout inside one continuous guest stay."""
    copied = [{**snapshot, "calendar": [dict(row) for row in snapshot["calendar"]]} for snapshot in snapshots]
    ordered = sorted((row for snapshot in copied for row in snapshot["calendar"]), key=lambda row: row["date"])
    inferred_dates, run = set(), []

    def complete_run():
        identifiers = {row.get("krossId", "").strip() for row in run if row.get("krossId", "").strip()}
        if len(identifiers) == 1:
            identifier = next(iter(identifiers))
            for row in run:
                if not row.get("krossId", "").strip():
                    row["krossId"] = identifier
                    inferred_dates.add(row["date"])

    for row in ordered:
        name = " ".join(str(row.get("guest", "")).casefold().split())
        previous_name = " ".join(str(run[-1].get("guest", "")).casefold().split()) if run else None
        if not name or name == "libero":
            complete_run()
            run = []
        elif run and (name != previous_name or stays_reader.next_day(run[-1]["date"]) != row["date"]):
            complete_run()
            run = [row]
        else:
            run.append(row)
    complete_run()
    return copied, inferred_dates


def technical_manual_block(name):
    return bool(re.match(r"^(?:lavor[oi]\s+(?:antenna|manutenzione|impiant[oi]|elettric[io]|idraulic[io]|edil[io])\b"
                         r"|manutenzione\b|blocco\s+tecnico\b|chiusura\s+tecnica\b)", name.strip(), re.I))


def cleaning_events(snapshots, initial, year, month):
    """One event per stay checkout, including checkout on the first of a quarter."""
    start, end = month_bounds(year, month)
    quarter = (month - 1) // 3 + 1
    periods = [(year, quarter)]
    if month in (1, 4, 7, 10):
        periods.append((year - 1, 4) if quarter == 1 else (year, quarter - 1))
    snapshots, inferred_dates = continuous_manual_extensions(snapshots)
    stays = {}
    for period_year, period_quarter in periods:
        for stay in stays_reader.group_stays(snapshots, initial, period_year, period_quarter):
            stays[stay["id"]] = stay
    available_years = {int(snapshot["sheetName"]) for snapshot in snapshots}
    events, uncertain, warnings = [], [], []
    if month == 1 and year - 1 not in available_years:
        warnings.append("Calendario precedente non configurato: eventuali partenze del 1° gennaio non sono verificabili.")
    for stay in stays.values():
        if not start <= stay["departure"] < end or stay.get("cancelled"):
            continue
        item = {key: stay[key] for key in ("id", "name", "arrival", "departure", "warnings")}
        if any(stay["arrival"] <= date < stay["departure"] for date in inferred_dates):
            item["warnings"].append("Notti consecutive dello stesso ospite con ID mancante: considerate come continuazione, verifica la partenza.")
        manual = any("senza ID Kross" in warning for warning in stay["warnings"])
        if manual and technical_manual_block(stay["name"]):
            item["warnings"].append("Voce tecnica del calendario: esclusa dalle pulizie previste, da controllare.")
            uncertain.append(item)
            continue
        previous_night = dt.date.fromisoformat(stay["departure"]) - dt.timedelta(days=1)
        if previous_night.month == 12 and previous_night.day == 31 and previous_night.year + 1 not in available_years:
            uncertain.append(item)
        else:
            events.append(item)
    events.sort(key=lambda item: (item["departure"], item["name"], item["id"]))
    uncertain.sort(key=lambda item: (item["departure"], item["id"]))
    return {"stays": events, "uncertain": uncertain, "warnings": warnings,
            "complete": not warnings and not uncertain}


def property_groups(config):
    if config.get("version") != 1 or not isinstance(config.get("calendars"), list):
        raise ValueError("Configurazione calendari non valida.")
    groups = {}
    for entry in config["calendars"]:
        if entry.get("type") != "google":
            continue
        name = str(entry.get("name", "")).strip()
        initial = name[:1].upper()
        if not re.fullmatch("[A-Z]", initial):
            continue
        label = re.sub(r"\s+Google.*$", "", name, flags=re.I).strip()[:100]
        groups.setdefault(initial, {"initial": initial, "name": label, "entries": []})["entries"].append(entry)
    if not groups:
        raise ValueError("Nessun calendario Google configurato.")
    return list(groups.values())


def read_property(group, year, month, config_path, client_class):
    needed_years = {str(year)} | ({str(year - 1)} if month == 1 else set())
    entries = [entry for entry in group["entries"] if str(entry.get("sheetName"))
               in needed_years]
    if sum(str(entry.get("sheetName")) == str(year) for entry in entries) != 1:
        raise ValueError("Calendario annuale non configurato o ambiguo.")
    if len({str(entry["sheetName"]) for entry in entries}) != len(entries):
        raise ValueError("Calendari annuali duplicati.")
    snapshots = []
    for entry in entries:
        client = client_class(config_path.parent / entry["credentials"], config_path.parent / entry["token"])
        snapshots.append(client.read_calendar(entry["spreadsheet"], str(entry["sheetName"]), entry.get("idColumn")))
    return cleaning_events(snapshots, group["initial"], year, month)


def read_only_client(client_class):
    """Overlap reads while serializing renewal of each shared OAuth token."""
    token_locks, locks_guard = {}, threading.Lock()

    class ReadOnlySheets(client_class):
        def access_token(self):
            key = os.path.normcase(str(self.token_path.resolve()))
            with locks_guard:
                lock = token_locks.setdefault(key, threading.Lock())
            with lock:
                return super().access_token()

        def api(self, identifier, *, parameters=None, body=None):
            if body is not None:
                raise ValueError("Il conteggio pulizie non può modificare i calendari.")
            return super().api(identifier, parameters=parameters)

    return ReadOnlySheets


def read_properties(groups, year, month, config_path, client_class, google_error):
    """At most three calendars wait on the network; output keeps config order."""
    def read_group(group):
        public = {"initial": group["initial"], "name": group["name"]}
        try:
            data = read_property(group, year, month, config_path, client_class)
            return {**public, **data, "status": "ready" if data["complete"] else "partial"}
        except Exception as error:
            auth = isinstance(error, google_error) and any(
                term in str(error).casefold() for term in ("login", "token", "http 401"))
            return {**public, "status": "error", "complete": False,
                    "error": "Google richiede un nuovo accesso. Premi Collega Google e riprova." if auth else
                    "Calendario non leggibile. Verifica il collegamento Google e la configurazione.",
                    "stays": [], "uncertain": [], "warnings": []}

    if len(groups) < 2:
        return [read_group(group) for group in groups]
    with ThreadPoolExecutor(max_workers=min(3, len(groups)), thread_name_prefix="mochi-cleaning") as pool:
        return list(pool.map(read_group, groups))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine-dir", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        request = json.loads(sys.stdin.read(16384))
        year, month = request.get("year"), request.get("month")
        month_bounds(year, month)
        groups = property_groups(json.loads(args.config.read_text(encoding="utf-8-sig")))
        google = load_module("mochi_cleaning_google", args.engine_dir / "google_sheets.py")

        properties = read_properties(groups, year, month, args.config,
                                     read_only_client(google.GoogleSheets), google.GoogleSheetsError)
        result = {"ok": True, "year": year, "month": month, "properties": properties}
    except Exception:
        result = {"ok": False, "error": "Conteggio non disponibile. Verifica mese e configurazione dei calendari."}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
