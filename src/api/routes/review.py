"""
Human-in-the-loop (HITL) review queue API routes.

Surfaces documents the pipeline flagged for a human decision — those
whose stored result carries ``requires_human_review == True`` — by
walking the result store and projecting each flagged document onto the
review-queue shape the frontend consumes.

Read-only. Approve/reject is intentionally NOT exposed here: resolving
a review means resuming the orchestrator from a LangGraph
``interrupt()`` with human corrections (see
``src.pipeline.runner.resume_extraction``), which requires a live
orchestrator holding the paused checkpoint for that document. That
state isn't guaranteed to exist in every deployment (the same reason
``GET /documents/{id}/pages`` can 404), so wiring approve/reject here
would silently fail. The review screen records decisions locally and
says so, rather than pretending a write succeeded.
"""

from __future__ import annotations

from pathlib import PurePath
from typing import Any

from fastapi import APIRouter, Request

from src.config import get_logger


logger = get_logger(__name__)
router = APIRouter()

# Fields at or above this confidence are considered clean; below it (or
# failing validation / pass-agreement) they surface as "flagged".
_FLAG_CONFIDENCE = 0.85


def _unwrap_value(raw: Any) -> Any:
    """Extract a scalar value from either a scalar or ``{"value": …}``."""
    if isinstance(raw, dict) and "value" in raw:
        return raw["value"]
    return raw


def _flag_reason(meta: dict[str, Any], confidence: float) -> str | None:
    """Return a human reason a field is flagged, or None if it's clean."""
    if meta.get("validation_passed") is False:
        return "Failed validation"
    if meta.get("passes_agree") is False:
        return "Extraction passes disagree"
    if confidence < _FLAG_CONFIDENCE:
        return f"Low confidence ({confidence * 100:.0f}%)"
    return None


def _derive_flagged_fields(result: dict[str, Any]) -> list[dict[str, Any]]:
    """Build the flagged-field list from a stored result's metadata."""
    field_metadata = result.get("field_metadata") or {}
    values = result.get("merged_extraction")
    if not isinstance(values, dict):
        values = result.get("data") or {}

    flagged: list[dict[str, Any]] = []
    if isinstance(field_metadata, dict):
        for name, meta in field_metadata.items():
            if not isinstance(meta, dict):
                continue
            confidence = float(meta.get("confidence", 0.0) or 0.0)
            reason = _flag_reason(meta, confidence)
            if reason is None:
                continue
            value = _unwrap_value(values.get(name)) if isinstance(values, dict) else None
            flagged.append(
                {
                    "name": name,
                    "value": "" if value is None else str(value),
                    "confidence": confidence,
                    "reason": reason,
                }
            )

    # Worst confidence first — that's where a reviewer should look.
    flagged.sort(key=lambda f: f["confidence"])
    return flagged


def _project_queue_doc(result: dict[str, Any]) -> dict[str, Any]:
    """Project a stored result onto the review-queue document shape."""
    metadata = result.get("metadata") if isinstance(result.get("metadata"), dict) else {}
    pdf_path = result.get("pdf_path") or metadata.get("pdf_path") or ""
    filename = PurePath(pdf_path).name if pdf_path else result.get("processing_id", "document")

    profile = (
        result.get("profile_name")
        or result.get("selected_profile")
        or result.get("document_type")
        or metadata.get("document_type")
        or metadata.get("schema_name")
        or "generic-document"
    )

    return {
        "id": result.get("processing_id", ""),
        "filename": filename,
        "profile": profile,
        "confidence": float(result.get("overall_confidence", 0.0) or 0.0),
        "reason": result.get("human_review_reason", "") or "",
        "flaggedFields": _derive_flagged_fields(result),
    }


@router.get(
    "/review/queue",
    summary="HITL review queue",
    description=(
        "List documents flagged for human review (stored results with "
        "requires_human_review == True), worst confidence first. "
        "Read-only; derived live from the result store."
    ),
)
async def get_review_queue(
    http_request: Request,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Return the HITL review queue derived from the result store."""
    request_id = getattr(http_request.state, "request_id", "")
    limit = max(1, min(limit, 500))

    from src.storage.result_store import get_result_store

    store = get_result_store()
    queue: list[dict[str, Any]] = []
    # Scan a generous window of recent results; only the flagged ones
    # make it into the queue.
    for summary in store.list_results(limit=500, offset=0):
        pid = summary.get("processing_id")
        if not isinstance(pid, str):
            continue
        full = store.get(pid)
        if not isinstance(full, dict):
            continue
        if not full.get("requires_human_review"):
            continue
        queue.append(_project_queue_doc(full))
        if len(queue) >= limit:
            break

    queue.sort(key=lambda d: d["confidence"])

    logger.info("review_queue_request", request_id=request_id, count=len(queue))
    return queue
