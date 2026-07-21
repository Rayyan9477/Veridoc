"""Tests for D3 — per-call tracing enrichment.

Verifies that a VLM call records the resolved model, the role, and the
token counts on the observability plane (so experiments can attribute
latency + spend to the exact model each role ran), and that D2's role
rotation flows through into that record.
"""

from __future__ import annotations

import contextlib

from src.agents.base import BaseAgent
from src.client.backends.protocol import VLMRole
import src.monitoring.observability as obs
from src.monitoring.observability import ObservabilityDispatcher, _Sink


class _CaptureSink(_Sink):
    def __init__(self):
        self.llm_calls: list[dict] = []
        self.events: list[tuple[str, dict]] = []

    def emit_event(self, event_name, properties):
        self.events.append((event_name, properties))

    def record_llm_call(self, **attrs):
        self.llm_calls.append(attrs)

    @contextlib.contextmanager
    def start_span(self, name, **attrs):
        yield None

    def shutdown(self):
        pass


class _Resp:
    latency_ms = 12.0
    prompt_tokens = 111
    completion_tokens = 22
    has_json = False


class _Client:
    def send_vision_request(self, request, model=None, **kwargs):
        return _Resp()


class _Agent(BaseAgent):
    def process(self, state):  # pragma: no cover - not exercised
        return state


def test_record_llm_call_carries_role_and_tokens(monkeypatch):
    sink = _CaptureSink()
    monkeypatch.setattr(obs, "get_dispatcher", lambda: ObservabilityDispatcher(sinks=[sink]))

    agent = _Agent(name="extractor", client=_Client())
    agent.send_vision_request(
        "data:image/png;base64,AAAA", "extract", role=VLMRole.PRIMARY
    )

    assert len(sink.llm_calls) == 1
    call = sink.llm_calls[0]
    assert call["agent"] == "extractor"
    assert call["role"] == "primary"
    assert call["tokens_in"] == 111
    assert call["tokens_out"] == 22
    assert call["latency_ms"] == 12.0


def test_record_llm_call_stamps_rotated_model(monkeypatch):
    sink = _CaptureSink()
    monkeypatch.setattr(obs, "get_dispatcher", lambda: ObservabilityDispatcher(sinks=[sink]))

    from src.config.settings import get_settings

    s = get_settings()
    saved = dict(s.vlm.role_models)
    try:
        # A critic agent must rotate onto the critic model (D2) and that
        # id must land in the observability record (D3).
        s.vlm.role_models = {"critic": "critic-model-x"}
        agent = _Agent(name="critic", client=_Client())
        agent.send_vision_request(
            "data:image/png;base64,AAAA", "audit", role=VLMRole.PRIMARY
        )
        assert sink.llm_calls[0]["model"] == "critic-model-x"
    finally:
        s.vlm.role_models = saved
