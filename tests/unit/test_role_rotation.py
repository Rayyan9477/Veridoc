"""Tests for D2 — true role-based model rotation.

The heterogeneity mechanism: an agent's role (derived from its name)
selects a distinct model via ``settings.vlm.role_model``. Verifies the
settings resolver, the module-level name→role map, and the BaseAgent
resolution helper — including that the legacy (lm_studio, empty map)
path is byte-identical (returns None → client default).
"""

from __future__ import annotations

import pytest

from src.agents.base import BaseAgent
from src.client.backends.protocol import VLMRole
from src.client.model_router import role_for_agent_name
from src.config.settings import Settings, VLMBackendName


# ──────────────────────────────────────────────────────────────────
# settings.vlm.role_model
# ──────────────────────────────────────────────────────────────────


def test_role_model_explicit_map_wins():
    s = Settings()
    s.vlm.role_models = {"primary": "A", "secondary": "B", "critic": "C"}
    assert s.vlm.role_model(VLMRole.PRIMARY) == "A"
    assert s.vlm.role_model(VLMRole.SECONDARY) == "B"
    assert s.vlm.role_model(VLMRole.CRITIC) == "C"
    # string keys work too
    assert s.vlm.role_model("secondary") == "B"


def test_role_model_qwen_cloud_defaults_rotate():
    s = Settings()
    s.vlm.backend = VLMBackendName.QWEN_CLOUD
    primary = s.vlm.role_model(VLMRole.PRIMARY)
    secondary = s.vlm.role_model(VLMRole.SECONDARY)
    critic = s.vlm.role_model(VLMRole.CRITIC)
    # Three distinct models straight from the qwen_cloud block defaults.
    assert primary == s.vlm.qwen_cloud.primary_model
    assert secondary == s.vlm.qwen_cloud.secondary_model
    assert critic == s.vlm.qwen_cloud.critic_model
    assert len({primary, secondary, critic}) == 3


def test_role_model_lm_studio_empty_map_returns_none():
    # Legacy default: no rotation, so base.py falls back to today's behaviour.
    s = Settings()
    assert s.vlm.backend == VLMBackendName.LM_STUDIO
    assert s.vlm.role_model(VLMRole.PRIMARY) is None
    assert s.vlm.role_model(VLMRole.SECONDARY) is None
    assert s.vlm.role_model(VLMRole.CRITIC) is None


# ──────────────────────────────────────────────────────────────────
# role_for_agent_name (works without a ModelRouter)
# ──────────────────────────────────────────────────────────────────


def test_role_for_agent_name_mapping():
    assert role_for_agent_name("extractor_pass2") == VLMRole.SECONDARY
    assert role_for_agent_name("critic") == VLMRole.CRITIC
    assert role_for_agent_name("extractor") == VLMRole.PRIMARY
    assert role_for_agent_name("extractor_pass1") == VLMRole.PRIMARY
    assert role_for_agent_name("anything_else") == VLMRole.PRIMARY


# ──────────────────────────────────────────────────────────────────
# BaseAgent._resolve_model_override
# ──────────────────────────────────────────────────────────────────


class _Agent(BaseAgent):
    def process(self, state):  # pragma: no cover - not exercised
        return state


@pytest.fixture
def role_models_env():
    """Set an explicit role map on the settings singleton, then restore.

    Also snapshots/restores the backend so a prior test that mutated the
    cached singleton (e.g. to vllm) can't bleed into these assertions.
    """
    from src.config.settings import get_settings

    s = get_settings()
    saved_rm = dict(s.vlm.role_models)
    saved_backend = s.vlm.backend
    yield s
    s.vlm.role_models = saved_rm
    s.vlm.backend = saved_backend


def test_base_agent_rotates_by_name(role_models_env):
    role_models_env.vlm.role_models = {"primary": "A", "secondary": "B", "critic": "C"}
    extractor = _Agent("extractor")
    pass2 = _Agent("extractor_pass2")
    critic = _Agent("critic")

    # The role is derived from the agent NAME (not the passed role arg), so
    # each agent rotates onto its own model — the heterogeneity mechanism.
    assert extractor._resolve_model_override(VLMRole.PRIMARY) == "A"
    assert pass2._resolve_model_override(VLMRole.PRIMARY) == "B"
    assert critic._resolve_model_override(VLMRole.PRIMARY) == "C"


def test_base_agent_default_no_rotation_returns_none(role_models_env):
    # lm_studio + empty map → no override (byte-identical to pre-D2).
    role_models_env.vlm.backend = VLMBackendName.LM_STUDIO
    role_models_env.vlm.role_models = {}
    agent = _Agent("extractor_pass2")
    assert agent._model_router is None
    assert agent._resolve_model_override(VLMRole.PRIMARY) is None
