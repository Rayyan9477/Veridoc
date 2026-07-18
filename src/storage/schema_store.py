"""
File-backed store for user-authored extraction schemas.

The code-defined schemas in ``src/schemas`` are immutable and shipped
with the product. The Schema Designer, however, lets operators author
or override schemas at runtime. Those live here: one JSON file per
schema under ``data/schemas/<name>.json``, each carrying a
``draft`` / ``published`` status flag.

This is deliberately a thin, dependency-free store mirroring
``result_store.py`` — no database, no migration layer. A saved schema
shadows a same-named code schema in listings (the operator's override
wins), which is the whole point of letting them edit one.
"""

from __future__ import annotations

import json
import re
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from src.config import get_logger


logger = get_logger(__name__)

# Schema names must be safe for use as a filename and as a URL path
# segment. This also blocks path-traversal via the ``name`` field.
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-]{0,63}$")

VALID_STATUSES = ("draft", "published")


class SchemaStoreError(ValueError):
    """Raised for invalid schema-store operations (bad name, etc.)."""


def is_valid_schema_name(name: str) -> bool:
    """Return True iff ``name`` is a safe schema identifier."""
    return bool(_SAFE_NAME_RE.match(name or ""))


class SchemaStore:
    """File-based store for authored schemas (one JSON file per name)."""

    def __init__(self, storage_dir: str | Path = "./data/schemas") -> None:
        self._storage_dir = Path(storage_dir)
        self._lock = threading.Lock()
        self._storage_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str) -> Path:
        if not is_valid_schema_name(name):
            raise SchemaStoreError(
                f"Invalid schema name: {name!r}. Use letters, digits, "
                "'-' and '_' (max 64 chars)."
            )
        return self._storage_dir / f"{name}.json"

    def save(
        self,
        name: str,
        *,
        description: str = "",
        document_type: str = "",
        version: str = "1.0.0",
        fields: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Create or update a draft schema.

        Saving always lands the schema in ``draft`` status. Publishing
        is a separate, explicit step (:meth:`publish`). If the schema
        already exists its ``created_at`` is preserved.
        """
        path = self._path(name)
        fields = fields or []
        now = datetime.now(UTC).isoformat()

        with self._lock:
            created_at = now
            if path.exists():
                try:
                    existing = json.loads(path.read_text(encoding="utf-8"))
                    created_at = existing.get("created_at", now)
                except (json.JSONDecodeError, OSError):
                    created_at = now

            record: dict[str, Any] = {
                "name": name,
                "description": description,
                "document_type": document_type or name,
                "version": version,
                "fields": fields,
                "field_count": len(fields),
                "status": "draft",
                "source": "file",
                "created_at": created_at,
                "updated_at": now,
                "published_at": None,
            }
            path.write_text(
                json.dumps(record, indent=2, default=str), encoding="utf-8"
            )

        logger.info("schema_saved", name=name, field_count=len(fields))
        return record

    def publish(self, name: str) -> dict[str, Any] | None:
        """Flip a stored schema to ``published``. None if not found."""
        path = self._path(name)
        with self._lock:
            if not path.exists():
                return None
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as e:
                raise SchemaStoreError(f"Corrupt schema file for {name!r}: {e}") from e

            record["status"] = "published"
            record["published_at"] = datetime.now(UTC).isoformat()
            record["updated_at"] = record["published_at"]
            path.write_text(
                json.dumps(record, indent=2, default=str), encoding="utf-8"
            )

        logger.info("schema_published", name=name)
        return record

    def get(self, name: str) -> dict[str, Any] | None:
        """Return a stored schema record, or None if not present."""
        try:
            path = self._path(name)
        except SchemaStoreError:
            return None
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            logger.error("schema_read_error", name=name, error=str(e))
            return None

    def exists(self, name: str) -> bool:
        try:
            return self._path(name).exists()
        except SchemaStoreError:
            return False

    def list_all(self) -> list[dict[str, Any]]:
        """Return every stored schema record (newest updated first)."""
        records: list[dict[str, Any]] = []
        with self._lock:
            for path in self._storage_dir.glob("*.json"):
                try:
                    records.append(json.loads(path.read_text(encoding="utf-8")))
                except (json.JSONDecodeError, OSError):
                    continue
        records.sort(key=lambda r: r.get("updated_at", ""), reverse=True)
        return records


# Module-level singleton -----------------------------------------------------
_schema_store: SchemaStore | None = None
_store_lock = threading.Lock()


def get_schema_store(storage_dir: str | Path | None = None) -> SchemaStore:
    """Get or create the schema store singleton."""
    global _schema_store
    with _store_lock:
        if _schema_store is None or storage_dir is not None:
            _schema_store = SchemaStore(storage_dir=storage_dir or "./data/schemas")
    return _schema_store
