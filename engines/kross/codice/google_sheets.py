"""Optional Google Sheets adapter; authentication starts only with `login`."""

from __future__ import annotations

import argparse
import base64
import calendar
import copy
import datetime as dt
import hashlib
import http.server
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

# Receipt/status helpers also load this adapter by absolute file path, without
# adding the engine directory to sys.path. Resolve its sibling the same way.
_highlight_spec = importlib.util.spec_from_file_location(
    "kross_manual_highlight", Path(__file__).with_name("manual_highlight.py"))
_highlight = importlib.util.module_from_spec(_highlight_spec)
_highlight_spec.loader.exec_module(_highlight)
HIGHLIGHT_COLUMNS = _highlight.COLUMNS
background = _highlight.background
background_request = _highlight.background_request
plan_manual_highlight = _highlight.plan_manual_highlight
same_background = _highlight.same_background


SCOPE = "https://www.googleapis.com/auth/spreadsheets"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
API_URL = "https://sheets.googleapis.com/v4/spreadsheets/"
EPOCH = dt.date(1899, 12, 30)
MAX_SAFE_INTEGER = 2**53 - 1
BOOKING_HIGHLIGHT_TAG = "MochiPocket prenotazioni"
BOOKING_HIGHLIGHT_TRANSACTION_KEY = "MochiPocket colori transazione"
BOOKING_DETAIL_COLUMNS = {"D": 3, "J": 9, "K": 10}


class GoogleSheetsError(Exception):
    """An authentication, validation or API failure safe to print."""


class WriteOutcomeUnknown(GoogleSheetsError):
    """A write may have reached Google; do not blindly repeat or commit state."""


def default_auth_directory():
    return Path(__file__).resolve().parent.parent / "Google"


def read_json(path):
    try:
        with Path(path).open(encoding="utf-8-sig") as source:
            return json.load(source)
    except (OSError, ValueError) as exc:
        raise GoogleSheetsError(f"File JSON non leggibile: {path}.") from exc


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".kross-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            json.dump(value, target, ensure_ascii=False, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def windows_protect(data, *, decrypt=False):
    """DPAPI binds a token file to the current Windows user, with no UI."""
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("length", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if decrypt:
        operation = crypt.CryptUnprotectData
        operation.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                              ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD,
                              ctypes.POINTER(Blob)]
        arguments = (ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output))
    else:
        operation = crypt.CryptProtectData
        operation.argtypes = [ctypes.POINTER(Blob), wintypes.LPCWSTR, ctypes.c_void_p,
                              ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD,
                              ctypes.POINTER(Blob)]
        arguments = (ctypes.byref(source), "MochiPocket Google", None, None,
                     None, 1, ctypes.byref(output))
    operation.restype = wintypes.BOOL
    if not operation(*arguments):
        raise GoogleSheetsError("Impossibile proteggere o leggere il token con l'utente Windows corrente.")
    try:
        return ctypes.string_at(output.data, output.length)
    finally:
        kernel.LocalFree(output.data)


def save_token(path, token):
    if os.name == "nt":
        protected = windows_protect(json.dumps(token).encode("utf-8"))
        atomic_json(path, {"version": 1, "protection": "windows-dpapi",
                           "data": base64.b64encode(protected).decode("ascii")})
    else:
        atomic_json(path, {"version": 1, "protection": "user-file", "token": token})
        os.chmod(path, 0o600)


def load_token(path):
    if not Path(path).is_file():
        raise GoogleSheetsError("Google non collegato: eseguire prima il comando login esplicito.")
    value = read_json(path)
    try:
        if not isinstance(value, dict) or value.get("version") != 1:
            raise ValueError()
        if value.get("protection") == "windows-dpapi" and os.name == "nt":
            token = json.loads(windows_protect(base64.b64decode(value["data"], validate=True), decrypt=True))
        elif value.get("protection") == "user-file" and os.name != "nt":
            token = value["token"]
        else:
            raise ValueError()
        if (not isinstance(token, dict) or not isinstance(token.get("scope", ""), str)
                or not isinstance(token.get("expires_at", 0), (int, float))
                or any(key in token and not isinstance(token[key], str)
                       for key in ("client_id", "access_token", "refresh_token"))):
            raise ValueError()
        return token
    except (KeyError, ValueError, TypeError) as exc:
        raise GoogleSheetsError("Token locale non valido: eseguire nuovamente login.") from exc


def request_json(url, *, method="GET", body=None, headers=None, writing=False):
    request = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
            if not isinstance(result, dict):
                raise ValueError("Invalid JSON response shape")
            return result
    except urllib.error.HTTPError as exc:
        # Never print the response body: it may include request details or tokens.
        if writing and exc.code >= 500:
            raise WriteOutcomeUnknown("Google ha restituito un errore dopo l'invio: rileggere il calendario prima di recuperare l'importazione.") from exc
        suggestions = {401: "Rieseguire login.", 403: "Verificare API abilitata e permessi di modifica del foglio.",
                       404: "Verificare ID del foglio e account Google scelto.",
                       429: "Attendere prima di riprovare."}
        suggestion = "Rieseguire login e verificare il client OAuth." if url == TOKEN_URL and exc.code == 400 else suggestions.get(exc.code, "")
        raise GoogleSheetsError(f"Richiesta Google non riuscita (HTTP {exc.code}). {suggestion}".strip()) from exc
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        if writing:
            raise WriteOutcomeUnknown("Esito della scrittura Google sconosciuto: rileggere il calendario prima di recuperare l'importazione.") from exc
        raise GoogleSheetsError("Impossibile completare la richiesta Google: verificare la connessione e riprovare.") from exc


def load_credentials(path):
    if not Path(path).is_file():
        raise GoogleSheetsError("Google non configurato: predisporre credentials.json e usare login solo quando si vuole collegare il calendario online.")
    value = read_json(path)
    installed = value.get("installed") if isinstance(value, dict) else None
    if not isinstance(installed, dict) or not isinstance(installed.get("client_id"), str):
        raise GoogleSheetsError("credentials.json deve contenere un client OAuth di tipo App desktop.")
    if not installed["client_id"].endswith(".apps.googleusercontent.com"):
        raise GoogleSheetsError("Client OAuth Google non valido.")
    return installed


def login(credentials_path, token_path, *, timeout=300):
    credentials = load_credentials(credentials_path)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    state = secrets.token_urlsafe(32)
    result = {}

    class Callback(http.server.BaseHTTPRequestHandler):
        def log_message(self, *arguments):
            pass  # Authorization codes and callback URLs must never reach logs.

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            if parsed.path != "/" or query.get("state", [""])[0] != state:
                self.send_error(400, "Richiesta non valida")
                return
            result["code"] = query.get("code", [None])[0]
            result["error"] = query.get("error", [None])[0]
            message = "Autorizzazione ricevuta. Puoi chiudere questa finestra." if result["code"] else "Autorizzazione annullata. Puoi chiudere questa finestra."
            content = message.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)

    with http.server.HTTPServer(("127.0.0.1", 0), Callback) as server:
        server.timeout = 1
        redirect = f"http://127.0.0.1:{server.server_address[1]}/"
        parameters = {"client_id": credentials["client_id"], "redirect_uri": redirect,
                      "response_type": "code", "scope": SCOPE, "state": state,
                      "code_challenge": challenge, "code_challenge_method": "S256",
                      "access_type": "offline", "prompt": "consent"}
        print("Apro il browser predefinito per autorizzare Mochi Pocket con Google.", file=sys.stderr)
        if not webbrowser.open(AUTH_URL + "?" + urllib.parse.urlencode(parameters), new=1):
            raise GoogleSheetsError("Browser predefinito non disponibile; nessuna autorizzazione completata.")
        deadline = time.monotonic() + timeout
        while not result and time.monotonic() < deadline:
            server.handle_request()
    if not result.get("code"):
        raise GoogleSheetsError("Autorizzazione Google annullata o tempo scaduto; nessun token salvato.")
    body = {"client_id": credentials["client_id"], "code": result["code"],
            "code_verifier": verifier, "grant_type": "authorization_code", "redirect_uri": redirect}
    if credentials.get("client_secret"):
        body["client_secret"] = credentials["client_secret"]
    token = request_json(TOKEN_URL, method="POST", body=urllib.parse.urlencode(body).encode("ascii"),
                         headers={"Content-Type": "application/x-www-form-urlencoded"})
    if not token.get("access_token") or not token.get("refresh_token"):
        raise GoogleSheetsError("Google non ha rilasciato i token necessari; rieseguire login concedendo l'accesso richiesto.")
    if SCOPE not in token.get("scope", "").split():
        raise GoogleSheetsError("Il consenso Google non include la modifica dei fogli; nessun token salvato.")
    token["client_id"] = credentials["client_id"]
    token["expires_at"] = time.time() + int(token.get("expires_in", 3600))
    save_token(token_path, token)
    return {"connected": True, "tokenPath": str(token_path), "scope": SCOPE}


def spreadsheet_id(value):
    if re.fullmatch(r"[A-Za-z0-9_-]{20,}", value):
        return value
    parsed = urllib.parse.urlparse(value)
    match = re.match(r"/spreadsheets/d/([A-Za-z0-9_-]+)(?:/|$)", parsed.path)
    if parsed.scheme == "https" and parsed.hostname == "docs.google.com" and match:
        return match.group(1)
    raise GoogleSheetsError("Indicare un ID Google Sheets o il link https://docs.google.com/spreadsheets/d/... .")


def cell_date(cell):
    effective = cell.get("effectiveValue", {})
    if "errorValue" in effective:
        return None
    if "numberValue" in effective:
        value = effective["numberValue"]
        kind = cell.get("effectiveFormat", {}).get("numberFormat", {}).get("type")
        if kind not in ("DATE", "DATE_TIME") or isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        if not math.isfinite(value) or abs(value - round(value)) > 1e-8:
            return None
        try:
            return EPOCH + dt.timedelta(days=round(value))
        except (OverflowError, ValueError):
            return None
    value = effective.get("stringValue", "")
    for pattern, date_format in ((r"\d{4}-\d{2}-\d{2}", "%Y-%m-%d"), (r"\d{2}/\d{2}/\d{4}", "%d/%m/%Y")):
        if isinstance(value, str) and re.fullmatch(pattern, value):
            try:
                return dt.datetime.strptime(value, date_format).date()
            except ValueError:
                return None
    return None


def id_column_spec(column):
    if column is None:
        return None, None
    if not isinstance(column, str) or not re.fullmatch(r"[A-Za-z]{1,3}", column.strip()):
        raise GoogleSheetsError("La colonna ID deve essere una lettera A1 valida, da D in poi.")
    normalized = column.strip().upper()
    number = 0
    for letter in normalized:
        number = number * 26 + ord(letter) - ord("A") + 1
    if number < 4 or number > 18278:
        raise GoogleSheetsError("La colonna ID deve essere compresa fra D e ZZZ.")
    return normalized, number - 1


def cell_kross_id(cell, coordinate):
    entered = cell.get("userEnteredValue", {})
    effective = cell.get("effectiveValue", {})
    if "formulaValue" in entered:
        raise GoogleSheetsError(f"Calendario Google: {coordinate} contiene una formula ID; importazione sospesa.")
    if any(key in value for value in (entered, effective) for key in ("boolValue", "errorValue")):
        raise GoogleSheetsError(f"Calendario Google: {coordinate} contiene un ID booleano o un errore.")
    value = effective or entered
    if not value:
        return ""
    if "stringValue" in value and isinstance(value["stringValue"], str):
        return value["stringValue"].strip()
    if "numberValue" in value:
        number = value["numberValue"]
        if (not isinstance(number, bool) and isinstance(number, (int, float))
                and abs(number) <= MAX_SAFE_INTEGER and math.isfinite(number) and number == int(number)):
            return str(int(number))
    raise GoogleSheetsError(f"Calendario Google: {coordinate} contiene un ID non valido o numericamente non sicuro.")


def is_id_header(cell):
    value = cell.get("effectiveValue", {}).get("stringValue", "")
    return isinstance(value, str) and " ".join(value.replace(".", " ").casefold().split()) == "id kross"


def is_detail_value(value):
    if value is None or isinstance(value, str):
        return True
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def cell_booking_detail(cell, coordinate):
    """Preserve the entered type, not display text or a formula's cached value."""
    entered = cell.get("userEnteredValue", {})
    if "formulaValue" in entered:
        value = entered["formulaValue"]
        if not isinstance(value, str):
            raise GoogleSheetsError(f"Calendario Google: formula non valida in {coordinate}.")
        return {"value": value, "formula": True}
    if not entered:
        return {"value": None, "formula": False}
    if "stringValue" in entered and isinstance(entered["stringValue"], str):
        return {"value": entered["stringValue"], "formula": False}
    if ("numberValue" in entered and isinstance(entered["numberValue"], (int, float))
            and is_detail_value(entered["numberValue"])):
        return {"value": entered["numberValue"], "formula": False}
    raise GoogleSheetsError(f"Calendario Google: {coordinate} contiene un valore dettaglio non supportato.")


def unchecked_cell_value(cell, *, entered=False):
    """Keep opaque outside-scope data without accepting it as a writable value."""
    value = cell.get("userEnteredValue" if entered else "effectiveValue", {})
    if not value and not entered:
        value = cell.get("userEnteredValue", {})
    for field in ("formulaValue", "stringValue", "numberValue", "boolValue", "errorValue"):
        if field in value:
            return copy.deepcopy(value[field])
    return None


def same_detail_value(actual, expected):
    """Numbers compare numerically; text, blank and zero remain distinct."""
    if actual is None or expected is None:
        return actual is expected
    if isinstance(actual, str) or isinstance(expected, str):
        return isinstance(actual, str) and isinstance(expected, str) and actual == expected
    return is_detail_value(actual) and is_detail_value(expected) and actual == expected


def patch_cell_value(cell, column, id_column=None):
    if column == id_column:
        return cell.get("krossId"), cell.get("idFormula", False)
    if column == "C":
        return cell.get("guest"), cell.get("guestFormula", False)
    if column in BOOKING_DETAIL_COLUMNS:
        detail = cell.get("cells", {}).get(column, {})
        if "value" not in detail or "formula" not in detail:
            raise GoogleSheetsError("Metadati delle celle dettaglio mancanti nel calendario.")
        return detail["value"], detail["formula"]
    return cell.get("krossId"), cell.get("idFormula", False)


def _canonical_highlight_formula(formula):
    """Normalize only our exact tagged expressions and known Italian aliases."""
    if not isinstance(formula, str):
        return None
    tag = re.escape(BOOKING_HIGHLIGHT_TAG)
    pattern = (r'=\s*(?i:LEN|LUNGHEZZA)\s*\(\s*\$([A-Za-z]{1,3})([1-9]\d*)\s*\)\s*>\s*'
               r'(?i:N|NUM)\s*\(\s*"' + tag + r'"\s*\)\s*')
    match = re.fullmatch(pattern, formula)
    if match:
        return '=LEN($' + match[1].upper() + match[2] + ')>N("' + BOOKING_HIGHLIGHT_TAG + '")'
    legacy = (r'=\s*(?i:AND|E)\s*\(\s*\$([A-Za-z]{1,3})([1-9]\d*)\s*<>\s*""\s*[,;]\s*'
              r'(?i:N|NUM)\s*\(\s*"' + tag + r'"\s*\)\s*=\s*0\s*\)\s*')
    match = re.fullmatch(legacy, formula)
    if match:
        return '=AND($' + match[1].upper() + match[2] + '<>"",N("' + BOOKING_HIGHLIGHT_TAG + '")=0)'
    return None


def is_booking_highlight_rule(rule):
    """Recognize only our tagged formula, allowing its old column/first row."""
    if not isinstance(rule, dict):
        return False
    boolean = rule.get("booleanRule", {})
    if not isinstance(boolean, dict):
        return False
    condition = boolean.get("condition", {})
    if not isinstance(condition, dict):
        return False
    values = condition.get("values", [])
    if (condition.get("type") != "CUSTOM_FORMULA" or not isinstance(values, list)
            or len(values) != 1 or not isinstance(values[0], dict)):
        return False
    return _canonical_highlight_formula(values[0].get("userEnteredValue")) is not None


def _booking_highlight_rule_matches(rule, grid_range, formula):
    if not isinstance(rule, dict) or set(rule) != {"ranges", "booleanRule"}:
        return False
    ranges = rule.get("ranges")
    if not isinstance(ranges, list) or len(ranges) != 1 or not isinstance(ranges[0], dict):
        return False
    actual_range = ranges[0]
    if set(actual_range) - set(grid_range):
        return False
    if any(actual_range.get(key, 0) != value for key, value in grid_range.items()):
        return False
    boolean = rule.get("booleanRule", {})
    if not isinstance(boolean, dict) or set(boolean) != {"condition", "format"}:
        return False
    condition = copy.deepcopy(boolean.get("condition", {}))
    if not is_booking_highlight_rule(rule):
        return False
    condition["values"][0]["userEnteredValue"] = _canonical_highlight_formula(
        condition["values"][0]["userEnteredValue"])
    if condition != {"type": "CUSTOM_FORMULA", "values": [{"userEnteredValue": formula}]}:
        return False
    formatting = boolean.get("format", {})
    # Sheets may return backgroundColorStyle instead, and omit zero RGB
    # components/default alpha. Additional formatting belongs to no managed rule.
    if not isinstance(formatting, dict) or not formatting or set(formatting) - {"backgroundColor", "backgroundColorStyle"}:
        return False
    if "backgroundColorStyle" in formatting:
        style = formatting["backgroundColorStyle"]
        if not isinstance(style, dict) or set(style) != {"rgbColor"}:
            return False
        color = style["rgbColor"]
    else:
        color = formatting.get("backgroundColor")
    if not isinstance(color, dict) or set(color) - {"red", "green", "blue", "alpha"}:
        return False
    return (color.get("red", 0) == 1 and color.get("green", 0) == 1
            and color.get("blue", 0) == 0 and color.get("alpha", 1) == 1)


def _eligible_highlight_ids(value):
    if value is None:
        return None
    if (not isinstance(value, (list, set, tuple)) or len(value) > 10000
            or any(not isinstance(item, str) or not item or item != item.strip()
                   or len(item) > 200 or "," in item or any(ord(char) < 32 for char in item)
                   for item in value)):
        raise GoogleSheetsError("ID delle prenotazioni da evidenziare non validi.")
    return sorted(set(value))


def plan_booking_highlight(snapshot, id_column, previous_state=None, scope_month=None, scope_dates=None,
                           reapply=None, eligible_booking_ids=None):
    """Apply normal yellow backgrounds once, preserving later manual colors."""
    id_column, _ = id_column_spec(id_column)
    eligible_booking_ids = _eligible_highlight_ids(eligible_booking_ids)
    if id_column is None:
        raise GoogleSheetsError("L'evidenziazione richiede una colonna ID Kross configurata.")
    if not isinstance(snapshot, dict) or snapshot.get("idColumn") != id_column:
        raise GoogleSheetsError("Il calendario letto deve usare la stessa colonna ID dell'evidenziazione.")
    sheet_id = snapshot.get("sheetId")
    rows = snapshot.get("calendar")
    rules = snapshot.get("conditionalFormats", [])
    sheet_name = snapshot.get("sheetName")
    if scope_month is not None and (not isinstance(scope_month, str)
            or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", scope_month)
            or scope_month[:4] != sheet_name):
        raise GoogleSheetsError("Mese dell'evidenziazione non valido per questo calendario.")
    if scope_dates is not None:
        if not isinstance(scope_dates, (list, set, tuple)) or len(scope_dates) > 366:
            raise GoogleSheetsError("Date dell'evidenziazione non valide.")
        try:
            if any(not isinstance(date, str) or dt.date.fromisoformat(date).isoformat() != date
                   or date[:4] != sheet_name for date in scope_dates):
                raise ValueError()
        except (TypeError, ValueError):
            raise GoogleSheetsError("Date dell'evidenziazione non valide.") from None
        scope_dates = set(scope_dates)
    if (isinstance(sheet_id, bool) or not isinstance(sheet_id, int) or sheet_id < 0
            or not isinstance(rows, list) or not rows
            or not isinstance(rules, list) or any(not isinstance(rule, dict) for rule in rules)
            or not isinstance(sheet_name, str) or not re.fullmatch(r"\d{4}", sheet_name)):
        raise GoogleSheetsError("Snapshot del calendario non valido per l'evidenziazione.")
    seen_rows, seen_dates = set(), set()
    occupied = 0
    for row in rows:
        if not isinstance(row, dict):
            raise GoogleSheetsError("Riga calendario non valida per l'evidenziazione.")
        number, date, booking_id = row.get("row"), row.get("date"), row.get("krossId")
        try:
            valid_date = dt.date.fromisoformat(date) if isinstance(date, str) else None
        except ValueError:
            valid_date = None
        if (isinstance(number, bool) or not isinstance(number, int) or number < 1
                or number in seen_rows or valid_date is None
                or valid_date.isoformat() != date or valid_date.year != int(sheet_name)
                or date in seen_dates
                or ((scope_month is None or date.startswith(scope_month + "-"))
                    and (scope_dates is None or date in scope_dates)
                    and (not isinstance(booking_id, str) or booking_id != booking_id.strip()
                         or row.get("idFormula") or row.get("guestFormula")))):
            raise GoogleSheetsError("Date o ID calendario non validi per l'evidenziazione.")
        seen_rows.add(number)
        seen_dates.add(date)
        occupied += bool(booking_id)
    first, last = min(seen_rows), max(seen_rows)
    if last - first + 1 != len(rows):
        raise GoogleSheetsError("Le righe calendario devono essere consecutive per l'evidenziazione.")
    managed = [index for index, item in enumerate(rules) if is_booking_highlight_rule(item)]
    if managed and (scope_month is not None or scope_dates is not None):
        raise GoogleSheetsError("La vecchia regola dei colori va rimossa prima di aggiornare soltanto alcune date.")
    if reapply is not None:
        active = [row for row in rows if scope_dates is not None and row["date"] in scope_dates]
        if (not isinstance(reapply, dict) or set(reapply) != {"bookingId", "revision"}
                or not isinstance(reapply.get("bookingId"), str) or not reapply["bookingId"]
                or not isinstance(reapply.get("revision"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", reapply["revision"])
                or scope_month is not None or not scope_dates or len(active) != len(scope_dates)
                or any(row["krossId"] != reapply["bookingId"] for row in active)):
            raise GoogleSheetsError("Il ripristino del giallo richiede una sola prenotazione e date esplicite verificate.")
    try:
        return plan_manual_highlight(snapshot, id_column, previous_state, managed, scope_month, scope_dates,
                                     reapply, eligible_booking_ids)
    except ValueError as exc:
        raise GoogleSheetsError(str(exc)) from exc


class GoogleSheets:
    def __init__(self, credentials_path, token_path):
        self.credentials = load_credentials(credentials_path)
        self.token_path = Path(token_path)

    def access_token(self):
        token = load_token(self.token_path)
        if token.get("client_id") != self.credentials["client_id"]:
            raise GoogleSheetsError("Il token appartiene a un client OAuth diverso: rieseguire login.")
        if SCOPE not in token.get("scope", "").split():
            raise GoogleSheetsError("Token privo del permesso Google Sheets necessario: rieseguire login.")
        if token.get("access_token") and token.get("expires_at", 0) > time.time() + 60:
            return token["access_token"]
        if not token.get("refresh_token"):
            raise GoogleSheetsError("Token scaduto senza rinnovo disponibile: rieseguire login.")
        parameters = {"client_id": self.credentials["client_id"], "refresh_token": token["refresh_token"],
                      "grant_type": "refresh_token"}
        if self.credentials.get("client_secret"):
            parameters["client_secret"] = self.credentials["client_secret"]
        refreshed = request_json(TOKEN_URL, method="POST", body=urllib.parse.urlencode(parameters).encode("ascii"),
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
        if not refreshed.get("access_token"):
            raise GoogleSheetsError("Rinnovo del token non riuscito: rieseguire login.")
        token.update(refreshed)
        token["expires_at"] = time.time() + int(refreshed.get("expires_in", 3600))
        save_token(self.token_path, token)
        return token["access_token"]

    def api(self, identifier, *, parameters=None, body=None):
        url = API_URL + identifier
        if body is not None:
            url += ":batchUpdate"
        if parameters:
            url += "?" + urllib.parse.urlencode(parameters, doseq=True)
        headers = {"Authorization": "Bearer " + self.access_token(), "Content-Type": "application/json"}
        return request_json(url, method="POST" if body is not None else "GET",
                            body=json.dumps(body).encode("utf-8") if body is not None else None,
                            headers=headers, writing=body is not None)

    def read_calendar(self, spreadsheet, sheet_name="2026", id_column=None, scope_dates=None):
        identifier = spreadsheet_id(spreadsheet)
        id_column, id_index = id_column_spec(id_column)
        if not re.fullmatch(r"\d{4}", sheet_name) or not 1 <= int(sheet_name) <= 9999:
            raise GoogleSheetsError("Il nome del foglio deve essere un anno a quattro cifre.")
        if scope_dates is not None:
            if (not isinstance(scope_dates, (list, set, tuple)) or len(scope_dates) > 366
                    or any(not isinstance(date, str) for date in scope_dates)
                    or len(set(scope_dates)) != len(scope_dates)):
                raise GoogleSheetsError("Le date dell’importazione non sono un elenco ISO valido.")
            try:
                if any(not isinstance(date, str) or dt.date.fromisoformat(date).isoformat() != date
                       or date[:4] != sheet_name for date in scope_dates):
                    raise ValueError()
            except (ValueError, TypeError):
                raise GoogleSheetsError("Le date dell’importazione non sono un elenco ISO valido per il calendario.") from None
            scope_dates = set(scope_dates)
        metadata = self.api(identifier, parameters={
            "fields": "spreadsheetId,sheets(properties(sheetId,title),conditionalFormats,developerMetadata(metadataId,metadataKey,metadataValue))"})
        sheet_properties = [item["properties"] for item in metadata.get("sheets", [])]
        matches = [item for item in sheet_properties if item["title"] == sheet_name]
        if len(matches) != 1:
            raise GoogleSheetsError(f"Google Sheets: foglio '{sheet_name}' non trovato.")
        sheet_id = matches[0]["sheetId"]
        conditional_formats = next(item.get("conditionalFormats", []) for item in metadata["sheets"]
                                   if item["properties"]["sheetId"] == sheet_id)
        transactions = [entry for item in metadata["sheets"] if item["properties"]["sheetId"] == sheet_id
                        for entry in item.get("developerMetadata", [])
                        if entry.get("metadataKey") == BOOKING_HIGHLIGHT_TRANSACTION_KEY]
        if len(transactions) > 1:
            raise GoogleSheetsError("Marcatori colori duplicati nel calendario: nessuna modifica inviata.")
        fields = ("sheets(properties(sheetId),data(startRow,startColumn,rowData(values("
                  "userEnteredValue,effectiveValue,userEnteredFormat(backgroundColor,backgroundColorStyle),"
                  "effectiveFormat(numberFormat,backgroundColor,backgroundColorStyle)))))")
        ranges = ["'" + sheet_name + "'!B:C", "'" + sheet_name + "'!D:L"]
        if id_column:
            ranges.append("'" + sheet_name + "'!" + id_column + ":" + id_column)
        grid = self.api(identifier, parameters={"ranges": ranges, "fields": fields})
        rows, seen_dates, skipped_rows, formula_rows = [], {}, [], []
        cells = {}
        for sheet in grid.get("sheets", []):
            if sheet["properties"]["sheetId"] != sheet_id:
                continue
            for block in sheet.get("data", []):
                start_column = block.get("startColumn", 0)
                for offset, row_data in enumerate(block.get("rowData", [])):
                    row_number = block.get("startRow", 0) + offset + 1
                    for offset_column, cell in enumerate(row_data.get("values", [])):
                        column = start_column + offset_column
                        if column == 1 or 2 <= column <= 11 or column == id_index:
                            cells.setdefault(row_number, {})[column] = cell
        for row_number in range(1, max(cells, default=0) + 1):
            at = cells.get(row_number, {})
            date = cell_date(at.get(1, {}))
            if date is None or date.year != int(sheet_name):
                skipped_rows.append(row_number)
                continue
            iso = date.isoformat()
            if iso in seen_dates:
                raise GoogleSheetsError(f"Calendario Google: data duplicata {iso}.")
            seen_dates[iso] = row_number
            active = scope_dates is None or iso in scope_dates
            guest_cell = at.get(2, {})
            effective = guest_cell.get("effectiveValue", {})
            if active and effective and "stringValue" not in effective:
                raise GoogleSheetsError(f"Calendario Google: C{row_number} contiene un valore ospite non testuale.")
            guest_formula = "formulaValue" in guest_cell.get("userEnteredValue", {})
            if active and guest_formula:
                formula_rows.append(row_number)
            row = {"row": row_number, "date": iso,
                   "guest": effective.get("stringValue", "") if active else unchecked_cell_value(guest_cell),
                   "guestFormula": guest_formula,
                   "backgrounds": {column: background(at.get(ord(column) - 65, {}).get("userEnteredFormat", {}))
                                   for column in HIGHLIGHT_COLUMNS},
                   "effectiveBackgrounds": {column: background(at.get(ord(column) - 65, {}).get("effectiveFormat", {}))
                                            for column in HIGHLIGHT_COLUMNS},
                   "cells": {column: (cell_booking_detail(at.get(index, {}), f"{column}{row_number}") if active
                                      else {"value": unchecked_cell_value(at.get(index, {}), entered=True),
                                            "formula": "formulaValue" in at.get(index, {}).get("userEnteredValue", {})})
                             for column, index in BOOKING_DETAIL_COLUMNS.items()}}
            if id_column:
                id_cell = at.get(id_index, {})
                if active:
                    row["krossId"] = cell_kross_id(id_cell, f"{id_column}{row_number}")
                else:
                    try:
                        row["krossId"] = cell_kross_id(id_cell, f"{id_column}{row_number}")
                    except GoogleSheetsError:
                        row["krossId"] = unchecked_cell_value(id_cell)
                row["idFormula"] = "formulaValue" in id_cell.get("userEnteredValue", {})
            rows.append(row)
        if not rows:
            raise GoogleSheetsError("Calendario Google: nessuna data valida nel foglio selezionato.")
        if any(rows[0]["row"] <= row <= rows[-1]["row"] for row in skipped_rows):
            raise GoogleSheetsError("Calendario Google: date mancanti o non valide tra le righe del calendario.")
        expected = {dt.date(int(sheet_name), month, day).isoformat()
                    for month in range(1, 13) for day in range(1, calendar.monthrange(int(sheet_name), month)[1] + 1)}
        if expected != set(seen_dates):
            raise GoogleSheetsError(f"Calendario Google incompleto: attese {len(expected)} date univoche; trovate {len(rows)}.")
        if formula_rows:
            coordinates = ", ".join(f"C{row}" for row in formula_rows[:10])
            raise GoogleSheetsError(f"Calendario Google: la colonna ospiti contiene formule ({coordinates}); importazione sospesa per conservarle.")
        if id_column:
            headers = [cell for row_number, row_cells in cells.items() if row_number < rows[0]["row"]
                       for column, cell in row_cells.items() if column == id_index
                       and is_id_header(cell)]
            if len(headers) != 1 or "formulaValue" in headers[0].get("userEnteredValue", {}):
                raise GoogleSheetsError(f"Calendario Google: manca un'intestazione testuale univoca 'ID Kross' in colonna {id_column}, prima delle date.")
        return {"calendar": rows, "sheets": [item["title"] for item in sheet_properties],
                "structuralWarnings": [], "spreadsheetId": identifier, "sheetId": sheet_id,
                "sheetName": sheet_name, "idColumn": id_column,
                "highlightTransaction": copy.deepcopy(transactions[0]) if transactions else None,
                "conditionalFormats": copy.deepcopy(conditional_formats)}

    def highlight_state_path(self, spreadsheet, sheet_name, state_path=None):
        return Path(state_path) if state_path is not None else (
            self.token_path.parent.parent / ".local" / "colori"
            / f"{spreadsheet_id(spreadsheet)}-{sheet_name}.json")

    def preview_booking_highlight(self, spreadsheet, sheet_name, id_column, state_path=None, scope_month=None,
                                  scope_dates=None, eligible_booking_ids=None):
        read_options = {"scope_dates": scope_dates} if scope_dates is not None else {}
        before = self.read_calendar(spreadsheet, sheet_name, id_column, **read_options)
        target = self.highlight_state_path(spreadsheet, sheet_name, state_path)
        return self._highlight_plan(before, id_column, target, scope_month, scope_dates,
                                    eligible_booking_ids=eligible_booking_ids)

    @staticmethod
    def _highlight_binding(snapshot, scope_month=None, scope_dates=None):
        return [{key: row[key] for key in ("date", "row", "krossId")} for row in snapshot["calendar"]
                if (scope_month is None or row["date"].startswith(scope_month + "-"))
                and (scope_dates is None or row["date"] in scope_dates)]

    @staticmethod
    def _other_highlight_rules(snapshot):
        return [rule for rule in snapshot["conditionalFormats"] if not is_booking_highlight_rule(rule)]

    def _highlight_plan(self, before, id_column, target, scope_month=None, scope_dates=None, reapply=None,
                        eligible_booking_ids=None):
        eligible_booking_ids = _eligible_highlight_ids(eligible_booking_ids)
        pending_path = target.with_name(target.name + ".pending.json")
        if not pending_path.exists():
            state = read_json(target) if target.exists() else None
            return plan_booking_highlight(before, id_column, state, scope_month, scope_dates, reapply,
                                          eligible_booking_ids)
        pending = read_json(pending_path)
        plan = pending.get("plan", {})
        if (not isinstance(plan, dict) or not isinstance(plan.get("nextState"), dict)
                or not isinstance(plan.get("changes"), list)
                or not isinstance(pending.get("transaction"), str)):
            raise GoogleSheetsError("Registro colori interrotto non valido: nessuna modifica inviata.")
        if (plan.get("reapply") != reapply or plan.get("scopeMonth") != scope_month
                or plan.get("scopeDates") != (sorted(set(scope_dates)) if scope_dates is not None else None)
                or plan.get("eligibleBookingIds") != eligible_booking_ids):
            raise GoogleSheetsError("Esiste un aggiornamento colori interrotto per altre date o criteri diversi: riprendere prima quel file.")
        # A persisted intent makes a network timeout retryable without losing
        # the original backgrounds or painting over intervening manual edits.
        try:
            # Older journals held the complete annual binding. Compare only
            # the original source dates, so unrelated calendar edits cannot
            # block recovery or expand its authorized write footprint.
            pending_binding = self._highlight_binding({"calendar": pending["binding"]}, scope_month, scope_dates)
        except (KeyError, TypeError, AttributeError):
            raise GoogleSheetsError("Registro colori interrotto non valido: nessuna modifica inviata.") from None
        if (pending_binding != self._highlight_binding(before, scope_month, scope_dates)
                or pending.get("otherRules") != self._other_highlight_rules(before)):
            raise GoogleSheetsError("Calendario cambiato dopo un aggiornamento colori interrotto: conservato il registro per la verifica.")
        plan_booking_highlight(before, id_column, plan.get("nextState"), scope_month, scope_dates,
                               eligible_booking_ids=eligible_booking_ids)
        at = {row["row"]: row["backgrounds"] for row in before["calendar"]}
        allowed_rows = {row["row"] for row in self._highlight_binding(before, scope_month, scope_dates)}
        for change in plan["changes"]:
            if (not isinstance(change, dict) or isinstance(change.get("row"), bool)
                    or change.get("row") not in allowed_rows or change.get("column") not in HIGHLIGHT_COLUMNS
                    or not _highlight._valid_background(change.get("before"))
                    or not _highlight._valid_background(change.get("after"))):
                raise GoogleSheetsError("Registro colori interrotto fuori dalle date autorizzate: nessuna modifica inviata.")
        applied = (before.get("highlightTransaction") or {}).get("metadataValue") == pending["transaction"]
        changes = []
        requests = [{"deleteConditionalFormatRule": {"sheetId": before["sheetId"], "index": index}}
                    for index in reversed(range(len(before["conditionalFormats"])))
                    if is_booking_highlight_rule(before["conditionalFormats"][index])]
        for change in plan.get("changes", []):
            current = at[change["row"]][change["column"]]
            if same_background(current, change["after"]):
                changes.append(change)
            elif not applied and same_background(current, change["before"]):
                changes.append(change)
                requests.append(background_request(before["sheetId"], change["row"], change["column"], change["after"]))
        return {**plan, "needed": bool(requests), "requests": requests, "changes": changes}

    def ensure_booking_highlight(self, spreadsheet, sheet_name, id_column, state_path=None, scope_month=None, scope_dates=None,
                                 reapply=None, expected_rows=None, eligible_booking_ids=None):
        """Migrate the tagged rule and apply editable backgrounds with a journal."""
        if id_column_spec(id_column)[0] is None:
            raise GoogleSheetsError("L'evidenziazione richiede una colonna ID Kross configurata.")
        target = self.highlight_state_path(spreadsheet, sheet_name, state_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        lock = target.with_name(target.name + ".lock")
        try:
            lock_handle = _highlight.color_state_lock(lock)
        except (BlockingIOError, PermissionError):
            raise GoogleSheetsError("Aggiornamento colori già in corso per questo calendario.") from None
        try:
            read_options = {"scope_dates": scope_dates} if scope_dates is not None else {}
            before = self.read_calendar(spreadsheet, sheet_name, id_column, **read_options)
            if reapply is not None:
                guarded = lambda rows: [{key: row.get(key) for key in ("date", "row", "guest", "krossId", "backgrounds")}
                                        for row in rows if scope_dates is not None and row["date"] in scope_dates]
                if not isinstance(expected_rows, list) or guarded(before["calendar"]) != guarded(expected_rows):
                    raise GoogleSheetsError("Prenotazione o colori cambiati: rileggere il controllo colori prima di riprovare.")
            plan = self._highlight_plan(before, id_column, target, scope_month, scope_dates, reapply,
                                        eligible_booking_ids)
            pending_path = target.with_name(target.name + ".pending.json")
            other_rules = self._other_highlight_rules(before)
            if plan["requests"]:
                transaction = secrets.token_hex(16)
                marker = before.get("highlightTransaction")
                if marker:
                    transaction_request = {"updateDeveloperMetadata": {
                        "dataFilters": [{"developerMetadataLookup": {"metadataId": marker["metadataId"]}}],
                        "developerMetadata": {"metadataValue": transaction}, "fields": "metadataValue"}}
                else:
                    transaction_request = {"createDeveloperMetadata": {"developerMetadata": {
                        "metadataKey": BOOKING_HIGHLIGHT_TRANSACTION_KEY, "metadataValue": transaction,
                        "visibility": "DOCUMENT", "location": {"sheetId": before["sheetId"]}}}}
                atomic_json(pending_path, {"binding": self._highlight_binding(before, scope_month, scope_dates),
                                          "otherRules": other_rules, "plan": plan, "transaction": transaction})
                self.api(before["spreadsheetId"], body={
                    "requests": [*plan["requests"], transaction_request], "includeSpreadsheetInResponse": False})
                try:
                    after = self.read_calendar(spreadsheet, sheet_name, id_column, **read_options)
                    colors = {row["row"]: row["backgrounds"] for row in after["calendar"]}
                    # The request mask only permits backgrounds; also check
                    # all values read by the importer and unrelated rules.
                    content = lambda snapshot: [{k: v for k, v in row.items()
                                                  if k not in ("backgrounds", "effectiveBackgrounds")}
                                                 for row in snapshot["calendar"]]
                    if (after["sheetId"] != before["sheetId"] or content(after) != content(before)
                            or (after.get("highlightTransaction") or {}).get("metadataValue") != transaction
                            or self._other_highlight_rules(after) != other_rules
                            or any(is_booking_highlight_rule(rule) for rule in after["conditionalFormats"])
                            or any(not same_background(colors[c["row"]][c["column"]], c["after"])
                                   for c in plan["changes"])):
                        raise WriteOutcomeUnknown("Verifica dei colori non riuscita; registro conservato per riprendere senza perdere i colori manuali.")
                except (GoogleSheetsError, KeyError, TypeError, ValueError) as exc:
                    if isinstance(exc, WriteOutcomeUnknown):
                        raise
                    raise WriteOutcomeUnknown("Colori inviati ma verifica non completata; ripetere l'operazione per verificarli.") from exc
            atomic_json(target, plan["nextState"])
            if pending_path.exists():
                pending_path.unlink()
            return {key: value for key, value in {
                **plan, "applied": bool(plan["requests"]), "verified": True,
                "updatedCells": len(plan["changes"]),
                "updatedRules": sum("deleteConditionalFormatRule" in r for r in plan["requests"])
            }.items() if key not in ("requests", "changes", "nextState")}
        finally:
            lock_handle.close()

    def write_patches(self, spreadsheet, sheet_name, patches, id_column=None, *, booking_details=False):
        id_column, id_index = id_column_spec(id_column)
        if not isinstance(booking_details, bool):
            raise GoogleSheetsError("booking_details deve essere un'opzione booleana esplicita.")
        if booking_details and (id_column is None or id_column in BOOKING_DETAIL_COLUMNS):
            raise GoogleSheetsError("I dettagli prenotazione richiedono una colonna ID configurata distinta da D, J e K.")
        if not isinstance(patches, list):
            raise GoogleSheetsError("Il piano deve contenere un array patches.")
        allowed_columns = {"C", id_column}
        if booking_details:
            allowed_columns.update(BOOKING_DETAIL_COLUMNS)
        validated, used_cells, expectations = [], set(), {}
        for patch in patches:
            if not isinstance(patch, dict):
                raise GoogleSheetsError("Patch non valida.")
            row = patch.get("row")
            column = patch.get("column")
            if (isinstance(row, bool) or not isinstance(row, int) or row < 1
                    or not isinstance(column, str) or column not in allowed_columns or column == "F"):
                raise GoogleSheetsError("Colonna non autorizzata: solo C/ID oppure D, J, K con --booking-details. La tassa non viene modificata.")
            detail_patch = column in BOOKING_DETAIL_COLUMNS and column != id_column
            if (row, column) in used_cells or not all(key in patch for key in ("before", "after")):
                raise GoogleSheetsError("Patch duplicata o valori before/after mancanti.")
            if detail_patch:
                if not all(is_detail_value(patch[key]) for key in ("before", "after")):
                    raise GoogleSheetsError("Le celle dettaglio richiedono numeri finiti, testo oppure null.")
            elif not isinstance(patch["before"], str) or not isinstance(patch["after"], str):
                raise GoogleSheetsError("Le celle nome e ID richiedono valori testuali.")
            if id_column:
                if not isinstance(patch.get("expectedGuest"), str) or not isinstance(patch.get("expectedId"), str):
                    raise GoogleSheetsError("Con colonna ID configurata, ogni patch deve indicare expectedGuest ed expectedId originali.")
                if patch["expectedId"] != patch["expectedId"].strip():
                    raise GoogleSheetsError("expectedId deve essere già normalizzato senza spazi esterni.")
                original = (patch.get("date"), patch["expectedGuest"], patch["expectedId"])
                if row in expectations and expectations[row] != original:
                    raise GoogleSheetsError("Le patch della stessa riga hanno aspettative originali diverse.")
                expectations[row] = original
            if column == id_column and any(patch[key] != patch[key].strip() for key in ("before", "after")):
                raise GoogleSheetsError("Le patch ID devono contenere valori già normalizzati senza spazi esterni.")
            if not isinstance(patch.get("date"), str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", patch["date"]):
                raise GoogleSheetsError("Data della patch non valida.")
            used_cells.add((row, column))
            validated.append(patch)
        if not validated:
            return {"updatedCells": 0, "spreadsheetId": spreadsheet_id(spreadsheet),
                    "sheetName": sheet_name, "idColumn": id_column}
        scope_dates = sorted({patch["date"] for patch in validated})
        current = self.read_calendar(spreadsheet, sheet_name, id_column, scope_dates=scope_dates)
        by_row = {item["row"]: item for item in current["calendar"]}
        id_patches = {patch["row"]: patch for patch in validated if patch["column"] == id_column}
        guest_patches = {patch["row"]: patch for patch in validated if patch["column"] == "C"}
        requests = []
        for patch in validated:
            cell = by_row.get(patch["row"])
            is_guest = patch["column"] == "C"
            detail_patch = patch["column"] in BOOKING_DETAIL_COLUMNS and patch["column"] != id_column
            actual_value, formula = patch_cell_value(cell, patch["column"], id_column) if cell else (None, False)
            matches = (same_detail_value(actual_value, patch["before"]) if detail_patch
                       else actual_value == patch["before"])
            if cell is None or cell["date"] != patch["date"] or not matches or formula:
                raise GoogleSheetsError(f"Calendario modificato o formula presente in {patch['column']}{patch['row']}: nessuna patch inviata. Rigenerare il piano.")
            if id_column and (cell["guest"] != patch["expectedGuest"] or cell["krossId"] != patch["expectedId"]
                              or cell.get("guestFormula") or cell.get("idFormula")):
                raise GoogleSheetsError(f"Nome o ID Kross modificato alla riga {patch['row']}: nessuna patch inviata. Rigenerare il piano.")
            column_index = (BOOKING_DETAIL_COLUMNS[patch["column"]] if detail_patch
                            else 2 if is_guest else id_index)
            after_value = patch["after"]
            if detail_patch:
                value = {} if after_value is None else {"userEnteredValue": {
                    "stringValue" if isinstance(after_value, str) else "numberValue": after_value}}
            else:
                value = {"userEnteredValue": {"stringValue": after_value}} if after_value else {}
            requests.append({"updateCells": {"range": {"sheetId": current["sheetId"],
                             "startRowIndex": patch["row"] - 1, "endRowIndex": patch["row"],
                             "startColumnIndex": column_index, "endColumnIndex": column_index + 1},
                             "rows": [{"values": [value]}], "fields": "userEnteredValue"}})
        self.api(current["spreadsheetId"], body={"requests": requests, "includeSpreadsheetInResponse": False})
        try:
            after = self.read_calendar(spreadsheet, sheet_name, id_column, scope_dates=scope_dates)
            after_rows = {item["row"]: item for item in after["calendar"]}
            def mismatches(patch):
                cell = after_rows.get(patch["row"], {})
                detail_patch = patch["column"] in BOOKING_DETAIL_COLUMNS and patch["column"] != id_column
                actual_value, formula = patch_cell_value(cell, patch["column"], id_column) if cell else (None, False)
                matches = (same_detail_value(actual_value, patch["after"]) if detail_patch
                           else actual_value == patch["after"])
                if cell.get("date") != patch["date"] or not matches or formula:
                    return True
                if not id_column:
                    return False
                expected_guest = guest_patches.get(patch["row"], {}).get("after", patch["expectedGuest"])
                expected_id = id_patches.get(patch["row"], {}).get("after", patch["expectedId"])
                return (cell.get("guest") != expected_guest or cell.get("krossId") != expected_id
                        or cell.get("guestFormula") or cell.get("idFormula"))
            if after["sheetId"] != current["sheetId"] or any(mismatches(patch) for patch in validated):
                raise WriteOutcomeUnknown("Verifica Google dopo la scrittura non riuscita: conservare il piano e rileggere il calendario.")
        except (GoogleSheetsError, KeyError, TypeError, ValueError) as exc:
            if isinstance(exc, WriteOutcomeUnknown):
                raise
            raise WriteOutcomeUnknown("Scrittura inviata ma verifica Google non completata: conservare il piano e rileggere il calendario.") from exc
        return {"updatedCells": len(validated), "spreadsheetId": current["spreadsheetId"],
                "sheetId": current["sheetId"], "sheetName": sheet_name, "idColumn": id_column}


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    auth_directory = default_auth_directory()
    for command in ("login", "read", "write", "highlight-preview", "highlight"):
        sub = commands.add_parser(command)
        sub.add_argument("--credentials", type=Path, default=auth_directory / "credentials.json")
        sub.add_argument("--token", type=Path, default=auth_directory / "token.json")
        if command != "login":
            sub.add_argument("--spreadsheet", required=True)
            sub.add_argument("--sheet", default="2026")
            sub.add_argument("--id-column", default=None)
        if command == "write":
            sub.add_argument("--patches", type=Path, required=True)
            sub.add_argument("--booking-details", action="store_true")
        if command == "read":
            sub.add_argument("--scope-dates")
        if command in ("highlight", "highlight-preview"):
            sub.add_argument("--highlight-state", type=Path)
            sub.add_argument("--month")
            sub.add_argument("--scope-dates")
            sub.add_argument("--eligible-booking-ids")
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "login":
            result = login(arguments.credentials, arguments.token)
        else:
            id_column, _ = id_column_spec(arguments.id_column)
            if (arguments.command == "write" and arguments.booking_details
                    and (id_column is None or id_column in BOOKING_DETAIL_COLUMNS)):
                raise GoogleSheetsError("--booking-details richiede una colonna ID distinta da D, J e K.")
            if arguments.command in ("highlight", "highlight-preview") and id_column is None:
                raise GoogleSheetsError("L'evidenziazione richiede --id-column con la colonna ID Kross configurata.")
            client = GoogleSheets(arguments.credentials, arguments.token)
            if arguments.command == "read":
                scope_dates = (arguments.scope_dates.split(",") if arguments.scope_dates else []) if arguments.scope_dates is not None else None
                result = client.read_calendar(arguments.spreadsheet, arguments.sheet, id_column, scope_dates=scope_dates)
            elif arguments.command == "highlight-preview":
                result = client.preview_booking_highlight(arguments.spreadsheet, arguments.sheet, id_column,
                                                          arguments.highlight_state, arguments.month,
                                                          (arguments.scope_dates.split(",") if arguments.scope_dates else []) if arguments.scope_dates is not None else None,
                                                          (arguments.eligible_booking_ids.split(",") if arguments.eligible_booking_ids else []) if arguments.eligible_booking_ids is not None else None)
                result = {k: v for k, v in result.items() if k not in ("requests", "changes", "nextState")}
            elif arguments.command == "highlight":
                result = client.ensure_booking_highlight(arguments.spreadsheet, arguments.sheet, id_column,
                                                         arguments.highlight_state, arguments.month,
                                                         (arguments.scope_dates.split(",") if arguments.scope_dates else []) if arguments.scope_dates is not None else None,
                                                         eligible_booking_ids=(arguments.eligible_booking_ids.split(",") if arguments.eligible_booking_ids else []) if arguments.eligible_booking_ids is not None else None)
            else:
                plan = read_json(arguments.patches)
                if isinstance(plan, dict) and plan.get("conflicts"):
                    raise GoogleSheetsError("Il piano contiene conflitti: nessuna patch inviata.")
                if isinstance(plan, dict) and plan.get("spreadsheetId") not in (None, spreadsheet_id(arguments.spreadsheet)):
                    raise GoogleSheetsError("Il piano appartiene a un documento Google diverso.")
                if isinstance(plan, dict) and plan.get("sheetName") not in (None, arguments.sheet):
                    raise GoogleSheetsError("Il piano appartiene a un foglio annuale diverso.")
                if isinstance(plan, dict) and "idColumn" in plan and id_column_spec(plan["idColumn"])[0] != id_column:
                    raise GoogleSheetsError("Il piano usa una colonna ID diversa da quella configurata.")
                patches = plan.get("patches") if isinstance(plan, dict) else plan
                result = client.write_patches(arguments.spreadsheet, arguments.sheet, patches, id_column,
                                              booking_details=arguments.booking_details)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except GoogleSheetsError as exc:
        unknown = isinstance(exc, WriteOutcomeUnknown)
        print(json.dumps({"error": str(exc), "outcomeUnknown": unknown}, ensure_ascii=False), file=sys.stderr)
        return 3 if unknown else 2
    except KeyboardInterrupt:
        writing = arguments.command in ("write", "highlight")
        print(json.dumps({"error": "Operazione interrotta.", "outcomeUnknown": writing}, ensure_ascii=False), file=sys.stderr)
        return 3 if writing else 2


if __name__ == "__main__":
    raise SystemExit(main())
