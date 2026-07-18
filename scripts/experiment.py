#!/usr/bin/env python
"""Run a Veridoc experiment config over a golden dataset.

Prints the combined report — extraction F1, confidence calibration
(ECE/MCE/Brier), and injection catch-rate — for one ``ExperimentConfig``.

Usage::

    # Live (needs a configured VLM backend, e.g. Qwen keys):
    python scripts/experiment.py data/experiments/baseline.json

    # Offline self-test (deterministic mock extractor, no VLM/keys):
    python scripts/experiment.py data/experiments/baseline.json --mock

    # A/B two configs:
    python scripts/experiment.py data/experiments/baseline.json \
        --vs data/experiments/dual_vlm_critic.json --mock
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Make the repo importable when run as a plain script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.evaluation import (  # noqa: E402
    ExperimentConfig,
    build_mock_extractor,
    load_dataset,
    run_ab,
    run_experiment,
)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Veridoc experiment / eval harness")
    p.add_argument("config", help="Path to an ExperimentConfig JSON file")
    p.add_argument(
        "--golden",
        default="data/golden/generic_v1.json",
        help="Path to the golden dataset JSON (default: data/golden/generic_v1.json)",
    )
    p.add_argument(
        "--vs",
        default=None,
        metavar="CONFIG_B",
        help="Second config to A/B against the first over the same dataset",
    )
    p.add_argument("--out", default=None, help="Write the full JSON report here")
    p.add_argument(
        "--mock",
        action="store_true",
        help="Use the deterministic VLM-free mock extractor (no Qwen keys needed)",
    )
    p.add_argument(
        "--no-injection",
        dest="injection",
        action="store_false",
        help="Skip the injection catch-rate suite",
    )
    p.set_defaults(injection=True)
    return p


def main(argv: list[str] | None = None) -> int:
    # The report summaries use a few non-ASCII glyphs (Δ, ─); make sure a
    # cp1252 Windows console doesn't choke on them.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except Exception:
                pass

    args = _build_parser().parse_args(argv)

    dataset = load_dataset(args.golden)
    cfg_a = ExperimentConfig.from_json_file(args.config)
    # In --mock the extractor is bound to the dataset (no VLM); live mode
    # builds the pipeline from each config inside run_experiment.
    mock = build_mock_extractor(dataset) if args.mock else None

    if args.vs:
        cfg_b = ExperimentConfig.from_json_file(args.vs)
        report = run_ab(
            cfg_a,
            cfg_b,
            dataset,
            extractor_a=mock,
            extractor_b=mock,
            injection=args.injection,
        )
    else:
        report = run_experiment(
            cfg_a, dataset, extractor=mock, injection=args.injection
        )

    print(report.summary())
    payload = report.to_dict()
    print(json.dumps(payload, indent=2, ensure_ascii=False))

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\nWrote report to {out}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
