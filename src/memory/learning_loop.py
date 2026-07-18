"""D1 — HITL learning loops.

Closes the two dormant feedback loops the society already has the parts
for but never wired:

* **Calibration training** — each reviewer decision becomes a
  :class:`CalibrationPoint` (``raw_confidence`` vs. whether the original
  value was actually correct). Points accumulate and the calibrator is
  refit on a cadence, so the confidence the system reports gets steadily
  more trustworthy (ECE ↓).
* **Correction memory** — every changed field is recorded via
  :class:`CorrectionTracker`, so the next extraction's prompt carries a
  learned warning (via :class:`DynamicPromptEnhancer`) and the dual-VLM
  reconciler can prefer values matching human-corrected history.

Everything here is best-effort and opt-in: the orchestrator only builds a
loop when ``settings.calibration.online_learning`` is on, and every call
is guarded so a learning hiccup never breaks an extraction.
"""

from __future__ import annotations

import difflib
from typing import Any

import structlog

from src.validation.calibration import CalibrationPoint


logger = structlog.get_logger(__name__)

# Sentinel so we can tell "field was not in the corrections map" apart from
# "field was corrected to None".
_MISSING = object()


def _norm(value: Any) -> str:
    return str(value).strip().lower() if value is not None else ""


def _similarity(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


class HitlLearningLoop:
    """Turns reviewer corrections into calibration + correction-memory updates.

    Inject a ``calibrator`` (:class:`ConfidenceCalibrator` or
    :class:`PartitionedCalibrator` — both expose ``add_point`` and a fit
    method) and/or a ``correction_tracker``. Either may be ``None``; the
    loop simply skips whatever it doesn't have.
    """

    def __init__(
        self,
        *,
        calibrator: Any = None,
        correction_tracker: Any = None,
        fit_every: int = 10,
    ) -> None:
        self._calibrator = calibrator
        self._tracker = correction_tracker
        self._fit_every = max(1, int(fit_every))
        self._pending = 0

    @property
    def calibrator(self) -> Any:
        return self._calibrator

    @property
    def tracker(self) -> Any:
        return self._tracker

    @property
    def pending(self) -> int:
        return self._pending

    def learn_from_review(
        self,
        *,
        original_extraction: dict[str, Any],
        field_corrections: dict[str, Any] | None,
        document_type: str = "",
        profile: str = "_global",
        tenant_id: str = "_global",
        user_id: str = "default",
    ) -> int:
        """Emit training signal from one reviewed document.

        ``original_extraction`` is the pre-correction ``merged_extraction``
        (``{field: {"value", "confidence", ...}}``) — i.e. what the model
        produced, with its *original* confidences. ``field_corrections`` is
        the ``{field: corrected_value}`` map the reviewer applied.

        For every field with a numeric confidence we record a calibration
        point: ``is_correct`` is False when the reviewer changed the value,
        True otherwise (approved as-is or corrected back to the same value).
        Changed fields additionally land in correction memory.

        Returns the number of calibration points recorded.
        """
        field_corrections = field_corrections or {}
        n_points = 0

        for field_name, env in (original_extraction or {}).items():
            if not isinstance(env, dict):
                continue
            raw_conf = env.get("confidence")
            if not isinstance(raw_conf, (int, float)) or isinstance(raw_conf, bool):
                continue

            original_value = env.get("value")
            corrected = field_corrections.get(field_name, _MISSING)
            changed = corrected is not _MISSING and corrected != original_value
            is_correct = not changed

            if self._calibrator is not None:
                try:
                    self._calibrator.add_point(
                        CalibrationPoint(
                            raw_confidence=float(raw_conf),
                            is_correct=is_correct,
                            field_name=field_name,
                            document_type=document_type,
                            profile=profile or "_global",
                            tenant_id=tenant_id or "_global",
                        )
                    )
                    self._pending += 1
                except Exception as exc:  # pragma: no cover - defensive
                    logger.warning(
                        "calibration_point_add_failed", field=field_name, error=str(exc)
                    )

            if changed and self._tracker is not None:
                try:
                    self._tracker.record_correction(
                        field_name=field_name,
                        original_value=original_value,
                        corrected_value=corrected,
                        document_type=document_type,
                        confidence_before=float(raw_conf),
                        user_id=user_id,
                    )
                except Exception as exc:  # pragma: no cover - defensive
                    logger.warning(
                        "correction_record_failed", field=field_name, error=str(exc)
                    )

            n_points += 1

        self.maybe_fit()
        if n_points:
            logger.info(
                "hitl_learning_applied",
                fields=n_points,
                corrected=len(field_corrections),
                document_type=document_type,
                pending=self._pending,
            )
        return n_points

    def maybe_fit(self, *, force: bool = False) -> Any:
        """Refit the calibrator when enough new points have accumulated."""
        if self._calibrator is None:
            return None
        if not force and self._pending < self._fit_every:
            return None
        self._pending = 0
        try:
            if hasattr(self._calibrator, "fit_all"):
                return self._calibrator.fit_all()  # PartitionedCalibrator
            return self._calibrator.fit()  # ConfidenceCalibrator
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("calibration_fit_failed", error=str(exc))
            return None


class CorrectionHistoryLookup:
    """Field-history lookup for the dual-VLM reconciler's tiebreak step 5.

    Wraps a :class:`CorrectionTracker`: for a candidate value, returns the
    string similarity (0..1) to the most recent human-corrected (known-good)
    value for that field, or 0.0 when there's no history. This lets the
    reconciler prefer the pass whose value matches what reviewers have
    historically accepted. Signature matches the reconciler contract:
    ``(field_name, candidate_value, profile, doc_type) -> float``.
    """

    def __init__(self, tracker: Any, *, limit: int = 5) -> None:
        self._tracker = tracker
        self._limit = limit

    def __call__(
        self,
        field_name: str,
        candidate_value: Any,
        profile: str = "_global",
        doc_type: str = "",
    ) -> float:
        if self._tracker is None or candidate_value in (None, ""):
            return 0.0
        try:
            corrections = self._tracker.get_corrections_for_field(
                field_name, limit=self._limit
            )
        except Exception:  # pragma: no cover - defensive
            return 0.0
        if not corrections:
            return 0.0

        cand = _norm(candidate_value)
        best = 0.0
        for c in corrections:
            known_good = _norm(getattr(c, "corrected_value", None))
            if known_good:
                best = max(best, _similarity(cand, known_good))
        return best


def build_learning_loop(
    settings: Any = None, *, calibrator: Any = None
) -> tuple[HitlLearningLoop | None, Any, Any]:
    """Construct the loop, tracker, and reconciler history lookup — or a
    ``(None, None, None)`` no-op triple when online learning is disabled.

    Reuses the calibrator the orchestrator already built (so validator
    calibration and HITL training share one model + storage path).
    """
    from src.config.settings import get_settings

    s = settings if settings is not None else get_settings()
    if not getattr(s.calibration, "online_learning", False):
        return None, None, None

    tracker = None
    try:
        from src.memory.correction_tracker import CorrectionTracker

        tracker = CorrectionTracker()
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("correction_tracker_init_failed", error=str(exc))

    loop = HitlLearningLoop(
        calibrator=calibrator,
        correction_tracker=tracker,
        fit_every=getattr(s.calibration, "online_fit_every", 10),
    )
    history_lookup = CorrectionHistoryLookup(tracker) if tracker is not None else None
    return loop, tracker, history_lookup


__all__ = [
    "HitlLearningLoop",
    "CorrectionHistoryLookup",
    "build_learning_loop",
]
