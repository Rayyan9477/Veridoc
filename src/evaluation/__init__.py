"""
Evaluation and benchmarking module for document extraction.

Provides tools for measuring extraction accuracy against golden datasets,
running A/B tests between strategies, and detecting regressions.

Usage:
    from src.evaluation import (
        BenchmarkRunner, BenchmarkConfig, BenchmarkResult,
        GoldenDataset, GoldenSample, create_sample,
        evaluate_document, AggregateMetrics,
        ABTestRunner, ABTestResult,
        RegressionDetector, RegressionReport,
    )
"""

from src.evaluation.ab_testing import (
    ABOutcome,
    ABTestConfig,
    ABTestResult,
    ABTestRunner,
)
from src.evaluation.benchmark import (
    BenchmarkComparison,
    BenchmarkConfig,
    BenchmarkResult,
    BenchmarkRunner,
    BenchmarkStatus,
    compare_runs,
)
from src.evaluation.golden_dataset import (
    GoldenDataset,
    GoldenSample,
    create_sample,
    load_dataset,
    save_dataset,
)
from src.evaluation.harness import (
    ABReport,
    ExperimentConfig,
    ExperimentReport,
    RichExtraction,
    apply_experiment_config,
    build_extractor_fn,
    build_mock_extractor,
    build_rich_extractor_fn,
    experiment_settings,
    run_ab,
    run_experiment,
)
from src.evaluation.metrics import (
    AggregateMetrics,
    DocumentMetrics,
    FieldMatchResult,
    MatchLevel,
    compare_field,
    evaluate_document,
)
from src.evaluation.regression import (
    FieldRegression,
    RegressionDetector,
    RegressionReport,
    RegressionSeverity,
    load_baseline,
    save_baseline,
)


__all__ = [
    # Metrics
    "MatchLevel",
    "FieldMatchResult",
    "DocumentMetrics",
    "AggregateMetrics",
    "compare_field",
    "evaluate_document",
    # Golden dataset
    "GoldenSample",
    "GoldenDataset",
    "create_sample",
    "save_dataset",
    "load_dataset",
    # Benchmark
    "BenchmarkStatus",
    "BenchmarkConfig",
    "BenchmarkResult",
    "BenchmarkRunner",
    "BenchmarkComparison",
    "compare_runs",
    # A/B testing
    "ABOutcome",
    "ABTestConfig",
    "ABTestResult",
    "ABTestRunner",
    # Regression
    "RegressionSeverity",
    "FieldRegression",
    "RegressionReport",
    "RegressionDetector",
    "save_baseline",
    "load_baseline",
    # Experiment harness
    "ExperimentConfig",
    "ExperimentReport",
    "RichExtraction",
    "ABReport",
    "run_experiment",
    "run_ab",
    "apply_experiment_config",
    "experiment_settings",
    "build_extractor_fn",
    "build_rich_extractor_fn",
    "build_mock_extractor",
]
