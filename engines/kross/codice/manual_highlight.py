"""Normal booking backgrounds: apply once, then respect manual changes."""

import copy
import datetime as dt
import os


COLUMNS = tuple("CDEFGHIJKL")
BACKGROUND_FIELDS = "userEnteredFormat.backgroundColor,userEnteredFormat.backgroundColorStyle"
YELLOW = {"backgroundColorStyle": {"rgbColor": {"red": 1, "green": 1, "blue": 0}}}


def color_state_lock(path):
    """Return an exclusively locked file; closing/crashing releases the lock."""
    handle = open(path, "a+b")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except BaseException:
        handle.close()
        raise


def background(formatting):
    return {key: copy.deepcopy(formatting[key]) for key in ("backgroundColor", "backgroundColorStyle")
            if key in formatting}


def same_background(left, right):
    def color(value):
        style = value.get("backgroundColorStyle", {})
        if "themeColor" in style:
            return ("theme", style["themeColor"])
        rgb = style.get("rgbColor", value.get("backgroundColor"))
        if rgb is None:
            return (1, 1, 1, 1)
        return tuple(rgb.get(key, 1 if key == "alpha" else 0)
                     for key in ("red", "green", "blue", "alpha"))
    return color(left) == color(right)


def background_request(sheet_id, row, column, formatting):
    index = ord(column) - ord("A")
    return {"repeatCell": {
        "range": {"sheetId": sheet_id, "startRowIndex": row - 1, "endRowIndex": row,
                  "startColumnIndex": index, "endColumnIndex": index + 1},
        "cell": {"userEnteredFormat": copy.deepcopy(formatting)}, "fields": BACKGROUND_FIELDS}}


def _valid_background(value):
    if not isinstance(value, dict) or set(value) - {"backgroundColor", "backgroundColorStyle"}:
        return False
    for key, color in value.items():
        if not isinstance(color, dict):
            return False
        if key == "backgroundColorStyle":
            if set(color) == {"themeColor"}:
                if not isinstance(color["themeColor"], str):
                    return False
                continue
            if set(color) != {"rgbColor"} or not isinstance(color["rgbColor"], dict):
                return False
            color = color["rgbColor"]
        if set(color) - {"red", "green", "blue", "alpha"}:
            return False
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 1
               for v in color.values()):
            return False
    return True


def plan_manual_highlight(snapshot, id_column, previous_state, managed, scope_month=None, scope_dates=None,
                          reapply=None, eligible_booking_ids=None):
    identity = {key: snapshot.get(key) for key in ("spreadsheetId", "sheetId", "sheetName")}
    identity["idColumn"] = id_column
    rows = snapshot["calendar"]
    dates = {row["date"]: row for row in rows}
    for row in rows:
        colors = row.get("backgrounds")
        if (not isinstance(colors, dict) or set(colors) != set(COLUMNS)
                or any(not _valid_background(value) for value in colors.values())):
            raise ValueError("Sfondi C:L mancanti o non validi: rileggere il calendario prima di colorarlo.")
    previous = {}
    if previous_state is not None:
        if (not isinstance(previous_state, dict) or previous_state.get("version") != 1
                or any(previous_state.get(key) != value for key, value in identity.items())
                or not isinstance(previous_state.get("rows"), dict)):
            raise ValueError("Il registro colori non appartiene a questo calendario o non è valido.")
        previous = previous_state["rows"]
        for date, entry in previous.items():
            try:
                parsed = dt.date.fromisoformat(date)
            except (TypeError, ValueError):
                raise ValueError("Data non valida nel registro colori.") from None
            if (parsed.isoformat() != date or str(parsed.year) != identity["sheetName"]
                    or date not in dates or not isinstance(entry, dict)
                    or isinstance(entry.get("row"), bool) or not isinstance(entry.get("row"), int)
                    or entry["row"] < 1 or not isinstance(entry.get("krossId"), str)
                    or not entry["krossId"] or entry["krossId"] != entry["krossId"].strip()
                    or not isinstance(entry.get("originals"), dict)
                    or set(entry["originals"]) - set(COLUMNS)
                    or any(not _valid_background(v) for v in entry["originals"].values())):
                raise ValueError("Riga non valida nel registro colori.")
    next_rows, changes = {}, []
    eligible = set(eligible_booking_ids) if eligible_booking_ids is not None else None
    # Removing the old rule reveals the user's existing backgrounds. Do not
    # replace those with the conditional yellow that was hiding them.
    migrating = reapply is None and previous_state is None and bool(managed or snapshot.get("highlightTransaction"))
    for row in rows:
        date, number, booking = row["date"], row["row"], row["krossId"]
        prior = previous.get(date)
        if ((scope_month and not date.startswith(scope_month + "-"))
                or (scope_dates is not None and date not in scope_dates)):
            if prior:
                next_rows[date] = copy.deepcopy(prior)
            elif isinstance(booking, str) and booking and booking == booking.strip():
                # Establish a baseline without touching unrelated months.
                next_rows[date] = {"row": number, "krossId": booking, "originals": {}}
            continue
        colors = copy.deepcopy(row["backgrounds"])
        if reapply is not None:
            originals = {column: copy.deepcopy(
                prior["originals"][column] if prior and prior["krossId"] == booking
                and column in prior["originals"] and same_background(colors[column], YELLOW)
                else colors[column]) for column in COLUMNS}
            next_rows[date] = {"row": number, "krossId": booking, "originals": originals}
            for column in COLUMNS:
                if not same_background(colors[column], YELLOW):
                    changes.append({"row": number, "column": column,
                                    "before": colors[column], "after": copy.deepcopy(YELLOW)})
            continue
        if prior and prior["krossId"] == booking:
            next_rows[date] = {**copy.deepcopy(prior), "row": number}
            continue
        if prior:
            # Release the previous booking's untouched yellow before taking
            # the next booking's baseline. Manual colors stay in the baseline.
            for column, original in prior["originals"].items():
                if same_background(colors[column], YELLOW):
                    colors[column] = copy.deepcopy(original)
        if booking:
            # A different ID starts a new booking baseline, even over migrated
            # or manually recolored cells. Eligible source bookings start yellow
            # once; imports of that same ID preserve later manual edits above.
            paint = not migrating and (eligible is None or booking in eligible)
            originals = copy.deepcopy(colors) if paint else {}
            next_rows[date] = {"row": number, "krossId": booking, "originals": originals}
            if paint:
                for column in COLUMNS:
                    colors[column] = copy.deepcopy(YELLOW)
        for column in COLUMNS:
            before, after = row["backgrounds"][column], colors[column]
            if not same_background(before, after):
                changes.append({"row": number, "column": column,
                                "before": copy.deepcopy(before), "after": copy.deepcopy(after)})
    requests = [{"deleteConditionalFormatRule": {"sheetId": snapshot["sheetId"], "index": index}}
                for index in reversed(managed)]
    requests.extend(background_request(snapshot["sheetId"], change["row"], change["column"], change["after"])
                    for change in changes)
    active_rows = [row for row in rows if (scope_month is None or row["date"].startswith(scope_month + "-"))
                   and (scope_dates is None or row["date"] in scope_dates)]
    first = min((row["row"] for row in active_rows), default=None)
    last = max((row["row"] for row in active_rows), default=None)
    return {"needed": bool(requests), "requests": requests, "changes": changes,
            "nextState": {"version": 1, **identity, "rows": next_rows},
            "range": f"C{first}:L{last}" if active_rows else None, "formula": None,
            "occupiedNights": sum(bool(row["krossId"]) for row in active_rows),
            "calendarNights": len(active_rows), "managedRuleIndices": managed,
            "migration": migrating, "scopeMonth": scope_month,
            "scopeDates": sorted(scope_dates) if scope_dates is not None else None,
            "eligibleBookingIds": sorted(eligible) if eligible is not None else None,
            "reapply": copy.deepcopy(reapply), **identity}
