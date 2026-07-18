"""Compat shim — the injection runner was promoted to first-party code.

The implementation now lives in :mod:`src.evaluation.inject.runner`.
This module re-exports it unchanged so existing ``tests.eval.inject``
imports keep resolving the very same classes (identity preserved).
"""

from src.evaluation.inject.runner import (  # noqa: F401
    InjectionConfig,
    InjectionResult,
    InjectionRunner,
    InjectionType,
)

__all__ = [
    "InjectionType",
    "InjectionConfig",
    "InjectionResult",
    "InjectionRunner",
]
