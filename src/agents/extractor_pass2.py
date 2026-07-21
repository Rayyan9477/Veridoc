"""
V3 Phase 2 — Pass 2 (AUDITOR) agent.

Runs against the **secondary** VLM (Gemma 4 31B-VL by default). The
AUDITOR frame mandates bbox-grounding: every value emitted MUST cite
a normalised ``[x1, y1, x2, y2]`` rectangle that contains the value
on the page. The bound ``Pass2AuditorEnvelope`` Pydantic schema makes
bbox-less responses structurally impossible.

The reconciler's bbox-overlap tiebreak (step 2 of the 5-step
tiebreaker) and the bbox round-trip helper both depend on Pass 2
being the bbox-grounded side. This module is therefore the load-
bearing source of bboxes in the dual-VLM pipeline.
"""

from __future__ import annotations

import time
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from src.agents.base import BaseAgent, ExtractionError
from src.client.backends.protocol import VLMRole
from src.client.lm_client import LMStudioClient
from src.config import get_logger, get_settings
from src.pipeline.state import (
    ExtractionState,
    ExtractionStatus,
    update_state,
)
from src.prompts.pass2_auditor import (
    build_pass2_system_prompt,
    build_pass2_user_prompt,
)


logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# AUDITOR schema — bbox-mandated
# ---------------------------------------------------------------------------


class _AuditorFieldRecord(BaseModel):
    """One row of the AUDITOR response.

    Pydantic enforces the bbox shape at decode time. When ``value`` is
    ``null`` the bbox MUST also be ``null`` (the AUDITOR system prompt
    instructs this; the constrained decoder cannot enforce
    inter-field invariants beyond per-field types, so the reconciler
    rejects ``(null, [...])`` pairs as bbox-hallucination).
    """

    model_config = ConfigDict(extra="allow")

    value: Any | None = Field(
        default=None,
        description="Extracted value, or ``null`` if not localisable.",
    )
    confidence: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Self-reported confidence in [0, 1].",
    )
    bbox: list[float] | None = Field(
        default=None,
        description=(
            "Normalised [x1, y1, x2, y2] in [0, 1] for the smallest "
            "rectangle containing the value. ``null`` only when value "
            "is also null."
        ),
    )
    location: str | None = Field(
        default=None,
        description="Optional human-readable location hint.",
    )


class Pass2AuditorEnvelope(BaseModel):
    """Pass 2 response envelope: ``fields`` keyed by field name.

    Decoder must emit a JSON object with a ``fields`` key whose values
    are ``_AuditorFieldRecord`` shapes. The reconciler reads
    ``response["fields"][name]["bbox"]`` directly.
    """

    fields: dict[str, _AuditorFieldRecord] = Field(
        default_factory=dict,
        description="Field name -> AUDITOR record with mandatory bbox.",
    )

    # Allow extra top-level keys (some VLMs add ``page_number``,
    # ``extraction_notes``, ``quality_issues``); they pass through.
    model_config = ConfigDict(extra="allow")


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


class ExtractorPass2Agent(BaseAgent):
    """Pass 2 / AUDITOR — secondary-VLM bbox-mandated extraction."""

    AGENT_NAME = "extractor_pass2"

    def __init__(
        self,
        client: LMStudioClient | None = None,
        model_router: Any | None = None,
    ) -> None:
        super().__init__(
            name=self.AGENT_NAME,
            client=client,
            model_router=model_router,
        )
        self._settings = get_settings()

    # ------------------------------------------------------------------
    # LangGraph entry point
    # ------------------------------------------------------------------

    def process(self, state: ExtractionState) -> ExtractionState:
        page_images = state.get("page_images", [])
        if not page_images:
            raise ExtractionError(
                "Pass 2 invoked with no page images",
                agent_name=self.name,
                recoverable=False,
            )

        document_type = state.get("document_type", "UNKNOWN")
        modalities = list(state.get("modalities", []) or [])
        # V3 Phase 5: profile flows through to the AUDITOR prompt.
        profile = state.get("profile") or None
        field_defs = self._resolve_field_defs(state)

        pass2_result: dict[int, dict[str, Any]] = {}
        total_latency_ms = 0
        model_id_seen = ""

        system_prompt = build_pass2_system_prompt()

        for page in page_images:
            page_number = page.get("page_number", 0) or 0
            image_data = page.get("data_uri") or page.get("base64_encoded", "")
            if not image_data:
                self._logger.warning(
                    "pass2_skip_blank_page",
                    page_number=page_number,
                )
                continue

            user_prompt = build_pass2_user_prompt(
                schema_fields=field_defs,
                document_type=document_type,
                page_number=page_number,
                page_count=len(page_images),
                modalities=modalities,
                profile=profile,
            )

            t0 = time.perf_counter()
            try:
                payload, trace = self.send_vision_request_with_schema(
                    image_data=image_data,
                    prompt=user_prompt,
                    schema=Pass2AuditorEnvelope,
                    system_prompt=system_prompt,
                    temperature=0.2,  # slightly different from Pass 1's 0.1
                    max_tokens=6000,
                    role=VLMRole.SECONDARY,
                )
            except Exception as exc:  # noqa: BLE001
                latency_ms = int((time.perf_counter() - t0) * 1000)
                total_latency_ms += latency_ms
                self._logger.warning(
                    "pass2_page_failed",
                    page_number=page_number,
                    error=str(exc),
                    latency_ms=latency_ms,
                )
                pass2_result[page_number] = {
                    "_pass2_error": str(exc),
                    "fields": {},
                }
                continue

            latency_ms = int((time.perf_counter() - t0) * 1000)
            total_latency_ms += latency_ms
            model_id_seen = trace.model_id or model_id_seen

            normalised = self._normalise_payload(payload)
            pass2_result[page_number] = normalised

            self._logger.debug(
                "pass2_page_complete",
                page_number=page_number,
                latency_ms=latency_ms,
                model_id=trace.model_id,
                schema_enforced=trace.schema_enforced,
                bbox_count=self._count_bboxes(normalised),
            )

        self._logger.info(
            "pass2_complete",
            pages_processed=len(pass2_result),
            total_latency_ms=total_latency_ms,
            model_id=model_id_seen,
        )

        return update_state(
            state,
            {
                "pass2_result": pass2_result,
                "pass2_model_id": model_id_seen,
                "pass2_latency_ms": total_latency_ms,
                # NB: ``set_status`` returns the *full* ExtractionState;
                # spreading it here would clobber the freshly-written
                # ``pass2_result`` above. Write the status fragment
                # directly instead.
                "status": ExtractionStatus.EXTRACTING.value,
            },
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _resolve_field_defs(self, state: ExtractionState) -> list[dict[str, Any]]:
        """Same shape as Pass 1 — keep them in sync via the same source."""
        adaptive = state.get("adaptive_schema") or {}
        if adaptive and isinstance(adaptive, dict):
            fields = adaptive.get("fields") or []
            if isinstance(fields, list) and fields:
                return [f if isinstance(f, dict) else {} for f in fields]

        try:
            from src.schemas import SchemaRegistry

            schema_name = state.get("selected_schema_name")
            if schema_name:
                schema = SchemaRegistry.get(schema_name)
                if schema is not None:
                    return [
                        f.to_dict() if hasattr(f, "to_dict") else dict(f)
                        for f in getattr(schema, "fields", [])
                    ]
        except Exception as exc:
            self._logger.warning(
                "pass2_schema_resolution_failed",
                error=str(exc),
            )
        return []

    # Keys that identify a value-bearing AUDITOR record, used to detect a
    # response whose field records sit at the top level instead of under
    # ``fields``. ``location`` is deliberately excluded — too generic.
    _RECORD_KEYS = frozenset({"value", "bbox", "confidence"})

    @classmethod
    def _unwrap_fields(cls, payload: dict[str, Any]) -> dict[str, Any]:
        """Return the field mapping, tolerating a missing ``fields`` wrapper.

        Qwen3-VL routinely ignores the envelope and emits records at the
        top level (``{"vendor_name": {...}, "vendor_address": {...}}``).
        Reading ``payload["fields"]`` then yields ``{}`` and every bbox is
        silently dropped, which empties Source View. Detect that shape and
        treat the payload itself as the field mapping.
        """
        fields = payload.get("fields")
        if isinstance(fields, dict) and fields:
            return fields
        candidates = {
            name: record
            for name, record in payload.items()
            if isinstance(record, dict) and cls._RECORD_KEYS & record.keys()
        }
        return candidates if candidates else (fields if isinstance(fields, dict) else {})

    @staticmethod
    def _coerce_bbox(bbox: Any) -> list[float] | None:
        """Coerce a model's bbox into normalised ``[x1, y1, x2, y2]``.

        Accepts the contracted list form and the ``{"x","y","w","h"}`` dict
        form that Qwen3-VL emits instead. The dict form is inconsistent about
        whether ``w``/``h`` mean extent or far-edge, so interpret per axis:
        a value already beyond the origin is a far-edge, otherwise it is an
        extent. Returns ``None`` when the result isn't a usable in-page box.
        """
        if bbox is None:
            return None
        if isinstance(bbox, dict):
            try:
                x1 = float(bbox["x"])
                y1 = float(bbox["y"])
                raw_w = float(bbox["w"])
                raw_h = float(bbox["h"])
            except (KeyError, TypeError, ValueError):
                return None
            x2 = raw_w if raw_w > x1 else x1 + raw_w
            y2 = raw_h if raw_h > y1 else y1 + raw_h
            coords = [x1, y1, x2, y2]
        elif isinstance(bbox, (list, tuple)):
            if len(bbox) != 4:
                return None
            try:
                coords = [float(c) for c in bbox]
            except (TypeError, ValueError):
                return None
        else:
            return None

        # Some models (notably qwen-vl-max) answer in pixels despite the
        # prompt. Anything outside [0, 1] cannot be normalised without the
        # page dimensions, so drop it rather than draw a wrong box.
        if any(c < 0.0 or c > 1.0 for c in coords):
            return None
        if coords[2] <= coords[0] or coords[3] <= coords[1]:
            return None
        return coords

    @classmethod
    def _normalise_payload(cls, payload: dict[str, Any]) -> dict[str, Any]:
        """Normalise the AUDITOR payload to the envelope the reconciler reads.

        Three jobs: recover field records the model left un-wrapped, coerce
        each bbox to ``[x1, y1, x2, y2]``, and reject ``(value=null,
        bbox=[...])`` pairs — the AUDITOR prompt says to null both together,
        so a bbox without a value is a hallucinated coordinate.
        """
        if not isinstance(payload, dict):
            return {"fields": {}}
        fields = cls._unwrap_fields(payload)
        if not isinstance(fields, dict):
            return payload
        cleaned: dict[str, Any] = {}
        for name, record in fields.items():
            if not isinstance(record, dict):
                cleaned[name] = record
                continue
            value = record.get("value")
            if value is None:
                # Fix invariant violation; preserve the rest of the record.
                bbox: list[float] | None = None
            else:
                bbox = cls._coerce_bbox(record.get("bbox"))
            cleaned[name] = {**record, "bbox": bbox}
        out = {k: v for k, v in payload.items() if k not in cleaned}
        out["fields"] = cleaned
        return out

    @staticmethod
    def _count_bboxes(payload: dict[str, Any]) -> int:
        """Telemetry: how many bboxes Pass 2 actually grounded."""
        if not isinstance(payload, dict):
            return 0
        fields = payload.get("fields", {})
        if not isinstance(fields, dict):
            return 0
        return sum(
            1
            for r in fields.values()
            if isinstance(r, dict) and r.get("bbox") is not None
        )
