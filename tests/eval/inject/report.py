"""Compat shim — the injection reporter was promoted to first-party code.

The implementation now lives in :mod:`src.evaluation.inject.report`.
This module re-exports it unchanged so existing ``tests.eval.inject``
imports keep resolving the very same objects.
"""

from src.evaluation.inject.report import (  # noqa: F401
    CAUGHT,
    MISSED,
    NOT_APPLICABLE,
    TRACKED_LAYERS,
    InjectionReport,
    classify_caught,
    confusion_matrix,
)

__all__ = [
    "CAUGHT",
    "MISSED",
    "NOT_APPLICABLE",
    "TRACKED_LAYERS",
    "classify_caught",
    "confusion_matrix",
    "InjectionReport",
]
