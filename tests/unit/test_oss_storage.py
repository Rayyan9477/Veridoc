"""Tests for the Phase E OSS artifact storage module.

The disabled path needs no ``oss2``; the enabled path is exercised with a fake
``oss2`` module so we validate key-prefixing + upload dispatch without network.
"""

from __future__ import annotations

import sys
import types

from pydantic import SecretStr

from src.config.settings import Settings
from src.storage.oss_storage import OSSStorage


def test_oss_disabled_by_default_is_noop():
    st = OSSStorage(Settings())
    assert st.enabled is False
    assert st.upload_json("results/1.json", {"a": 1}) is None
    assert st.upload_bytes("x.bin", b"data") is None
    assert st.upload_file("y.json", "/tmp/whatever") is None


def _fake_oss2(calls: dict):
    class _Bucket:
        def __init__(self, auth, endpoint, bucket):
            calls["bucket"] = bucket
            calls["endpoint"] = endpoint

        def put_object(self, key, data, headers=None):
            calls.setdefault("puts", []).append((key, len(data), headers))

    return types.SimpleNamespace(Auth=lambda a, b: ("auth", a, b), Bucket=_Bucket)


def test_oss_enabled_uploads_with_prefix(monkeypatch):
    calls: dict = {}
    monkeypatch.setitem(sys.modules, "oss2", _fake_oss2(calls))

    s = Settings()
    s.oss.enabled = True
    s.oss.endpoint = "https://oss-ap-southeast-1.aliyuncs.com"
    s.oss.bucket = "veridoc-artifacts"
    s.oss.access_key_id = SecretStr("id")
    s.oss.access_key_secret = SecretStr("secret")
    s.oss.prefix = "veridoc/"

    st = OSSStorage(s)
    assert st.enabled is True

    key = st.upload_json("results/abc.json", {"total": "$10.00"})
    assert key == "veridoc/results/abc.json"
    assert calls["bucket"] == "veridoc-artifacts"
    assert calls["puts"][0][0] == "veridoc/results/abc.json"
    assert calls["puts"][0][2] == {"Content-Type": "application/json"}


def test_oss_enabled_but_missing_bucket_stays_disabled():
    s = Settings()
    s.oss.enabled = True  # endpoint/bucket empty → not actually usable
    st = OSSStorage(s)
    assert st.enabled is False
