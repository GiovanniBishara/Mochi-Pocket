"""Verify saved Google authorization without login or spreadsheet mutations.

Only minimal spreadsheet metadata is requested. The existing Kross OAuth
client may refresh its saved token; guest cells and account identifiers are
never included in this helper's output.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_FILE_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024


class ProbeError(Exception):
    pass


def import_google(engine_dir):
    spec = importlib.util.spec_from_file_location(
        "mochi_status_google", Path(engine_dir) / "google_sheets.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def bounded_requests(google, *, deadline, opener=None):
    opener = opener or urllib.request.build_opener(NoRedirect())

    def request_json(url, *, method="GET", body=None, headers=None, writing=False):
        parsed = urllib.parse.urlparse(url)
        refreshing = url == google.TOKEN_URL and method == "POST"
        metadata = (method == "GET" and body is None
                    and parsed.scheme == "https"
                    and parsed.netloc == "sheets.googleapis.com"
                    and re.fullmatch(r"/v4/spreadsheets/[A-Za-z0-9_-]{20,}", parsed.path)
                    and urllib.parse.parse_qs(parsed.query) == {"fields": ["spreadsheetId"]})
        if writing or not (refreshing or metadata):
            raise ProbeError("configuration")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProbeError("network")
        request = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
        try:
            with opener.open(request, timeout=min(8, remaining)) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise ProbeError("network")
                result = json.loads(raw.decode("utf-8"))
                if not isinstance(result, dict):
                    raise ProbeError("network")
                return result
        except urllib.error.HTTPError as exc:
            # Error bodies may contain request details; do not read or print them.
            if exc.code == 401 or (refreshing and exc.code in (400, 403)):
                raise ProbeError("auth") from None
            if not refreshing and exc.code in (403, 404):
                raise ProbeError("permissions") from None
            raise ProbeError("network") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, UnicodeError):
            raise ProbeError("network") from None

    return request_json


def small_file(file):
    try:
        return file.is_file() and file.stat().st_size <= MAX_FILE_BYTES
    except OSError:
        return False


def check(config_file, engine_dir, *, google=None):
    config_file = Path(config_file)
    try:
        if not small_file(config_file):
            raise ProbeError("configuration")
        config = json.loads(config_file.read_text(encoding="utf-8-sig"))
        if not isinstance(config, dict) or config.get("version") != 1:
            raise ProbeError("configuration")
        calendars = config.get("calendars")
        if not isinstance(calendars, list) or not 1 <= len(calendars) <= 100:
            raise ProbeError("configuration")
        targets = [item for item in calendars if isinstance(item, dict) and item.get("type") == "google"]
        if not targets:
            raise ProbeError("configuration")
        google = google or import_google(engine_dir)
        google.request_json = bounded_requests(google, deadline=time.monotonic() + 35)
        seen = set()
        for item in targets:
            if any(not isinstance(item.get(key), str) or not item[key] or "\0" in item[key]
                   for key in ("credentials", "token", "spreadsheet")):
                raise ProbeError("configuration")
            credentials = (config_file.parent / item["credentials"]).resolve()
            token = (config_file.parent / item["token"]).resolve()
            if not small_file(credentials):
                raise ProbeError("configuration")
            if not small_file(token):
                raise ProbeError("auth")
            try:
                identifier = google.spreadsheet_id(item["spreadsheet"])
            except google.GoogleSheetsError:
                raise ProbeError("configuration") from None
            key = (credentials, token, identifier)
            if key in seen:
                continue
            seen.add(key)
            try:
                client = google.GoogleSheets(credentials, token)
            except google.GoogleSheetsError:
                raise ProbeError("configuration") from None
            try:
                # This proves saved authorization works now, not just that a file exists.
                metadata = client.api(identifier, parameters={"fields": "spreadsheetId"})
            except google.GoogleSheetsError:
                raise ProbeError("auth") from None
            if not isinstance(metadata, dict) or metadata.get("spreadsheetId") != identifier:
                raise ProbeError("network")
        return {"status": "connected", "reason": "verified"}
    except ProbeError as exc:
        reason = str(exc)
        return {"status": "disconnected" if reason == "auth" else "unknown", "reason": reason}
    except Exception:
        return {"status": "unknown", "reason": "configuration"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-dir", required=True)
    parser.add_argument("--config", required=True)
    arguments = parser.parse_args()
    print(json.dumps(check(arguments.config, arguments.engine_dir)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
