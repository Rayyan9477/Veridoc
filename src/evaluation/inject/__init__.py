"""Hallucination-injection harness (promoted to first-party ``src``).

Mutates a known-good extraction with one of six well-defined
distortions and scores whether the verification society (pattern
detector / validator / Critic / bbox round-trip) catches it. The
catch-rate per (layer, injection_type) is the headline robustness
metric of the experiment spine.

Six injection types (see :class:`InjectionType`):

* ``value_swap`` — swap two field values across the document.
* ``amount_fake`` — replace a currency amount with a plausible fake.
* ``phantom_field`` — invent a field that isn't on the page.
* ``bbox_drift`` — keep the value but move its bbox to another region.
* ``field_drop`` — drop a required field entirely.
* ``placeholder_inject`` — replace a value with a textbook placeholder.
"""

from src.evaluation.inject.catch_rate import (
    LayerFn,
    default_pattern_hits,
    pattern_layer_fn,
    run_injection_suite,
    validator_layer_fn,
)
from src.evaluation.inject.report import (
    CAUGHT,
    MISSED,
    NOT_APPLICABLE,
    TRACKED_LAYERS,
    InjectionReport,
    classify_caught,
    confusion_matrix,
)
from src.evaluation.inject.runner import (
    InjectionConfig,
    InjectionResult,
    InjectionRunner,
    InjectionType,
)


__all__ = [
    # runner
    "InjectionType",
    "InjectionConfig",
    "InjectionResult",
    "InjectionRunner",
    # report
    "CAUGHT",
    "MISSED",
    "NOT_APPLICABLE",
    "TRACKED_LAYERS",
    "classify_caught",
    "confusion_matrix",
    "InjectionReport",
    # catch-rate suite
    "LayerFn",
    "default_pattern_hits",
    "pattern_layer_fn",
    "validator_layer_fn",
    "run_injection_suite",
]
