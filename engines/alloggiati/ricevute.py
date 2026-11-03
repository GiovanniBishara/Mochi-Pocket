"""Inspect and archive Alloggiati receipts without changing their PDF bytes."""

from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import re
import stat
import sys


sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))
logging.getLogger("pypdf").addHandler(logging.NullHandler())
logging.getLogger("pypdf").propagate = False
logging.getLogger("pypdf").setLevel(logging.CRITICAL)


class ReceiptError(Exception):
    """An error code safe to show without PDF contents or credentials."""


@dataclass(frozen=True)
class Receipt:
    path: Path
    login: str
    receipt_id: str
    sent_date: str
    year: int
    filename: str
    text_hash: str
    byte_hash: str

    @property
    def identity(self) -> tuple[str, str, str]:
        return self.login, self.receipt_id, self.sent_date

    @property
    def signature(self) -> tuple[tuple[str, str, str], str]:
        return self.identity, self.text_hash

    @property
    def archive_key(self) -> tuple[int, str]:
        return self.year, self.filename

    @property
    def chronological_key(self) -> tuple[str, int, str, str, str]:
        # Receipt numbers are identifiers, not a substitute for the sending date.
        # Keep the order stable even if folders or source filenames arrive reversed.
        return self.sent_date, self.year, self.filename, self.byte_hash, str(self.path).casefold()

    def as_json(self) -> dict:
        return {
            "filename": self.filename,
            "login": self.login,
            "receiptId": self.receipt_id,
            "sentDate": self.sent_date,
            "textHash": self.text_hash,
            "byteHash": self.byte_hash,
        }


def _is_link(info: os.stat_result) -> bool:
    if stat.S_ISLNK(info.st_mode):
        return True
    reparse = bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )
    if not reparse:
        return False
    # Reparse points also represent cloud data placeholders. The name-surrogate
    # bit identifies tags that redirect names (including symlinks/junctions).
    # A missing tag is ambiguous, so preserve/skip that entry conservatively.
    tag = getattr(info, "st_reparse_tag", 0)
    return not tag or bool(tag & 0x20000000)


def _within(path: Path, root: Path) -> bool:
    return path == root or path.is_relative_to(root)


def _checked_path(path: Path, root: Path | None = None) -> Path:
    try:
        info = path.lstat()
        if _is_link(info):
            raise ReceiptError("link_not_allowed")
        resolved = path.resolve(strict=True)
        if root is not None:
            if not _within(resolved, root):
                raise ReceiptError("path_outside_root")
            # Every component below the root must remain an ordinary directory.
            relative = path.absolute().relative_to(root)
            current = root
            for part in relative.parts[:-1]:
                current = current / part
                if _is_link(current.lstat()):
                    raise ReceiptError("link_not_allowed")
        return resolved
    except ReceiptError:
        raise
    except (OSError, ValueError, RuntimeError):
        raise ReceiptError("path_unavailable") from None


def _root(path: Path) -> Path:
    resolved = _checked_path(path)
    if not resolved.is_dir():
        raise ReceiptError("directory_unavailable")
    return resolved


def _one(pattern: str, text: str) -> tuple:
    matches = set(re.findall(pattern, text, flags=re.IGNORECASE))
    if len(matches) != 1:
        raise ReceiptError("receipt_fields_invalid")
    match = matches.pop()
    return match if isinstance(match, tuple) else (match,)


def inspect_receipt(path: Path | str, root: Path | None = None) -> Receipt:
    """Extract identity and hashes; no PDF is rewritten or repaired."""
    path = Path(path).absolute()
    resolved = _checked_path(path, root)
    try:
        if not stat.S_ISREG(resolved.stat().st_mode):
            raise ReceiptError("file_not_regular")
        raw = resolved.read_bytes()
        if not raw.startswith(b"%PDF-"):
            raise ReceiptError("pdf_invalid")
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(raw), strict=False)
        if reader.is_encrypted:
            raise ReceiptError("pdf_encrypted")
        text = " ".join("\n".join(page.extract_text() or "" for page in reader.pages).split())
        if not text:
            raise ReceiptError("receipt_text_missing")
        (login,) = _one(r"\bLOGIN\s*:?\s*([A-Z]{2}\d{4,10})\b", text)
        year_text, number_text, province = _one(
            r"\bID\.?\s*RICEVUTA\s*:?\s*(\d{4})\s*/\s*(\d{1,12})\s*\[\s*([A-Z]{2})\s*\]",
            text,
        )
        (date_text,) = _one(r"\bDATA\s+DI\s+INVIO\s*:?\s*(\d{1,2}/\d{1,2}/\d{4})\b", text)
        sent_date = datetime.strptime(date_text, "%d/%m/%Y").date().isoformat()
        year, number = int(year_text), int(number_text)
        if not 1900 <= year <= 9999 or number < 1:
            raise ReceiptError("receipt_fields_invalid")
        province = province.upper()
        return Receipt(
            path=resolved,
            login=login.upper(),
            receipt_id=f"{year}/{number} [{province}]",
            sent_date=sent_date,
            year=year,
            filename=f"{year}{number:08d}-{province}.pdf",
            text_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
            byte_hash=hashlib.sha256(raw).hexdigest(),
        )
    except ReceiptError:
        raise
    except ImportError:
        raise ReceiptError("pdf_dependency_unavailable") from None
    except Exception:
        # Third-party parser exceptions can contain text, object data or paths.
        raise ReceiptError("pdf_unreadable") from None


def _record_error(summary: dict, code: str) -> None:
    summary["errors"] += 1
    summary["messages"].append(code)


def _scan(root: Path, summary: dict, source: bool) -> list[Receipt]:
    found = []
    pending = [root]
    counter = "sourceScanned" if source else "destinationScanned"
    while pending:
        directory = pending.pop()
        try:
            _checked_path(directory, root)
            with os.scandir(directory) as entries:
                entries = sorted(entries, key=lambda item: item.name.casefold())
            for entry in entries:
                try:
                    info = entry.stat(follow_symlinks=False)
                    if _is_link(info):
                        summary["skippedLinks"] += 1
                        continue
                    path = Path(entry.path)
                    if stat.S_ISDIR(info.st_mode):
                        if source or entry.name.casefold() != "conflitti":
                            pending.append(path)
                    elif stat.S_ISREG(info.st_mode) and path.suffix.casefold() == ".pdf":
                        summary["scanned"] += 1
                        summary[counter] += 1
                        try:
                            found.append(inspect_receipt(path, root))
                        except ReceiptError as exc:
                            if not source and str(exc) in {
                                "receipt_fields_invalid", "receipt_text_missing", "pdf_invalid"
                            }:
                                summary["unrecognizedDocuments"] += 1
                            else:
                                _record_error(summary, str(exc))
                except OSError:
                    _record_error(summary, "entry_unavailable")
        except (OSError, ReceiptError):
            _record_error(summary, "directory_unavailable")
    return sorted(found, key=lambda receipt: receipt.chronological_key)


def _directory(root: Path, name: str) -> Path:
    # Names are generated internally, never taken from PDF text or CLI paths.
    _checked_path(root, root)
    target = root / name
    try:
        target.mkdir(exist_ok=True)
    except OSError:
        raise ReceiptError("archive_directory_unavailable") from None
    target = _checked_path(target, root)
    if not target.is_dir():
        raise ReceiptError("archive_directory_unavailable")
    return target


def _current(receipt: Receipt, root: Path) -> Receipt:
    current = inspect_receipt(receipt.path, root)
    if current.byte_hash != receipt.byte_hash or current.signature != receipt.signature:
        raise ReceiptError("receipt_changed_during_sync")
    return current


def _copy_new(receipt: Receipt, source_root: Path, target: Path, destination_root: Path) -> bool:
    _current(receipt, source_root)
    raw = receipt.path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != receipt.byte_hash:
        raise ReceiptError("receipt_changed_during_sync")
    parent = _checked_path(target.parent, destination_root)
    if parent != target.parent:
        raise ReceiptError("path_outside_root")
    try:
        with target.open("xb") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        return True
    except FileExistsError:
        return False
    except OSError:
        # Preserve any partial file for review; never overwrite an existing PDF.
        raise ReceiptError("archive_write_failed") from None


def _preserve_conflict(
    receipts: list[Receipt], source_root: Path, destination_root: Path, summary: dict
) -> None:
    try:
        folder = _directory(destination_root, "Conflitti")
    except ReceiptError as exc:
        _record_error(summary, str(exc))
        return
    seen = set()
    for receipt in sorted(receipts, key=lambda item: item.chronological_key):
        if receipt.byte_hash in seen:
            continue
        seen.add(receipt.byte_hash)
        target = folder / f"{Path(receipt.filename).stem}-{receipt.byte_hash}.pdf"
        read_root = source_root if _within(receipt.path, source_root) else destination_root
        try:
            created = _copy_new(receipt, read_root, target, destination_root)
            saved = inspect_receipt(target, destination_root)
            if saved.byte_hash != receipt.byte_hash:
                raise ReceiptError("conflict_file_collision")
            if created:
                summary["conflictCopies"] += 1
        except ReceiptError as exc:
            _record_error(summary, str(exc))


def sync_receipts(source_dir: Path | str, destination: Path | str, expected_login: str) -> dict:
    summary = {
        "written": 0, "duplicatesRemoved": 0, "conflicts": 0, "errors": 0,
        "scanned": 0, "sourceScanned": 0, "destinationScanned": 0,
        "ignoredOtherAccounts": 0, "unrecognizedDocuments": 0,
        "skippedLinks": 0, "conflictCopies": 0,
        "messages": [],
    }
    try:
        login = expected_login.strip().upper()
        if not re.fullmatch(r"[A-Z]{2}\d{4,10}", login):
            raise ReceiptError("expected_login_invalid")
        source_root, destination_root = _root(Path(source_dir)), _root(Path(destination))
        if _within(source_root, destination_root) or _within(destination_root, source_root):
            raise ReceiptError("source_destination_overlap")
    except ReceiptError as exc:
        _record_error(summary, str(exc))
        return summary

    source_receipts = _scan(source_root, summary, True)
    destination_receipts = _scan(destination_root, summary, False)
    groups = defaultdict(list)
    for receipt in source_receipts + destination_receipts:
        if receipt.login != login:
            summary["ignoredOtherAccounts"] += 1
        else:
            groups[receipt.archive_key].append(receipt)

    # Preflight all collisions before any deletion, so iteration order is irrelevant.
    blocked = set()
    for key, receipts in groups.items():
        if len({receipt.signature for receipt in receipts}) > 1:
            blocked.add(key)
        target = destination_root / str(key[0]) / key[1]
        if os.path.lexists(target):
            try:
                existing = inspect_receipt(target, destination_root)
                if existing.signature != receipts[0].signature:
                    blocked.add(key)
                    if existing.login == login and existing.archive_key in groups:
                        blocked.add(existing.archive_key)
            except ReceiptError:
                blocked.add(key)

    for key in sorted(groups, key=lambda item: min(receipt.chronological_key for receipt in groups[item])):
        receipts = groups[key]
        if key in blocked:
            summary["conflicts"] += 1
            summary["messages"].append("receipt_conflict")
            _preserve_conflict(receipts, source_root, destination_root, summary)
            continue
        reference = receipts[0]
        try:
            folder = _directory(destination_root, str(reference.year))
            target = folder / reference.filename
            read_root = source_root if _within(reference.path, source_root) else destination_root
            created = _copy_new(reference, read_root, target, destination_root)
            canonical = inspect_receipt(target, destination_root)
            if canonical.signature != reference.signature:
                summary["conflicts"] += 1
                summary["messages"].append("receipt_conflict")
                _preserve_conflict(receipts, source_root, destination_root, summary)
                continue
            if created:
                summary["written"] += 1
            for receipt in receipts:
                if not _within(receipt.path, destination_root) or receipt.path == target:
                    continue
                try:
                    _current(receipt, destination_root)
                    verified = inspect_receipt(target, destination_root)
                    if verified.signature != receipt.signature or verified.login != login:
                        raise ReceiptError("canonical_verification_failed")
                    # Recheck the resolved path and attributes immediately before removal.
                    safe_path = _checked_path(receipt.path, destination_root)
                    safe_path.unlink()
                    summary["duplicatesRemoved"] += 1
                except (ReceiptError, OSError):
                    _record_error(summary, "duplicate_removal_failed")
        except ReceiptError as exc:
            _record_error(summary, str(exc))
        except OSError:
            _record_error(summary, "archive_operation_failed")
    return summary


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ReceiptError("arguments_invalid")


def main(argv: list[str] | None = None) -> int:
    try:
        parser = _Parser(description="Inspect or archive Alloggiati PDF receipts.")
        commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
        inspect_command = commands.add_parser("inspect")
        inspect_command.add_argument("path")
        sync_command = commands.add_parser("sync")
        sync_command.add_argument("--source-dir", required=True)
        sync_command.add_argument("--destination", required=True)
        sync_command.add_argument("--expected-login", required=True)
        args = parser.parse_args(argv)
        if args.command == "inspect":
            result = inspect_receipt(args.path).as_json()
            exit_code = 0
        else:
            result = sync_receipts(args.source_dir, args.destination, args.expected_login)
            exit_code = int(bool(result["errors"] or result["conflicts"]))
    except ReceiptError as exc:
        result, exit_code = {"error": str(exc), "message": "Operazione non completata."}, 1
    except Exception:
        result, exit_code = {"error": "operation_failed", "message": "Operazione non completata."}, 1
    print(json.dumps(result, ensure_ascii=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
