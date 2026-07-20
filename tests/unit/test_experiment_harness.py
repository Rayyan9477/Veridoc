"""Unit tests for the D0 experiment/eval spine (src/evaluation/harness.py).

Every metric-shaping path is exercised with injected extractors, so no
VLM (and no Qwen keys) are needed. The live pipeline adapter is covered
by a fake runner that returns a canned extraction state.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib

import pytest

from src.evaluation import (
    ExperimentConfig,
    GoldenDataset,
    GoldenSample,
    build_extractor_fn,
    build_mock_extractor,
    run_ab,
    run_experiment,
)
from src.evaluation.harness import (
    RichExtraction,
    apply_experiment_config,
    experiment_settings,
    _split_envelope,
)


# ──────────────────────────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────────────────────────


def _dataset() -> GoldenDataset:
    return GoldenDataset(
        name="unit",
        samples=[
            GoldenSample(
                sample_id="a",
                document_type="invoice",
                schema_name="invoice",
                expected_fields={"num": "INV-1", "total": "$10.00", "vendor": "ACME"},
                metadata={"profile": "finance"},
                tags=["invoice"],
            ),
            GoldenSample(
                sample_id="b",
                document_type="receipt",
                schema_name="generic_document",
                expected_fields={"merchant": "Store", "total": "$5.00"},
                metadata={"profile": "finance"},
                tags=["receipt"],
            ),
        ],
    )


def _stub_extractor(sample_id, schema_name, source_file, metadata):
    """Doc a: 2/3 correct (vendor wrong). Doc b: 2/2 correct."""
    if sample_id == "a":
        return RichExtraction(
            values={"num": "INV-1", "total": "$10.00", "vendor": "WRONG"},
            confidences={"num": 0.9, "total": 0.8, "vendor": 0.95},
        )
    return RichExtraction(
        values={"merchant": "Store", "total": "$5.00"},
        confidences={"merchant": 0.7, "total": 0.6},
    )


# ──────────────────────────────────────────────────────────────────
# ExperimentConfig
# ──────────────────────────────────────────────────────────────────


def test_config_roundtrip():
    cfg = ExperimentConfig(
        name="x",
        engine="dual_vlm",
        critic_enabled=True,
        role_models={"primary": "m1", "secondary": "m2"},
        thresholds={"confidence_auto_accept": 0.9},
        calibration=True,
    )
    assert ExperimentConfig.from_dict(cfg.to_dict()) == cfg


def test_config_from_dict_ignores_unknown_keys():
    cfg = ExperimentConfig.from_dict(
        {"name": "y", "engine": "legacy", "totally_bogus": 123}
    )
    assert cfg.name == "y"
    assert cfg.engine == "legacy"


def test_config_from_json_file(tmp_path):
    p = tmp_path / "cfg.json"
    p.write_text(json.dumps({"name": "z", "critic_enabled": True}), encoding="utf-8")
    cfg = ExperimentConfig.from_json_file(p)
    assert cfg.name == "z"
    assert cfg.critic_enabled is True


def test_split_envelope_handles_both_shapes():
    values, confidences = _split_envelope(
        {
            "a": {"value": "x", "confidence": 0.9},
            "b": "raw-scalar",
            "c": {"value": 1},  # no confidence
        }
    )
    assert values == {"a": "x", "b": "raw-scalar", "c": 1}
    assert confidences == {"a": 0.9}


# ──────────────────────────────────────────────────────────────────
# Settings application
# ──────────────────────────────────────────────────────────────────


def test_apply_experiment_config_mutates_settings():
    from src.config.settings import ExtractionEngine, Settings

    s = Settings()
    cfg = ExperimentConfig(
        engine="dual_vlm",
        critic_enabled=True,
        calibration=True,
        thresholds={"confidence_auto_accept": 0.7, "critic_min_trust": 0.6},
    )
    apply_experiment_config(cfg, s)
    assert s.extraction.engine == ExtractionEngine.DUAL_VLM
    assert s.extraction.critic_enabled is True
    assert s.calibration.enabled is True
    assert s.extraction.confidence_auto_accept == 0.7
    assert s.extraction.critic_min_trust_score == 0.6


def test_experiment_settings_restores_after_block():
    from src.config.settings import ExtractionEngine, get_settings

    s = get_settings()
    before_engine = s.extraction.engine
    before_critic = s.extraction.critic_enabled
    with experiment_settings(ExperimentConfig(engine="dual_vlm", critic_enabled=True)):
        assert s.extraction.engine == ExtractionEngine.DUAL_VLM
        assert s.extraction.critic_enabled is True
    assert s.extraction.engine == before_engine
    assert s.extraction.critic_enabled == before_critic


# ──────────────────────────────────────────────────────────────────
# Live adapter (fake runner — no VLM)
# ──────────────────────────────────────────────────────────────────


class _FakeRunner:
    def extract_from_pdf(
        self,
        pdf_path,
        custom_schema=None,
        thread_id=None,
        *,
        profile_override=None,
        modality_override=None,
    ):
        from src.pipeline.state import ExtractionStatus

        return {
            "status": ExtractionStatus.COMPLETED.value,
            "selected_schema_name": "invoice",
            "merged_extraction": {
                "total": {"value": "$10.00", "confidence": 0.9},
                "vendor": {"value": "ACME", "confidence": 0.8},
            },
            "overall_confidence": 0.85,
            "total_processing_ms": 12,
        }


def test_build_extractor_fn_flattens_envelope():
    fn = build_extractor_fn(ExperimentConfig(), runner=_FakeRunner())
    out = fn("a", "invoice", "src.txt", {})
    assert out == {"total": "$10.00", "vendor": "ACME"}


# ──────────────────────────────────────────────────────────────────
# run_experiment
# ──────────────────────────────────────────────────────────────────


def test_run_experiment_computes_f1_and_calibration():
    rep = run_experiment(ExperimentConfig(name="s"), _dataset(), extractor=_stub_extractor)
    assert rep.num_samples == 2
    # 4 correct of 5 expected/extracted → micro P=R=F1=0.8
    assert round(rep.micro_f1, 3) == 0.8
    assert rep.num_calibration_points == 5
    assert rep.calibration.num_samples == 5
    assert rep.injection is None


def test_run_experiment_injection_catch_rate():
    rep = run_experiment(
        ExperimentConfig(name="s"), _dataset(), extractor=_stub_extractor, injection=True
    )
    assert rep.injection is not None
    rates = rep.injection.per_layer_catch_rate()["pattern_detector"]
    # The VLM-free pattern detector genuinely catches phantom + placeholder…
    assert rates["phantom_field"] == 1.0
    assert rates["placeholder_inject"] == 1.0
    # …and genuinely misses a plausible value swap (needs validator/Critic).
    assert rates["value_swap"] == 0.0


def test_report_to_dict_is_json_serialisable():
    rep = run_experiment(
        ExperimentConfig(name="s"), _dataset(), extractor=_stub_extractor, injection=True
    )
    blob = json.dumps(rep.to_dict())
    assert '"f1"' in blob
    assert '"calibration"' in blob
    assert '"injection"' in blob
    assert "micro_F1" in rep.summary()


def test_filters_and_max_samples():
    ds = _dataset()
    mock = build_mock_extractor(ds)
    assert run_experiment(
        ExperimentConfig(name="f", filter_tags=["invoice"]), ds, extractor=mock
    ).num_samples == 1
    assert run_experiment(
        ExperimentConfig(name="f2", max_samples=1), ds, extractor=mock
    ).num_samples == 1
    assert run_experiment(
        ExperimentConfig(name="f3", filter_types=["receipt"]), ds, extractor=mock
    ).num_samples == 1


# ──────────────────────────────────────────────────────────────────
# Mock extractor + A/B + calibration learning
# ──────────────────────────────────────────────────────────────────


def test_mock_extractor_is_imperfect_and_scored():
    ds = _dataset()
    mock = build_mock_extractor(ds)
    rep = run_experiment(ExperimentConfig(name="m"), ds, extractor=mock)
    assert 0.0 < rep.micro_f1 < 1.0  # one flipped field per doc
    assert rep.num_calibration_points > 0


def test_calibration_fit_runs_without_error():
    ds = _dataset()
    mock = build_mock_extractor(ds)
    off = run_experiment(ExperimentConfig(name="off", calibration=False), ds, extractor=mock)
    on = run_experiment(ExperimentConfig(name="on", calibration=True), ds, extractor=mock)
    assert off.calibration.num_samples == on.calibration.num_samples
    assert on.ece >= 0.0
    assert on.brier >= 0.0


def test_run_ab_same_extractor_zero_delta():
    ds = _dataset()
    mock = build_mock_extractor(ds)
    ab = run_ab(
        ExperimentConfig(name="a"),
        ExperimentConfig(name="b"),
        ds,
        extractor_a=mock,
        extractor_b=mock,
    )
    assert ab.a.experiment == "a"
    assert ab.b.experiment == "b"
    assert ab.f1_delta == 0.0
    assert "A/B" in ab.summary()


# ──────────────────────────────────────────────────────────────────
# CLI (mock mode) — the "one command prints F1 + ECE/Brier + catch-rate"
# ──────────────────────────────────────────────────────────────────


def _load_cli():
    path = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "experiment.py"
    spec = importlib.util.spec_from_file_location("veridoc_experiment_cli", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_cli_mock_run_prints_all_metrics(capsys):
    root = pathlib.Path(__file__).resolve().parents[2]
    cli = _load_cli()
    rc = cli.main(
        [
            str(root / "data" / "experiments" / "baseline.json"),
            "--golden",
            str(root / "data" / "golden" / "generic_v1.json"),
            "--mock",
        ]
    )
    assert rc == 0
    out = capsys.readouterr().out
    assert "micro_F1" in out
    assert "ECE" in out
    assert "pattern_catch" in out
    # JSON report block present
    assert '"calibration"' in out
    assert '"injection"' in out
