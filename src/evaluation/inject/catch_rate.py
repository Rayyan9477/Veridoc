"""Injection catch-rate suite runner.

Ties the deterministic mutation engine (:mod:`~src.evaluation.inject.runner`)
to the verification layers and aggregates the result into an
:class:`~src.evaluation.inject.report.InjectionReport`.

A *layer function* takes one :class:`InjectionResult` and returns a
``{layer: verdict}`` map (via :func:`classify_caught`). Two layer
functions ship here:

* :func:`pattern_layer_fn` — a real, VLM-free pre-Critic pattern
  detector. It flags textbook placeholders and test-data sentinels
  (``John Doe``, ``123-45-6789``, ``PHANTOM-*``, repeated-digit IDs).
  It genuinely catches ``placeholder_inject`` / ``phantom_field`` and
  genuinely *misses* semantic distortions (``value_swap``,
  ``amount_fake``) — those need the validator/Critic layers, which are
  wired against live Qwen at deploy.
* :func:`validator_layer_fn` — builder that runs a real ``ValidatorAgent``
  over the mutated extraction for the ``validator`` layer (offline-capable
  rule checks). The ``critic`` and ``bbox_roundtrip`` layers require a VLM
  and are supplied by the caller at deploy.

Run the whole thing with :func:`run_injection_suite`.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from src.evaluation.inject.report import (
    InjectionReport,
    classify_caught,
)
from src.evaluation.inject.runner import (
    InjectionConfig,
    InjectionResult,
    InjectionRunner,
    InjectionType,
)


LayerFn = Callable[[InjectionResult], dict[str, str]]


# ---------------------------------------------------------------------------
# Pattern-detector layer (VLM-free, real)
# ---------------------------------------------------------------------------

# Textbook placeholders / test-data sentinels a pre-Critic pattern
# detector legitimately catches by value alone — independent of which
# field they land in. Kept deliberately precise (full placeholder
# phrases, not loose tokens) so it never fires on real content such as a
# genuine "ACME Industrial Supply Co." vendor or a "test results" note.
_PLACEHOLDER_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bphantom\b", re.IGNORECASE),          # phantom-field sentinel
    re.compile(r"\b(john|jane)\s+doe\b", re.IGNORECASE),
    re.compile(r"\bacme\s+corporation\b", re.IGNORECASE),
    re.compile(r"\btest\s+patient\b", re.IGNORECASE),
    re.compile(r"^\s*123-?45-?6789\s*$"),               # canonical test SSN
    re.compile(r"^\s*(\d)\1{6,}\s*$"),                  # 1111111111 repeated-digit IDs
    re.compile(r"\bx{4,}\b", re.IGNORECASE),            # XXXX redaction stand-ins
)


def default_pattern_hits(extraction: dict[str, Any]) -> list[str]:
    """Return the field names whose value trips a placeholder pattern.

    Descends one level into ``{value: ...}`` envelopes so it works on
    both flat extractions and provenance-wrapped ones.
    """
    hits: list[str] = []
    for name, raw in extraction.items():
        value = raw.get("value") if isinstance(raw, dict) else raw
        if not isinstance(value, str) or not value.strip():
            continue
        if any(p.search(value) for p in _PLACEHOLDER_PATTERNS):
            hits.append(name)
    return hits


def pattern_layer_fn(result: InjectionResult) -> dict[str, str]:
    """Layer fn: run only the (VLM-free) pattern detector.

    The other three layers are reported ``not_applicable`` — they need
    live validator/Critic wiring, supplied at deploy.
    """
    hits = default_pattern_hits(result.mutated_extraction)
    return classify_caught(pattern_hits=hits)


def validator_layer_fn(
    validator: Any,
    *,
    schema: Any = None,
    also_pattern: bool = True,
) -> LayerFn:
    """Build a layer fn that runs a real ``ValidatorAgent`` (rule checks)
    on each mutated extraction for the ``validator`` layer.

    ``validator`` must expose a callable returning a list/collection of
    violations for a given extraction; we treat a non-empty result as a
    catch. Kept duck-typed so unit tests can pass a tiny stub and the
    live wiring (deploy) passes the real agent. When ``also_pattern`` is
    set, the pattern detector runs too (cheap, VLM-free).
    """

    def _fn(result: InjectionResult) -> dict[str, str]:
        violations: list[str] | None = None
        try:
            raw = validator.validate(result.mutated_extraction, schema=schema)
            # Accept a list of violations, or an object exposing them.
            if hasattr(raw, "violations"):
                raw = raw.violations
            violations = [str(v) for v in (raw or [])]
        except Exception:  # pragma: no cover - defensive; live agent varies
            violations = None
        pattern_hits = (
            default_pattern_hits(result.mutated_extraction) if also_pattern else None
        )
        return classify_caught(
            validator_violations=violations,
            pattern_hits=pattern_hits,
        )

    return _fn


# ---------------------------------------------------------------------------
# Suite runner
# ---------------------------------------------------------------------------


def run_injection_suite(
    extractions: dict[str, dict[str, Any]],
    *,
    layer_fn: LayerFn = pattern_layer_fn,
    injection_types: list[InjectionType] | None = None,
    config: InjectionConfig | None = None,
    skip_noops: bool = True,
) -> InjectionReport:
    """Mutate each extraction with every injection type, judge each with
    ``layer_fn``, and aggregate into an :class:`InjectionReport`.

    Args:
        extractions: ``{record_id: extraction_dict}`` — known-good
            extractions (flat ``{field: value}`` or provenance-wrapped).
        layer_fn: maps an ``InjectionResult`` to per-layer verdicts.
        injection_types: subset to run (defaults to all six).
        config: injection tuning knobs.
        skip_noops: drop rows where the injection could not apply (no
            candidate field). Counting a no-op as a "miss" would unfairly
            penalise the layer for an injection that never happened.
    """
    inj_types = injection_types or list(InjectionType)
    cfg = config or InjectionConfig()
    runner = InjectionRunner(cfg)

    rows: list[tuple[InjectionResult, dict[str, str]]] = []
    noops = 0
    for record_id, extraction in extractions.items():
        for inj_type in inj_types:
            result = runner.run(
                extraction, injection_type=inj_type, record_id=record_id
            )
            if skip_noops and result.field_name is None:
                noops += 1
                continue
            rows.append((result, layer_fn(result)))

    return InjectionReport.from_rows(
        rows,
        config_summary={
            "records": len(extractions),
            "injection_types": [t.value for t in inj_types],
            "rows": len(rows),
            "skipped_noops": noops,
            "rng_seed": cfg.rng_seed,
        },
    )


__all__ = [
    "LayerFn",
    "default_pattern_hits",
    "pattern_layer_fn",
    "validator_layer_fn",
    "run_injection_suite",
]
