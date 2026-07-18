"""
Audit log query API routes.

Provides read + export access over the tamper-evident, hash-chained
audit log that ``src/security/audit.py`` writes as JSON-Lines under
``logs/audit/audit_*.jsonl`` (older files rotated to ``.jsonl.gz``).

This router is read-only: it never writes to the chain, so it cannot
break the hash chain. Integrity verification lives separately in
``src.security.audit.verify_audit_chain``.

Honest-empty behaviour: when no audit files exist (fresh deployment)
the endpoints return an empty result set rather than fabricating rows.
"""

from __future__ import annotations

import csv
import gzip
import io
import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from src.config import get_logger


logger = get_logger(__name__)
router = APIRouter()

# Hard cap on how many lines we parse across all files for a single
# query. Protects the endpoint from an unbounded log directory. The
# most-recent files are read first, so this always yields the newest
# entries.
_MAX_SCAN_LINES = 20000


def _audit_log_dir() -> Path:
    """Resolve the audit log directory (settings override, else default)."""
    try:
        from src.config import get_settings

        settings = get_settings()
        candidate = getattr(getattr(settings, "audit", None), "log_dir", None)
        if candidate:
            return Path(candidate)
    except Exception:
        pass
    return Path("./logs/audit")


def _iter_lines_newest_first(log_dir: Path):
    """Yield raw JSONL lines newest-first across audit files.

    Files are named ``audit_<YYYY-MM-DD>.jsonl`` (and ``.jsonl.gz``),
    so sorting filenames descending orders them newest-day-first.
    Within a file, appended entries are chronological, so we reverse
    each file's lines to surface its newest entry first.
    """
    if not log_dir.exists():
        return

    files = sorted(
        list(log_dir.glob("audit_*.jsonl")) + list(log_dir.glob("audit_*.jsonl.gz")),
        key=lambda p: p.name,
        reverse=True,
    )
    for path in files:
        try:
            if path.suffix == ".gz":
                with gzip.open(path, "rt", encoding="utf-8") as fh:
                    lines = fh.readlines()
            else:
                with path.open("r", encoding="utf-8") as fh:
                    lines = fh.readlines()
        except OSError:
            continue
        for line in reversed(lines):
            line = line.strip()
            if line:
                yield line


def _normalise(record: dict[str, Any]) -> dict[str, Any]:
    """Flatten a raw audit record onto the shape the UI table consumes."""
    context = record.get("context", {}) or {}
    metadata = context.get("metadata", {}) or {}
    return {
        "event_id": record.get("event_id", ""),
        "timestamp": record.get("timestamp", ""),
        "event_type": record.get("event_type", ""),
        "severity": record.get("severity", ""),
        "outcome": record.get("outcome", ""),
        "message": record.get("message", ""),
        "actor": context.get("user_id") or "",
        "client_ip": context.get("client_ip") or "",
        "resource_type": context.get("resource_type") or "",
        "resource_id": context.get("resource_id") or "",
        "tenant_id": context.get("tenant_id") or "",
        "trace_id": context.get("trace_id") or "",
        "request_id": context.get("request_id") or "",
        "http_path": metadata.get("http_path") or "",
    }


def _matches(
    entry: dict[str, Any],
    *,
    date_from: str | None,
    date_to: str | None,
    actor: str | None,
    event: str | None,
    tenant: str | None,
    q: str | None,
) -> bool:
    """Apply the query filters to one normalised entry."""
    ts = entry.get("timestamp", "")
    if date_from and ts and ts[:10] < date_from:
        return False
    if date_to and ts and ts[:10] > date_to:
        return False
    if actor and actor.lower() not in entry.get("actor", "").lower():
        return False
    if event and event.lower() not in entry.get("event_type", "").lower():
        return False
    if tenant and tenant.lower() not in entry.get("tenant_id", "").lower():
        return False
    if q:
        ql = q.lower()
        haystack = " ".join(
            str(entry.get(k, ""))
            for k in ("message", "event_type", "actor", "resource_id", "http_path")
        ).lower()
        if ql not in haystack:
            return False
    return True


def read_audit_entries(
    log_dir: Path | str,
    *,
    date_from: str | None = None,
    date_to: str | None = None,
    actor: str | None = None,
    event: str | None = None,
    tenant: str | None = None,
    q: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    """Read + filter audit entries newest-first.

    Returns ``(entries, scanned)`` where ``scanned`` is how many raw
    lines were inspected (capped at ``_MAX_SCAN_LINES``).
    """
    log_dir = Path(log_dir)
    limit = max(1, min(limit, 1000))
    offset = max(0, offset)

    matched: list[dict[str, Any]] = []
    scanned = 0
    for line in _iter_lines_newest_first(log_dir):
        if scanned >= _MAX_SCAN_LINES:
            break
        scanned += 1
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        entry = _normalise(record)
        if _matches(
            entry,
            date_from=date_from,
            date_to=date_to,
            actor=actor,
            event=event,
            tenant=tenant,
            q=q,
        ):
            matched.append(entry)
            # Stop early once we have enough to satisfy offset+limit.
            if len(matched) >= offset + limit:
                break

    return matched[offset : offset + limit], scanned


@router.get(
    "/audit",
    summary="Query audit log",
    description=(
        "Read recent entries from the tamper-evident audit chain, "
        "newest first, with optional date/actor/event/tenant/text "
        "filters. Read-only — does not touch the hash chain."
    ),
)
async def query_audit(
    http_request: Request,
    date_from: str | None = None,
    date_to: str | None = None,
    actor: str | None = None,
    event: str | None = None,
    tenant: str | None = None,
    q: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """Query audit entries with filters."""
    request_id = getattr(http_request.state, "request_id", "")

    entries, scanned = read_audit_entries(
        _audit_log_dir(),
        date_from=date_from,
        date_to=date_to,
        actor=actor,
        event=event,
        tenant=tenant,
        q=q,
        limit=limit,
        offset=offset,
    )

    logger.info(
        "audit_query_request",
        request_id=request_id,
        returned=len(entries),
        scanned=scanned,
    )

    return {
        "entries": entries,
        "count": len(entries),
        "scanned": scanned,
    }


_EXPORT_COLUMNS = [
    "timestamp",
    "actor",
    "event_type",
    "outcome",
    "resource_type",
    "resource_id",
    "tenant_id",
    "message",
    "event_id",
]


@router.get(
    "/audit/export",
    summary="Export audit log",
    description=(
        "Export filtered audit entries as a downloadable JSONL or CSV "
        "file. Same filters as GET /audit."
    ),
)
async def export_audit(
    http_request: Request,
    format: str = "jsonl",
    date_from: str | None = None,
    date_to: str | None = None,
    actor: str | None = None,
    event: str | None = None,
    tenant: str | None = None,
    q: str | None = None,
    limit: int = 1000,
) -> StreamingResponse:
    """Export audit entries as JSONL or CSV."""
    request_id = getattr(http_request.state, "request_id", "")
    fmt = (format or "jsonl").lower()
    if fmt not in ("jsonl", "csv"):
        fmt = "jsonl"

    entries, _ = read_audit_entries(
        _audit_log_dir(),
        date_from=date_from,
        date_to=date_to,
        actor=actor,
        event=event,
        tenant=tenant,
        q=q,
        limit=limit,
    )

    logger.info(
        "audit_export_request",
        request_id=request_id,
        format=fmt,
        returned=len(entries),
    )

    if fmt == "csv":
        buffer = io.StringIO()
        writer = csv.DictWriter(
            buffer, fieldnames=_EXPORT_COLUMNS, extrasaction="ignore"
        )
        writer.writeheader()
        for entry in entries:
            writer.writerow(entry)
        content = buffer.getvalue()
        media_type = "text/csv"
        filename = "audit_export.csv"
    else:
        content = "\n".join(json.dumps(e, separators=(",", ":")) for e in entries)
        media_type = "application/x-ndjson"
        filename = "audit_export.jsonl"

    return StreamingResponse(
        iter([content]),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
