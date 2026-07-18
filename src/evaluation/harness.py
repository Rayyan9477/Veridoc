"""Experiment & evaluation harness — the config-driven spine that turns
the Veridoc verification society into a controlled experiment.

An :class:`ExperimentConfig` captures every knob a controlled run cares
about (engine, Critic, per-role models, prompt variant, confidence
thresholds, calibration learning). :func:`run_experiment` applies that
config, runs a golden dataset through the live pipeline (or an injected
extractor, for tests), and returns a combined :class:`ExperimentReport`:

* **extraction F1** — reusing the eval library's metric engine
  (:func:`evaluate_document` / :class:`AggregateMetrics`);
* **calibration ECE/MCE/Brier** — reusing
  :meth:`ConfidenceCalibrator.evaluate`;
* **injection catch-rate** — optional, via
  :func:`src.evaluation.inject.run_injection_suite`.

Nothing here rewrites the eval library, the calibrator, or the pipeline;
it is pure glue plus a config vocabulary. The live extractor path is
exercised end-to-end at deploy (Qwen keys); every metric-shaping code
path is unit-tested with injected extractors so no VLM is required.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from src.evaluation.golden_dataset import GoldenDataset, GoldenSample
from src.evaluation.inject import (
    InjectionReport,
    pattern_layer_fn,
    run_injection_suite,
)
from src.evaluation.inject.catch_rate import LayerFn
from src.evaluation.metrics import (
    AggregateMetrics,
    DocumentMetrics,
    MatchLevel,
    evaluate_document,
)
from src.validation.calibration import (
    CalibrationMetrics,
    CalibrationPoint,
    ConfidenceCalibrator,
)


# ──────────────────────────────────────────────────────────────────
# Extractor shapes
# ──────────────────────────────────────────────────────────────────

# Benchmark-compatible flat extractor: (id, schema, source, meta) -> {field: value}
ExtractorFn = Callable[[str, str, str, dict[str, Any]], dict[str, Any]]


@dataclass(slots=True)
class RichExtraction:
    """One extraction with the extra signal the harness needs beyond values.

    ``values`` is the flat ``{field: value}`` map compared against the
    golden labels; ``confidences`` is the per-field raw confidence used
    to score calibration. Fields with no confidence are simply absent
    from ``confidences`` (and skipped for calibration).
    """

    values: dict[str, Any] = field(default_factory=dict)
    confidences: dict[str, float] = field(default_factory=dict)
    overall_confidence: float = 0.0
    extraction_time_ms: int = 0


# Rich extractor: (id, schema, source, meta) -> RichExtraction
RichExtractorFn = Callable[[str, str, str, dict[str, Any]], RichExtraction]


# ──────────────────────────────────────────────────────────────────
# Experiment configuration
# ──────────────────────────────────────────────────────────────────

# Maps friendly threshold keys (and their canonical settings names) to
# the attribute on ``settings.extraction``.
_THRESHOLD_TO_SETTING: dict[str, str] = {
    "confidence_auto_accept": "confidence_auto_accept",
    "confidence_retry": "confidence_retry",
    "confidence_human_review": "confidence_human_review",
    "critic_min_trust": "critic_min_trust_score",
    "critic_min_trust_score": "critic_min_trust_score",
    "reconciler_bbox_iou": "reconciler_bbox_iou_threshold",
    "reconciler_bbox_iou_threshold": "reconciler_bbox_iou_threshold",
    "reconciler_history_similarity": "reconciler_history_similarity_threshold",
    "reconciler_history_similarity_threshold": "reconciler_history_similarity_threshold",
}

_CONFIG_FIELDS = {
    "name",
    "engine",
    "critic_enabled",
    "role_models",
    "prompt_variant",
    "thresholds",
    "calibration",
    "match_level",
    "field_match_levels",
    "max_samples",
    "filter_tags",
    "filter_types",
}


@dataclass
class ExperimentConfig:
    """A single controlled-experiment configuration.

    Serialisable to/from JSON so an experiment is a file, not a code
    edit. Unknown keys in :meth:`from_dict` are ignored (forward-compat).
    """

    name: str = "experiment"
    engine: str = "legacy"  # "legacy" | "dual_vlm"
    critic_enabled: bool = False
    # role -> model id, e.g. {"primary": "...", "secondary": "...", "critic": "..."}
    role_models: dict[str, str] = field(default_factory=dict)
    prompt_variant: str | None = None
    # friendly-key -> value; see _THRESHOLD_TO_SETTING
    thresholds: dict[str, float] = field(default_factory=dict)
    calibration: bool = False
    match_level: str = "normalized"
    field_match_levels: dict[str, str] = field(default_factory=dict)
    max_samples: int | None = None
    filter_tags: list[str] = field(default_factory=list)
    filter_types: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ExperimentConfig:
        return cls(**{k: v for k, v in data.items() if k in _CONFIG_FIELDS})

    @classmethod
    def from_json_file(cls, path: str | Path) -> ExperimentConfig:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls.from_dict(raw)


# ──────────────────────────────────────────────────────────────────
# Settings application
# ──────────────────────────────────────────────────────────────────


def apply_experiment_config(cfg: ExperimentConfig, settings: Any = None) -> None:
    """Mutate ``settings`` (default: the process singleton) to match ``cfg``.

    Applies engine, Critic, calibration, confidence/reconciler thresholds
    and — best-effort — per-role model ids. Prompt variants are carried on
    the config until the prompt registry (D2.3) consumes them. This mutates
    global state; use :func:`experiment_settings` for a scoped, restoring
    variant.
    """
    from src.config.settings import ExtractionEngine, get_settings

    s = settings if settings is not None else get_settings()

    s.extraction.engine = ExtractionEngine(cfg.engine)
    s.extraction.critic_enabled = bool(cfg.critic_enabled)
    s.calibration.enabled = bool(cfg.calibration)
    # A calibration experiment also drives the D1 live learning loop so HITL
    # corrections train the calibrator + correction memory during the run.
    if hasattr(s.calibration, "online_learning"):
        s.calibration.online_learning = bool(cfg.calibration)

    for key, value in cfg.thresholds.items():
        attr = _THRESHOLD_TO_SETTING.get(key)
        if attr and hasattr(s.extraction, attr):
            setattr(s.extraction, attr, value)

    if cfg.role_models:
        # Forward-compatible generic map (populated by D2's VLMSettings).
        if hasattr(s.vlm, "role_models"):
            s.vlm.role_models = dict(cfg.role_models)
        # Also drive the active backend's per-role model blocks so the
        # rotation takes effect even before D2's generic path lands.
        backend = getattr(s.vlm.backend, "value", s.vlm.backend)
        if backend == "qwen_cloud":
            qc = s.vlm.qwen_cloud
            if cfg.role_models.get("primary"):
                qc.primary_model = cfg.role_models["primary"]
            if cfg.role_models.get("secondary"):
                qc.secondary_model = cfg.role_models["secondary"]
            if cfg.role_models.get("critic"):
                qc.critic_model = cfg.role_models["critic"]


@contextlib.contextmanager
def experiment_settings(cfg: ExperimentConfig, settings: Any = None) -> Iterator[Any]:
    """Apply ``cfg`` for the duration of the ``with`` block, then restore.

    Snapshots exactly the attributes :func:`apply_experiment_config`
    touches so sequential experiments (e.g. an A/B) don't bleed into one
    another via the global settings singleton.
    """
    from src.config.settings import get_settings

    s = settings if settings is not None else get_settings()
    saved: list[tuple[Any, str, Any]] = []

    def track(obj: Any, attr: str) -> None:
        if hasattr(obj, attr):
            saved.append((obj, attr, getattr(obj, attr)))

    track(s.extraction, "engine")
    track(s.extraction, "critic_enabled")
    track(s.calibration, "enabled")
    track(s.calibration, "online_learning")
    for attr in set(_THRESHOLD_TO_SETTING.values()):
        track(s.extraction, attr)
    if hasattr(s.vlm, "role_models"):
        track(s.vlm, "role_models")
    backend = getattr(s.vlm.backend, "value", s.vlm.backend)
    if backend == "qwen_cloud":
        for attr in ("primary_model", "secondary_model", "critic_model"):
            track(s.vlm.qwen_cloud, attr)

    try:
        apply_experiment_config(cfg, s)
        yield s
    finally:
        for obj, attr, value in reversed(saved):
            setattr(obj, attr, value)


# ──────────────────────────────────────────────────────────────────
# Live extractor adapters
# ──────────────────────────────────────────────────────────────────


def _split_envelope(fields: dict[str, Any]) -> tuple[dict[str, Any], dict[str, float]]:
    """Split a ``merged_extraction`` dict into flat values + confidences.

    Handles both the ``{field: {"value": v, "confidence": c}}`` envelope
    and a flat ``{field: value}`` shape.
    """
    values: dict[str, Any] = {}
    confidences: dict[str, float] = {}
    for name, raw in fields.items():
        if isinstance(raw, dict) and "value" in raw:
            values[name] = raw.get("value")
            conf = raw.get("confidence")
            if isinstance(conf, (int, float)):
                confidences[name] = float(conf)
        else:
            values[name] = raw
    return values, confidences


def _load_schema_dict(schema_name: str) -> dict[str, Any] | None:
    """Resolve a schema name to its dict form, or None to auto-detect."""
    try:
        from src import schemas as _schemas

        schema = _schemas.get_schema(schema_name)
        if hasattr(schema, "to_dict"):
            return schema.to_dict()
        if isinstance(schema, dict):
            return schema
    except Exception:
        return None
    return None


def build_rich_extractor_fn(
    cfg: ExperimentConfig, *, runner: Any = None
) -> RichExtractorFn:
    """Wrap the live pipeline into a :data:`RichExtractorFn`.

    When ``runner`` is None a fresh checkpoint-free ``PipelineRunner`` is
    built and ``cfg`` is applied to the global settings once (single-arm
    use). Pass a ``runner`` (with settings already applied, e.g. via
    :func:`experiment_settings`) for scoped/multi-arm use — that path
    does not touch global settings.
    """
    from src.pipeline.runner import PipelineRunner, get_extraction_result

    if runner is None:
        apply_experiment_config(cfg)
        runner = PipelineRunner(enable_checkpointing=False)

    def _extract(
        sample_id: str, schema_name: str, source_file: str, metadata: dict[str, Any]
    ) -> RichExtraction:
        meta = metadata or {}
        state = runner.extract_from_pdf(
            pdf_path=source_file,
            custom_schema=_load_schema_dict(schema_name),
            thread_id=sample_id,
            profile_override=meta.get("profile"),
            modality_override=meta.get("modalities"),
        )
        result = get_extraction_result(state)
        values, confidences = _split_envelope(result.get("fields", {}) or {})
        return RichExtraction(
            values=values,
            confidences=confidences,
            overall_confidence=float(result.get("confidence", 0.0) or 0.0),
            extraction_time_ms=int(result.get("processing_time_ms", 0) or 0),
        )

    return _extract


def build_extractor_fn(cfg: ExperimentConfig, *, runner: Any = None) -> ExtractorFn:
    """Benchmark-compatible extractor: returns flat ``{field: value}``.

    This is the adapter :class:`~src.evaluation.BenchmarkRunner` /
    :class:`~src.evaluation.ABTestRunner` consume directly. It wraps
    :func:`build_rich_extractor_fn` and drops the confidence signal.
    """
    rich = build_rich_extractor_fn(cfg, runner=runner)

    def _extract(
        sample_id: str, schema_name: str, source_file: str, metadata: dict[str, Any]
    ) -> dict[str, Any]:
        return rich(sample_id, schema_name, source_file, metadata).values

    return _extract


# ──────────────────────────────────────────────────────────────────
# Combined experiment report
# ──────────────────────────────────────────────────────────────────


@dataclass(slots=True)
class ExperimentReport:
    """Combined F1 + calibration (+ optional catch-rate) for one config."""

    experiment: str
    aggregate: AggregateMetrics
    calibration: CalibrationMetrics
    injection: InjectionReport | None = None
    num_samples: int = 0
    num_calibration_points: int = 0

    @property
    def micro_f1(self) -> float:
        return self.aggregate.micro_f1

    @property
    def macro_f1(self) -> float:
        return self.aggregate.macro_f1

    @property
    def ece(self) -> float:
        return self.calibration.expected_calibration_error

    @property
    def brier(self) -> float:
        return self.calibration.brier_score

    def to_dict(self) -> dict[str, Any]:
        return {
            "experiment": self.experiment,
            "num_samples": self.num_samples,
            "num_calibration_points": self.num_calibration_points,
            "f1": self.aggregate.to_dict(),
            "calibration": {
                "ece": round(self.calibration.expected_calibration_error, 4),
                "mce": round(self.calibration.max_calibration_error, 4),
                "brier": round(self.calibration.brier_score, 4),
                "num_samples": self.calibration.num_samples,
            },
            "injection": self.injection.to_dict() if self.injection else None,
        }

    def summary(self) -> str:
        line = (
            f"[{self.experiment}] "
            f"micro_F1={self.micro_f1:.3f} macro_F1={self.macro_f1:.3f} "
            f"ECE={self.ece:.3f} Brier={self.brier:.3f} "
            f"(n={self.num_samples} docs, {self.num_calibration_points} conf pts)"
        )
        if self.injection is not None:
            pattern = self.injection.overall_catch_rate("pattern_detector")
            line += f" pattern_catch={pattern:.2f}"
        return line


# ──────────────────────────────────────────────────────────────────
# Runners
# ──────────────────────────────────────────────────────────────────


def _select_samples(dataset: GoldenDataset, cfg: ExperimentConfig) -> list[GoldenSample]:
    samples = list(dataset.samples)
    if cfg.filter_types:
        samples = [s for s in samples if s.document_type in cfg.filter_types]
    if cfg.filter_tags:
        samples = [s for s in samples if any(t in s.tags for t in cfg.filter_tags)]
    if cfg.max_samples is not None:
        samples = samples[: cfg.max_samples]
    return samples


def _evaluate_calibration(
    points: list[CalibrationPoint], fit: bool
) -> CalibrationMetrics:
    """Score calibration of the raw confidences.

    ``evaluate`` runs the confidences through the active calibrator — the
    same path the live validator uses — so the number reflects the
    system's real calibration under this config. With ``fit`` on we first
    fit the calibrator (the learning loop), so the delta between a
    ``calibration: false`` and a ``calibration: true`` run *is* the
    measured effect of the loop.
    """
    if not points:
        return CalibrationMetrics()
    calibrator = ConfidenceCalibrator()  # storage_path=None → no disk writes
    calibrator.add_points(points)
    if fit:
        with contextlib.suppress(Exception):
            calibrator.fit()
    return calibrator.evaluate()


def run_experiment(
    cfg: ExperimentConfig,
    dataset: GoldenDataset,
    *,
    extractor: RichExtractorFn | None = None,
    injection: bool = False,
    injection_layer_fn: LayerFn = pattern_layer_fn,
) -> ExperimentReport:
    """Run ``cfg`` over ``dataset`` and return the combined report.

    Args:
        cfg: the experiment configuration.
        dataset: golden dataset to evaluate against.
        extractor: inject a :data:`RichExtractorFn` (tests / mock mode).
            When None, the live pipeline is built with ``cfg`` applied
            for the duration of the run (scoped + restored).
        injection: also compute the injection catch-rate over the
            extractions produced this run.
        injection_layer_fn: verdict function for the catch-rate suite
            (defaults to the VLM-free pattern detector).
    """
    if extractor is not None:
        return _run(cfg, dataset, extractor, injection, injection_layer_fn)

    with experiment_settings(cfg):
        from src.pipeline.runner import PipelineRunner

        runner = PipelineRunner(enable_checkpointing=False)
        live = build_rich_extractor_fn(cfg, runner=runner)
        return _run(cfg, dataset, live, injection, injection_layer_fn)


def _run(
    cfg: ExperimentConfig,
    dataset: GoldenDataset,
    extractor: RichExtractorFn,
    injection: bool,
    injection_layer_fn: LayerFn,
) -> ExperimentReport:
    samples = _select_samples(dataset, cfg)
    default_level = MatchLevel(cfg.match_level)
    field_levels = {k: MatchLevel(v) for k, v in cfg.field_match_levels.items()}

    doc_metrics: list[DocumentMetrics] = []
    calib_points: list[CalibrationPoint] = []
    extractions: dict[str, dict[str, Any]] = {}

    for sample in samples:
        rich = extractor(
            sample.sample_id, sample.schema_name, sample.source_file, sample.metadata
        )
        extractions[sample.sample_id] = rich.values

        dm = evaluate_document(
            document_id=sample.sample_id,
            schema_name=sample.schema_name,
            expected=sample.expected_fields,
            extracted=rich.values,
            match_level=default_level,
            field_match_levels=field_levels,
            extraction_time_ms=rich.extraction_time_ms,
        )
        doc_metrics.append(dm)

        profile = (sample.metadata or {}).get("profile", "_global")
        for fr in dm.field_results:
            if fr.is_present and fr.field_name in rich.confidences:
                calib_points.append(
                    CalibrationPoint(
                        raw_confidence=rich.confidences[fr.field_name],
                        is_correct=fr.is_match,
                        field_name=fr.field_name,
                        document_type=sample.document_type,
                        profile=profile,
                    )
                )

    aggregate = AggregateMetrics(document_metrics=doc_metrics, dataset_name=dataset.name)
    calibration = _evaluate_calibration(calib_points, fit=cfg.calibration)

    inj_report: InjectionReport | None = None
    if injection and extractions:
        inj_report = run_injection_suite(extractions, layer_fn=injection_layer_fn)

    return ExperimentReport(
        experiment=cfg.name,
        aggregate=aggregate,
        calibration=calibration,
        injection=inj_report,
        num_samples=len(samples),
        num_calibration_points=len(calib_points),
    )


# ──────────────────────────────────────────────────────────────────
# A/B convenience
# ──────────────────────────────────────────────────────────────────


@dataclass(slots=True)
class ABReport:
    """Two experiment reports plus the headline deltas (B − A)."""

    a: ExperimentReport
    b: ExperimentReport

    @property
    def f1_delta(self) -> float:
        return self.b.micro_f1 - self.a.micro_f1

    @property
    def ece_delta(self) -> float:
        return self.b.ece - self.a.ece

    def to_dict(self) -> dict[str, Any]:
        return {
            "a": self.a.to_dict(),
            "b": self.b.to_dict(),
            "f1_delta": round(self.f1_delta, 4),
            "ece_delta": round(self.ece_delta, 4),
        }

    def summary(self) -> str:
        return (
            f"A/B: {self.a.summary()}\n     {self.b.summary()}\n"
            f"     Δmicro_F1={self.f1_delta:+.3f}  ΔECE={self.ece_delta:+.3f}"
        )


def run_ab(
    cfg_a: ExperimentConfig,
    cfg_b: ExperimentConfig,
    dataset: GoldenDataset,
    *,
    extractor_a: RichExtractorFn | None = None,
    extractor_b: RichExtractorFn | None = None,
    injection: bool = False,
) -> ABReport:
    """Run two configs over the same dataset (sequentially, so the global
    settings singleton never holds two configs at once)."""
    a = run_experiment(cfg_a, dataset, extractor=extractor_a, injection=injection)
    b = run_experiment(cfg_b, dataset, extractor=extractor_b, injection=injection)
    return ABReport(a=a, b=b)


# ──────────────────────────────────────────────────────────────────
# Deterministic mock extractor (CLI self-test / unit tests)
# ──────────────────────────────────────────────────────────────────


def build_mock_extractor(
    dataset: GoldenDataset,
    *,
    wrong_field_index: int = 0,
    overconfident: bool = True,
) -> RichExtractorFn:
    """A deterministic, VLM-free extractor for CLI self-tests and demos.

    Returns each sample's golden values but flips one field to a wrong
    value (so F1 < 1) and assigns a confidence pattern that is
    deliberately mis-calibrated (an overconfident wrong field) so ECE and
    Brier are non-trivial. Fully deterministic — no RNG.
    """
    by_id = {s.sample_id: s for s in dataset.samples}

    def _extract(
        sample_id: str, schema_name: str, source_file: str, metadata: dict[str, Any]
    ) -> RichExtraction:
        sample = by_id.get(sample_id)
        if sample is None:
            return RichExtraction()
        names = sorted(sample.expected_fields.keys())
        values: dict[str, Any] = {}
        confidences: dict[str, float] = {}
        for i, name in enumerate(names):
            truth = sample.expected_fields[name]
            if names and i == (wrong_field_index % len(names)):
                # One wrong field, reported with high confidence → the
                # overconfident-wrong point that drives ECE/Brier up.
                values[name] = f"{truth}__WRONG" if truth is not None else "WRONG"
                confidences[name] = 0.92 if overconfident else 0.45
            else:
                values[name] = truth
                # Correct fields alternate high / modest confidence.
                confidences[name] = 0.95 if i % 2 == 0 else 0.62
        return RichExtraction(
            values=values,
            confidences=confidences,
            overall_confidence=0.8,
            extraction_time_ms=5,
        )

    return _extract


__all__ = [
    "ExtractorFn",
    "RichExtraction",
    "RichExtractorFn",
    "ExperimentConfig",
    "apply_experiment_config",
    "experiment_settings",
    "build_rich_extractor_fn",
    "build_extractor_fn",
    "build_mock_extractor",
    "ExperimentReport",
    "run_experiment",
    "ABReport",
    "run_ab",
]
