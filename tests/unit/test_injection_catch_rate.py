"""Tests for the promoted injection harness + catch-rate suite runner.

Covers (a) that the promotion preserves class identity for the existing
``tests.eval.inject`` importers, (b) the VLM-free pattern-detector layer's
precision (no false positives on real content), and (c) the suite runner's
matrix/catch-rate aggregation.
"""

from __future__ import annotations

from src.evaluation.inject import (
    InjectionConfig,
    InjectionReport,
    InjectionType,
    default_pattern_hits,
    pattern_layer_fn,
    run_injection_suite,
    validator_layer_fn,
)
from src.evaluation.inject.runner import InjectionResult, InjectionRunner


# ──────────────────────────────────────────────────────────────────
# Promotion preserves identity for the legacy test importers
# ──────────────────────────────────────────────────────────────────


def test_promotion_preserves_class_identity():
    from tests.eval.inject import InjectionRunner as ShimRunner
    from tests.eval.inject import InjectionType as ShimType
    from tests.eval.inject.report import InjectionReport as ShimReport

    assert ShimRunner is InjectionRunner
    assert ShimType is InjectionType
    assert ShimReport is InjectionReport


# ──────────────────────────────────────────────────────────────────
# Pattern detector precision
# ──────────────────────────────────────────────────────────────────


def test_pattern_hits_flags_placeholders_only():
    hits = default_pattern_hits(
        {
            "name": "John Doe",
            "ssn": "123-45-6789",
            "id": "1111111111",
            "phantom_provider_id": "PHANTOM-9999",
            # Real content that must NOT trip the detector:
            "vendor": "ACME Industrial Supply Co.",
            "note": "final test results attached",
            "total": "$1,231.48",
        }
    )
    assert set(hits) == {"name", "ssn", "id", "phantom_provider_id"}
    assert "vendor" not in hits  # real "ACME …" business name
    assert "note" not in hits  # loose "test" token must not fire


def test_pattern_hits_descends_into_value_envelope():
    hits = default_pattern_hits({"x": {"value": "Jane Doe", "confidence": 0.9}})
    assert hits == ["x"]


# ──────────────────────────────────────────────────────────────────
# Suite runner
# ──────────────────────────────────────────────────────────────────


def _clean_extractions() -> dict[str, dict]:
    return {
        "inv1": {
            "invoice_number": "INV-2024-0417",
            "vendor_name": "ACME Industrial Supply Co.",
            "total": "$1,231.48",
            "bill_to": "Riverside Manufacturing LLC",
        }
    }


def test_run_injection_suite_pattern_layer_catches_phantom_and_placeholder():
    report = run_injection_suite(_clean_extractions(), layer_fn=pattern_layer_fn)
    assert isinstance(report, InjectionReport)
    rates = report.per_layer_catch_rate()["pattern_detector"]
    assert rates["phantom_field"] == 1.0
    assert rates["placeholder_inject"] == 1.0
    # Semantic distortions the pattern layer cannot see by value alone:
    assert rates["value_swap"] == 0.0
    assert rates["amount_fake"] == 0.0


def test_run_injection_suite_reports_config_summary():
    report = run_injection_suite(_clean_extractions(), layer_fn=pattern_layer_fn)
    summary = report.config_summary
    assert summary["records"] == 1
    assert summary["rng_seed"] == InjectionConfig().rng_seed
    assert report.total_rows >= 1


def test_run_injection_suite_restricted_types():
    report = run_injection_suite(
        _clean_extractions(),
        layer_fn=pattern_layer_fn,
        injection_types=[InjectionType.PHANTOM_FIELD],
    )
    assert report.overall_catch_rate("pattern_detector") == 1.0
    assert report.total_rows == 1


def test_validator_layer_fn_runs_stub_validator():
    class _StubValidator:
        def validate(self, extraction, schema=None):
            # Flag any extraction that contains a phantom field.
            return ["phantom"] if "phantom_provider_id" in extraction else []

    layer = validator_layer_fn(_StubValidator(), also_pattern=False)
    report = run_injection_suite(_clean_extractions(), layer_fn=layer)
    # Validator stub catches the phantom-field injection.
    assert report.per_layer_catch_rate()["validator"]["phantom_field"] == 1.0
    # pattern_detector was disabled → not_applicable everywhere (0.0 rate).
    assert report.overall_catch_rate("pattern_detector") == 0.0
