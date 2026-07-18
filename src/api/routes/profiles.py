"""
Document profile API routes.

Exposes the built-in document *profiles* registered in
``src/profiles/*.py`` (generic-document, medical-rcm, finance) so the
frontend Profiles gallery renders live capability data instead of a
hardcoded list. Profiles are the orthogonal axis to document *type*:
they tune detection signals, prompt notes, validator packs, and export
emitters per document category.

There is no persistence layer for profiles — they are code-defined
descriptors — so this router is read-only.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from src.config import get_logger


logger = get_logger(__name__)
router = APIRouter()


def _profile_to_card(descriptor: Any) -> dict[str, Any]:
    """Project a ``ProfileDescriptor`` onto the gallery card shape.

    Every value here comes straight off the registered descriptor —
    nothing is invented. ``validator_count`` is the number of validator
    packs the profile declares; ``emitters`` are the profile-specific
    export emitters (baseline emitters like JSON/Excel are a frontend
    concern shared by every profile).
    """
    return {
        "id": descriptor.name,
        "name": descriptor.display_name,
        "description": descriptor.description,
        "doc_types": list(descriptor.doc_types),
        "validator_count": len(descriptor.validator_packs),
        "validator_packs": dict(descriptor.validator_packs),
        "emitters": list(descriptor.enabled_emitters),
        "schema_overlay_fields": list(descriptor.schema_overlay_fields),
        "confidence_floor": descriptor.confidence_floor,
        "tier": "built-in",
    }


@router.get(
    "/profiles",
    summary="List document profiles",
    description=(
        "Enumerate the built-in document profiles registered in "
        "src/profiles. Each profile tunes detection signals, prompt "
        "notes, validator packs, and export emitters per document "
        "category."
    ),
)
async def list_profiles(http_request: Request) -> list[dict[str, Any]]:
    """List all registered document profiles (registration order)."""
    request_id = getattr(http_request.state, "request_id", "")

    from src.profiles.registry import ProfileRegistry

    descriptors = ProfileRegistry().all()
    cards = [_profile_to_card(d) for d in descriptors]

    logger.info("list_profiles_request", request_id=request_id, count=len(cards))
    return cards
