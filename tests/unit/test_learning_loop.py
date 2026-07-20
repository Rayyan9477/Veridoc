"""Tests for D1 — HITL learning loops (src/memory/learning_loop.py).

Covers the loop's training signal, the calibration ECE shift (D1's
headline acceptance criterion), the reconciler history lookup, the
settings gate, and the orchestrator wiring in _apply_human_corrections.
No VLM required.
"""

from __future__ import annotations

from src.memory.learning_loop import (
    CorrectionHistoryLookup,
    HitlLearningLoop,
    build_learning_loop,
)
from src.validation.calibration import ConfidenceCalibrator


# ──────────────────────────────────────────────────────────────────
# Fakes
# ──────────────────────────────────────────────────────────────────


class _FakeCalibrator:
    def __init__(self):
        self.points = []
        self.fits = 0

    def add_point(self, point):
        self.points.append(point)

    def fit(self):
        self.fits += 1
        return "linear"


class _FakeTracker:
    def __init__(self, seed=None):
        self.recorded = []
        self._seed = seed or {}

    def record_correction(self, **kwargs):
        self.recorded.append(kwargs)

    def get_corrections_for_field(self, field_name, limit=10):
        return self._seed.get(field_name, [])


class _Corr:
    def __init__(self, corrected_value):
        self.corrected_value = corrected_value


# ──────────────────────────────────────────────────────────────────
# learn_from_review
# ──────────────────────────────────────────────────────────────────


def test_learn_from_review_records_points_and_corrections():
    cal = _FakeCalibrator()
    tracker = _FakeTracker()
    loop = HitlLearningLoop(calibrator=cal, correction_tracker=tracker, fit_every=1000)

    n = loop.learn_from_review(
        original_extraction={
            "vendor": {"value": "ACME", "confidence": 0.7},
            "total": {"value": "$10.00", "confidence": 0.9},
            "date": {"value": "2024-01-01", "confidence": 0.95},
        },
        field_corrections={"vendor": "ACME Corp"},  # only vendor changed
        document_type="invoice",
        profile="finance",
    )

    assert n == 3  # a calibration point per field with a numeric confidence
    assert len(cal.points) == 3
    by_field = {p.field_name: p for p in cal.points}
    assert by_field["vendor"].is_correct is False  # reviewer changed it → wrong
    assert by_field["total"].is_correct is True  # left as-is → correct
    assert by_field["date"].is_correct is True
    assert by_field["vendor"].profile == "finance"

    # Only the changed field lands in correction memory.
    assert len(tracker.recorded) == 1
    assert tracker.recorded[0]["field_name"] == "vendor"
    assert tracker.recorded[0]["corrected_value"] == "ACME Corp"
    assert tracker.recorded[0]["confidence_before"] == 0.7


def test_learn_from_review_correcting_to_same_value_is_correct():
    cal = _FakeCalibrator()
    loop = HitlLearningLoop(calibrator=cal, fit_every=1000)
    loop.learn_from_review(
        original_extraction={"x": {"value": "same", "confidence": 0.8}},
        field_corrections={"x": "same"},  # unchanged value
    )
    assert cal.points[0].is_correct is True


def test_learn_from_review_skips_fields_without_confidence():
    cal = _FakeCalibrator()
    loop = HitlLearningLoop(calibrator=cal, fit_every=1000)
    n = loop.learn_from_review(
        original_extraction={
            "a": {"value": "x", "confidence": 0.9},
            "b": "flat-scalar-no-confidence",
            "c": {"value": "y"},  # dict without confidence
        },
        field_corrections={},
    )
    assert n == 1
    assert len(cal.points) == 1


def test_maybe_fit_cadence():
    cal = _FakeCalibrator()
    loop = HitlLearningLoop(calibrator=cal, fit_every=2)
    loop.learn_from_review(
        original_extraction={"a": {"value": "x", "confidence": 0.9}}, field_corrections={}
    )
    assert cal.fits == 0  # 1 point < fit_every
    loop.learn_from_review(
        original_extraction={"a": {"value": "x", "confidence": 0.9}}, field_corrections={}
    )
    assert cal.fits == 1  # 2 points → fit


# ──────────────────────────────────────────────────────────────────
# D1 acceptance — a simulated HITL correction measurably shifts ECE
# ──────────────────────────────────────────────────────────────────


def test_calibration_ece_improves_after_learning():
    cal = ConfidenceCalibrator()  # storage_path=None → no disk writes
    loop = HitlLearningLoop(calibrator=cal, fit_every=10_000)  # manual fit only

    # 20 documents where a field was reported at 0.9 confidence but the
    # reviewer changed it (overconfident + wrong) …
    for _ in range(20):
        loop.learn_from_review(
            original_extraction={"amount": {"value": "100", "confidence": 0.9}},
            field_corrections={"amount": "200"},
        )
    # … and 5 where 0.9 was actually right.
    for _ in range(5):
        loop.learn_from_review(
            original_extraction={"amount": {"value": "100", "confidence": 0.9}},
            field_corrections={},
        )

    ece_before = cal.evaluate().expected_calibration_error
    loop.maybe_fit(force=True)
    ece_after = cal.evaluate().expected_calibration_error

    # Fitting on the accumulated ground truth should not make calibration
    # worse, and here (accuracy 0.2 at reported 0.9) it improves markedly.
    assert ece_after <= ece_before
    assert ece_after < ece_before  # a real, measurable shift


# ──────────────────────────────────────────────────────────────────
# CorrectionHistoryLookup (reconciler tiebreak step 5)
# ──────────────────────────────────────────────────────────────────


def test_history_lookup_returns_similarity_to_known_good():
    tracker = _FakeTracker(seed={"vendor": [_Corr("ACME Corporation")]})
    lookup = CorrectionHistoryLookup(tracker)
    assert lookup("vendor", "ACME Corporation") == 1.0
    assert lookup("vendor", "Totally Different Inc") < 0.5
    assert lookup("unknown_field", "anything") == 0.0
    assert lookup("vendor", None) == 0.0


# ──────────────────────────────────────────────────────────────────
# Settings gate
# ──────────────────────────────────────────────────────────────────


def test_build_learning_loop_disabled_returns_noop():
    from src.config.settings import Settings

    s = Settings()
    s.calibration.online_learning = False
    loop, tracker, hist = build_learning_loop(s)
    assert loop is None
    assert tracker is None
    assert hist is None


def test_build_learning_loop_enabled_wires_everything(monkeypatch):
    from src.config.settings import Settings

    monkeypatch.setattr(
        "src.memory.correction_tracker.CorrectionTracker", _FakeTracker
    )
    s = Settings()
    s.calibration.online_learning = True
    cal = _FakeCalibrator()
    loop, tracker, hist = build_learning_loop(s, calibrator=cal)
    assert isinstance(loop, HitlLearningLoop)
    assert isinstance(tracker, _FakeTracker)
    assert isinstance(hist, CorrectionHistoryLookup)
    assert loop.calibrator is cal


# ──────────────────────────────────────────────────────────────────
# Orchestrator wiring
# ──────────────────────────────────────────────────────────────────


def test_apply_human_corrections_feeds_learning_loop():
    from src.agents.orchestrator import OrchestratorAgent

    calls = []

    class _SpyLoop:
        def learn_from_review(self, **kwargs):
            calls.append(kwargs)

    orch = OrchestratorAgent(enable_checkpointing=False, learning_loop=_SpyLoop())
    state = {
        "merged_extraction": {
            "vendor": {"value": "ACME", "confidence": 0.7},
            "total": {"value": "$10.00", "confidence": 0.9},
        },
        "document_type": "invoice",
        "processing_id": "p1",
    }
    out = orch._apply_human_corrections(state, {"vendor": "ACME Corp"})

    assert len(calls) == 1
    assert calls[0]["field_corrections"] == {"vendor": "ACME Corp"}
    assert calls[0]["document_type"] == "invoice"
    # The snapshot preserved the ORIGINAL confidence (0.7), not the
    # overwritten 1.0.
    assert calls[0]["original_extraction"]["vendor"]["confidence"] == 0.7
    # And the applied correction did overwrite to 1.0 in the output.
    assert out["merged_extraction"]["vendor"]["confidence"] == 1.0
    assert out["merged_extraction"]["vendor"]["human_corrected"] is True


def test_apply_human_corrections_without_loop_is_noop():
    from src.agents.orchestrator import OrchestratorAgent

    orch = OrchestratorAgent(enable_checkpointing=False)  # no learning loop
    state = {
        "merged_extraction": {"vendor": {"value": "ACME", "confidence": 0.7}},
        "document_type": "invoice",
    }
    out = orch._apply_human_corrections(state, {"vendor": "ACME Corp"})
    assert out["merged_extraction"]["vendor"]["value"] == "ACME Corp"
