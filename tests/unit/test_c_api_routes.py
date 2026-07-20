"""
Unit tests for the C-API backend routes that back the Glass frontend:
profiles, schema persistence, audit query/export, and the HITL review
queue.

These exercise the routers registered in ``src/api/app.py`` via a
``TestClient`` (auth is disabled by default in dev/test), plus a couple
of pure-function tests for the audit reader and review projection.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from src.api.app import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


class TestProfilesRoute:
    """GET /profiles enumerates the built-in profile descriptors."""

    def test_list_profiles_returns_builtins(self, client: TestClient) -> None:
        resp = client.get("/api/v1/profiles")
        assert resp.status_code == 200
        data = resp.json()
        ids = {p["id"] for p in data}
        assert {"generic-document", "medical-rcm", "finance"} <= ids

    def test_medical_profile_fields_are_real(self, client: TestClient) -> None:
        data = client.get("/api/v1/profiles").json()
        med = next(p for p in data if p["id"] == "medical-rcm")
        # Straight off the descriptor: 7 validator packs, healthcare doc
        # types, and the two RCM export emitters.
        assert med["validator_count"] == 7
        assert "CMS-1500" in med["doc_types"]
        assert "ccda" in med["emitters"] and "x12_275" in med["emitters"]
        assert med["tier"] == "built-in"


class TestSchemaPersistence:
    """POST /schemas + POST /schemas/{name}/publish + list merge."""

    @pytest.fixture(autouse=True)
    def _tmp_store(self, tmp_path):
        # Repoint the file-backed schema store at an isolated temp dir so
        # the test never pollutes ./data/schemas.
        from src.storage.schema_store import get_schema_store

        get_schema_store(storage_dir=tmp_path / "schemas")
        yield
        get_schema_store(storage_dir="./data/schemas")

    def test_save_then_publish_schema(self, client: TestClient) -> None:
        payload = {
            "name": "unit_demo",
            "description": "demo",
            "document_type": "demo",
            "version": "1.0.0",
            "fields": [{"name": "a", "type": "string", "required": True}],
        }
        resp = client.post("/api/v1/schemas", json=payload)
        assert resp.status_code == 200
        assert resp.json()["schema"]["status"] == "draft"

        # It now shows up in the merged list...
        listed = client.get("/api/v1/schemas").json()
        assert "unit_demo" in {s["name"] for s in listed["schemas"]}

        # ...and loads back with its fields (so the designer can edit it).
        got = client.get("/api/v1/schemas/unit_demo")
        assert got.status_code == 200
        assert len(got.json()["fields"]) == 1
        assert got.json()["status"] == "draft"

        # Publish flips the status.
        pub = client.post("/api/v1/schemas/unit_demo/publish")
        assert pub.status_code == 200
        assert pub.json()["schema"]["status"] == "published"

    def test_publish_missing_schema_returns_404(self, client: TestClient) -> None:
        resp = client.post("/api/v1/schemas/does_not_exist/publish")
        assert resp.status_code == 404

    def test_invalid_schema_name_rejected(self, client: TestClient) -> None:
        resp = client.post(
            "/api/v1/schemas",
            json={"name": "bad/name", "fields": []},
        )
        assert resp.status_code == 400


class TestAuditRoute:
    """GET /audit query + export, and the reader filter logic."""

    def test_audit_query_endpoint_shape(self, client: TestClient) -> None:
        resp = client.get("/api/v1/audit?limit=5")
        assert resp.status_code == 200
        body = resp.json()
        assert set(body.keys()) >= {"entries", "count", "scanned"}
        assert isinstance(body["entries"], list)

    def test_audit_reader_filters(self, tmp_path) -> None:
        from src.api.routes.audit import read_audit_entries

        log_dir = tmp_path / "audit"
        log_dir.mkdir()
        rows = [
            {
                "event_id": "1",
                "timestamp": "2026-01-01T10:00:00+00:00",
                "event_type": "auth.login.success",
                "severity": "info",
                "outcome": "success",
                "message": "login ok",
                "context": {"user_id": "alice", "tenant_id": "acme"},
            },
            {
                "event_id": "2",
                "timestamp": "2026-01-02T10:00:00+00:00",
                "event_type": "doc.process",
                "severity": "info",
                "outcome": "success",
                "message": "processed",
                "context": {"user_id": "bob", "tenant_id": "acme"},
            },
        ]
        (log_dir / "audit_2026-01-02.jsonl").write_text(
            "\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8"
        )

        entries, scanned = read_audit_entries(log_dir, limit=10)
        assert scanned == 2
        assert len(entries) == 2
        # Newest first.
        assert entries[0]["event_id"] == "2"

        actor_only, _ = read_audit_entries(log_dir, actor="alice")
        assert [e["event_id"] for e in actor_only] == ["1"]

        event_only, _ = read_audit_entries(log_dir, event="doc.")
        assert [e["event_id"] for e in event_only] == ["2"]

        date_only, _ = read_audit_entries(log_dir, date_from="2026-01-02")
        assert [e["event_id"] for e in date_only] == ["2"]

        text_only, _ = read_audit_entries(log_dir, q="login")
        assert [e["event_id"] for e in text_only] == ["1"]

    def test_audit_export_csv(self, client: TestClient) -> None:
        resp = client.get("/api/v1/audit/export?format=csv&limit=2")
        assert resp.status_code == 200
        assert "text/csv" in resp.headers["content-type"]
        assert "attachment" in resp.headers.get("content-disposition", "")


class TestReviewQueue:
    """GET /review/queue derived from the documents result store."""

    def test_review_queue_from_documents_endpoint(self, client: TestClient) -> None:
        resp = client.get("/api/v1/review/queue")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_review_projection_flags_low_confidence_documents(self) -> None:
        from src.api.routes.review import _project_queue_doc

        result = {
            "processing_id": "pid123",
            "pdf_path": "/tmp/foo.pdf",
            "document_type": "CMS-1500",
            "overall_confidence": 0.42,
            "requires_human_review": True,
            "human_review_reason": "low confidence fields",
            "merged_extraction": {"npi": {"value": "123"}, "name": "Jane"},
            "field_metadata": {
                "npi": {"confidence": 0.3, "validation_passed": True},
                "name": {"confidence": 0.95, "validation_passed": True},
            },
        }
        doc = _project_queue_doc(result)
        assert doc["id"] == "pid123"
        assert doc["filename"] == "foo.pdf"
        assert doc["profile"] == "CMS-1500"
        flagged = {f["name"] for f in doc["flaggedFields"]}
        # Low-confidence npi is flagged; high-confidence name is not.
        assert "npi" in flagged
        assert "name" not in flagged
