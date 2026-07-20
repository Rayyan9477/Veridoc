"""
Tests — QwenCloudBackend adapter (Alibaba Model Studio).

The adapter wraps ``LMStudioClient`` (pointed at Model Studio's OpenAI-compatible
endpoint) and adds role→model resolution over a SINGLE base URL. We mock the
client so tests are fast and need no network.

Coverage:
* Protocol conformance (``isinstance(backend, VLMBackend)``).
* Per-role resolution: PRIMARY/LITE/SECONDARY/CRITIC → three distinct models,
  all on the same endpoint.
* Capability matrix (dual-VLM always on; heterogeneity note when collapsed).
* ``response_format`` translation: none / json_schema / json_object fallback.
* ``send_vision_request`` forwards the resolved model + response_format.
* Constructor validation (url / model / api_key required).
* The factory builder wires settings → backend.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from pydantic import SecretStr

from src.client.backends.protocol import VLMBackend, VLMRole
from src.client.backends.qwen_cloud_backend import QwenCloudBackend
from src.client.lm_client import VisionRequest


def _make_backend(**overrides) -> QwenCloudBackend:
    kwargs = dict(
        primary_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        api_key="sk-test",
        primary_model="qwen-vl-max",
        secondary_model="qwen2.5-vl-72b-instruct",
        critic_model="qwen-vl-plus",
    )
    kwargs.update(overrides)
    return QwenCloudBackend(**kwargs)


@pytest.fixture
def fake_client_factory():
    """Patch ``LMStudioClient`` inside the backend module with MagicMocks."""
    with patch(
        "src.client.backends.qwen_cloud_backend.LMStudioClient"
    ) as mock_cls:
        instances: list[MagicMock] = []

        def _factory(*args, **kwargs):
            inst = MagicMock()
            inst._init_kwargs = kwargs
            inst.is_healthy.return_value = True
            instances.append(inst)
            return inst

        mock_cls.side_effect = _factory
        yield mock_cls, instances


class TestProtocolConformance:
    def test_is_vlm_backend(self) -> None:
        assert isinstance(_make_backend(), VLMBackend)


class TestResolution:
    def test_roles_resolve_to_distinct_models_one_endpoint(self) -> None:
        b = _make_backend()
        url = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
        assert b.resolve(VLMRole.PRIMARY) == (url, "qwen-vl-max")
        assert b.resolve(VLMRole.LITE) == (url, "qwen-vl-max")
        assert b.resolve(VLMRole.SECONDARY) == (url, "qwen2.5-vl-72b-instruct")
        assert b.resolve(VLMRole.CRITIC) == (url, "qwen-vl-plus")
        models = {
            b.resolve(r)[1]
            for r in (VLMRole.PRIMARY, VLMRole.SECONDARY, VLMRole.CRITIC)
        }
        assert len(models) == 3  # genuinely heterogeneous

    def test_unset_roles_collapse_to_primary(self) -> None:
        b = _make_backend(secondary_model=None, critic_model=None)
        assert b.resolve(VLMRole.SECONDARY)[1] == "qwen-vl-max"
        assert b.resolve(VLMRole.CRITIC)[1] == "qwen-vl-max"


class TestCapabilities:
    def test_dual_vlm_and_constrained_decoding(self) -> None:
        caps = _make_backend().capabilities()
        assert caps.name == "qwen_cloud"
        assert caps.supports_dual_vlm is True
        assert caps.supports_constrained_decoding is True

    def test_heterogeneity_note_when_collapsed(self) -> None:
        caps = _make_backend(secondary_model=None, critic_model=None).capabilities()
        assert any("same model" in n for n in caps.notes)


class TestResponseFormat:
    def test_none_schema_is_unconstrained(self) -> None:
        assert _make_backend()._build_response_format(None) is None

    def test_json_schema_by_default(self) -> None:
        rf = _make_backend()._build_response_format({"type": "object"})
        assert rf == {
            "type": "json_schema",
            "json_schema": {"name": "veridoc", "schema": {"type": "object"}},
        }

    def test_json_object_fallback(self) -> None:
        rf = _make_backend(force_json_object=True)._build_response_format(
            {"type": "object"}
        )
        assert rf == {"type": "json_object"}


class TestSendVisionRequest:
    def test_forwards_resolved_model_and_format(self, fake_client_factory) -> None:
        _mock_cls, instances = fake_client_factory
        b = _make_backend()
        req = VisionRequest(image_data="data:image/png;base64,xxx", prompt="hi")

        b.send_vision_request(req, role=VLMRole.SECONDARY, schema={"type": "object"})

        # One lazy client was created for the SECONDARY role.
        assert len(instances) == 1
        call = instances[0].send_vision_request.call_args
        assert call.kwargs["model"] == "qwen2.5-vl-72b-instruct"
        assert call.kwargs["response_format"]["type"] == "json_schema"

    def test_per_role_client_gets_api_key_and_url(self, fake_client_factory) -> None:
        _mock_cls, instances = fake_client_factory
        b = _make_backend()
        b._get_client(VLMRole.PRIMARY)
        assert instances[0]._init_kwargs["api_key"] == "sk-test"
        assert instances[0]._init_kwargs["model"] == "qwen-vl-max"
        assert "compatible-mode/v1" in instances[0]._init_kwargs["base_url"]


class TestValidation:
    def test_requires_url_model_key(self) -> None:
        with pytest.raises(ValueError):
            QwenCloudBackend(primary_url="", api_key="k", primary_model="m")
        with pytest.raises(ValueError):
            QwenCloudBackend(primary_url="u", api_key="", primary_model="m")
        with pytest.raises(ValueError):
            QwenCloudBackend(primary_url="u", api_key="k", primary_model="")


class TestFactoryBuilder:
    def test_build_qwen_cloud_backend_from_settings(self) -> None:
        from src.client.backends.factory import _build_qwen_cloud_backend

        settings = SimpleNamespace(
            vlm=SimpleNamespace(
                qwen_cloud=SimpleNamespace(
                    primary_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
                    api_key=SecretStr("sk-test"),
                    primary_model="qwen-vl-max",
                    secondary_model="qwen2.5-vl-72b-instruct",
                    critic_model="qwen-vl-plus",
                    force_json_object=False,
                )
            ),
            lm_studio=SimpleNamespace(
                max_tokens=4096,
                temperature=0.1,
                timeout=120,
                max_retries=3,
                retry_min_wait=2,
                retry_max_wait=30,
            ),
        )
        backend = _build_qwen_cloud_backend(settings)
        assert isinstance(backend, QwenCloudBackend)
        assert backend.resolve(VLMRole.CRITIC)[1] == "qwen-vl-plus"

    def test_build_raises_without_key(self) -> None:
        from src.client.backends.factory import _build_qwen_cloud_backend

        settings = SimpleNamespace(
            vlm=SimpleNamespace(
                qwen_cloud=SimpleNamespace(
                    primary_url="https://x/compatible-mode/v1",
                    api_key=SecretStr(""),
                    primary_model="qwen-vl-max",
                    secondary_model="qwen2.5-vl-72b-instruct",
                    critic_model="qwen-vl-plus",
                    force_json_object=False,
                )
            ),
            lm_studio=SimpleNamespace(
                max_tokens=4096,
                temperature=0.1,
                timeout=120,
                max_retries=3,
                retry_min_wait=2,
                retry_max_wait=30,
            ),
        )
        with pytest.raises(ValueError):
            _build_qwen_cloud_backend(settings)
