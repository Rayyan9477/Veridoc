"""Alibaba Cloud OSS artifact storage (Phase E).

A thin, best-effort uploader that mirrors extraction artifacts (result JSON,
signed receipts, bbox overlays, audit logs) to an Alibaba OSS bucket so a
deployed Veridoc instance has durable, shareable object storage.

Design notes:
* ``oss2`` is imported lazily, so the dependency is optional for local / on-prem
  runs that don't use OSS.
* Every upload is **best-effort**: a failure logs a warning and returns ``None``
  rather than raising — object storage must never break an extraction.
* Auth uses an OSS RAM AccessKey pair (``OSS_ACCESS_KEY_ID`` /
  ``OSS_ACCESS_KEY_SECRET``), which is distinct from the Model Studio inference
  key used for the VLM backend.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import structlog

from src.config import get_settings


logger = structlog.get_logger(__name__)


class OSSStorage:
    """Best-effort uploader to an Alibaba OSS bucket."""

    def __init__(self, settings: Any = None) -> None:
        oss_cfg = (settings or get_settings()).oss
        self._prefix = oss_cfg.prefix or ""
        self._bucket = None
        self._enabled = bool(oss_cfg.enabled and oss_cfg.endpoint and oss_cfg.bucket)
        if not self._enabled:
            return
        try:
            import oss2

            auth = oss2.Auth(
                oss_cfg.access_key_id.get_secret_value(),
                oss_cfg.access_key_secret.get_secret_value(),
            )
            self._bucket = oss2.Bucket(auth, oss_cfg.endpoint, oss_cfg.bucket)
            logger.info(
                "oss_storage_ready", endpoint=oss_cfg.endpoint, bucket=oss_cfg.bucket
            )
        except Exception as exc:  # pragma: no cover - depends on oss2 + network
            logger.warning("oss_init_failed", error=str(exc))
            self._enabled = False

    @property
    def enabled(self) -> bool:
        return self._enabled and self._bucket is not None

    def _key(self, name: str) -> str:
        return f"{self._prefix}{name}".lstrip("/")

    def upload_bytes(
        self, name: str, data: bytes, content_type: str | None = None
    ) -> str | None:
        """Upload raw bytes; returns the object key or ``None`` on failure."""
        if not self.enabled:
            return None
        key = self._key(name)
        try:
            headers = {"Content-Type": content_type} if content_type else None
            self._bucket.put_object(key, data, headers=headers)
            logger.info("oss_uploaded", key=key, bytes=len(data))
            return key
        except Exception as exc:  # pragma: no cover - network
            logger.warning("oss_upload_failed", key=key, error=str(exc))
            return None

    def upload_json(self, name: str, obj: Any) -> str | None:
        return self.upload_bytes(
            name,
            json.dumps(obj, indent=2, default=str).encode("utf-8"),
            "application/json",
        )

    def upload_file(self, name: str, path: str | Path) -> str | None:
        if not self.enabled:
            return None
        key = self._key(name)
        try:
            self._bucket.put_object_from_file(key, str(path))
            logger.info("oss_uploaded_file", key=key, src=str(path))
            return key
        except Exception as exc:  # pragma: no cover - network
            logger.warning("oss_upload_file_failed", key=key, error=str(exc))
            return None


_store: OSSStorage | None = None


def get_oss_storage() -> OSSStorage:
    """Return the process-wide OSS storage (disabled no-op unless configured)."""
    global _store
    if _store is None:
        _store = OSSStorage()
    return _store


__all__ = ["OSSStorage", "get_oss_storage"]
