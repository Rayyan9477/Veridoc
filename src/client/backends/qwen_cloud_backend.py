"""
Qwen Cloud backend adapter (Alibaba Model Studio / DashScope).

Wraps the existing ``LMStudioClient`` (which already speaks the OpenAI SDK)
pointed at Model Studio's OpenAI-compatible endpoint, and exposes the
``VLMBackend`` protocol. Unlike LM Studio — where each model lives on its own
port — Model Studio serves *every* Qwen model from a SINGLE base URL, so
heterogeneity is "same endpoint, different model id per role". That makes real
dual-VLM trivial: ``supports_dual_vlm=True`` with zero model-swapping, and the
society's PRIMARY / SECONDARY / CRITIC roles each resolve to a distinct Qwen
model concurrently.

Capability matrix for Qwen Cloud (2026):

* ``supports_dual_vlm`` — always True (one endpoint serves all models).
* ``supports_constrained_decoding`` — via ``response_format`` (``json_schema``
  when available, else ``json_object`` when ``force_json_object`` is set).
* ``supports_logprobs`` — no (treat as imputed confidences only).
* ``supports_multi_image`` — yes (Qwen-VL family accepts multiple images).
* ``supports_tensor_parallelism`` — N/A (managed serving).

This file is also one of the two "proof of Alibaba Cloud services" code
artifacts: it calls Alibaba Model Studio's inference API.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

from src.client.backends.protocol import (
    BackendCapabilities,
    BackendHealth,
    VLMRole,
)
from src.client.lm_client import LMStudioClient
from src.config import get_logger


if TYPE_CHECKING:
    from src.client.lm_client import VisionRequest, VisionResponse


logger = get_logger(__name__)


class QwenCloudBackend:
    """``VLMBackend`` adapter for Alibaba Model Studio (Qwen Cloud).

    One base URL + one API key serve three role models. Each role gets its
    own lazily-created ``LMStudioClient`` (so the async path, which binds the
    model on the client, also selects the correct per-role model). The legacy
    client owns retry/timeout/JSON-extraction policy; this class only adds
    role → model resolution and the ``response_format`` translation.
    """

    name = "qwen_cloud"

    def __init__(
        self,
        primary_url: str,
        api_key: str,
        primary_model: str,
        *,
        secondary_model: str | None = None,
        critic_model: str | None = None,
        force_json_object: bool = False,
        # Plumbing forwarded to each underlying LMStudioClient
        max_tokens: int | None = None,
        temperature: float | None = None,
        timeout: int | None = None,
        max_retries: int | None = None,
        retry_min_wait: int | None = None,
        retry_max_wait: int | None = None,
    ) -> None:
        if not primary_url or not primary_model:
            raise ValueError(
                "QwenCloudBackend requires primary_url and primary_model. "
                "Set VLM_QWEN_CLOUD_PRIMARY_URL and VLM_QWEN_CLOUD_PRIMARY_MODEL."
            )
        if not api_key:
            raise ValueError(
                "QwenCloudBackend requires an API key. Set VLM_QWEN_CLOUD_API_KEY "
                "(or DASHSCOPE_API_KEY) to your Model Studio key."
            )

        self._base_url = primary_url
        self._api_key = api_key
        self._primary_model = primary_model
        # SECONDARY / CRITIC collapse to PRIMARY when unset — still valid
        # (single-model) but not heterogeneous; log so it's visible.
        self._secondary_model = secondary_model or primary_model
        self._critic_model = critic_model or primary_model
        self._force_json_object = force_json_object

        self._client_kwargs: dict[str, Any] = {
            k: v
            for k, v in {
                "max_tokens": max_tokens,
                "temperature": temperature,
                "timeout": timeout,
                "max_retries": max_retries,
                "retry_min_wait": retry_min_wait,
                "retry_max_wait": retry_max_wait,
            }.items()
            if v is not None
        }

        # Lazy per-role clients bound to (base_url, role_model, api_key).
        self._clients: dict[VLMRole, LMStudioClient] = {}

        if self._secondary_model == self._primary_model:
            logger.warning(
                "qwen_cloud_secondary_collapsed",
                impact="SECONDARY (Auditor) uses the PRIMARY model; not heterogeneous",
            )
        if self._critic_model == self._primary_model:
            logger.warning(
                "qwen_cloud_critic_collapsed",
                impact="CRITIC uses the PRIMARY model; independence reduced",
            )

    # ------------------------------------------------------------------
    # Protocol surface
    # ------------------------------------------------------------------

    def capabilities(self) -> BackendCapabilities:
        is_hetero = (
            len({self._primary_model, self._secondary_model, self._critic_model}) > 1
        )
        notes: list[str] = []
        if not is_hetero:
            notes.append(
                "all roles resolve to the same model; configure "
                "VLM_QWEN_CLOUD_SECONDARY_MODEL / _CRITIC_MODEL for heterogeneity"
            )
        if self._force_json_object:
            notes.append("constrained decoding uses json_object fallback")
        return BackendCapabilities(
            name=self.name,
            supports_dual_vlm=True,  # one endpoint serves all models concurrently
            supports_constrained_decoding=True,
            supports_logprobs=False,
            supports_multi_image=True,
            supports_tensor_parallelism=False,
            notes=tuple(notes),
        )

    def resolve(self, role: VLMRole) -> tuple[str, str]:
        """Map a ``VLMRole`` to ``(base_url, model_id)`` — one endpoint, per-role model."""
        if role in (VLMRole.PRIMARY, VLMRole.LITE):
            return self._base_url, self._primary_model
        if role == VLMRole.SECONDARY:
            return self._base_url, self._secondary_model
        if role == VLMRole.CRITIC:
            return self._base_url, self._critic_model
        raise ValueError(f"Unknown VLMRole: {role!r}")

    def health(self) -> BackendHealth:
        """Probe the single Model Studio endpoint (shared by all roles)."""
        results: dict[VLMRole, dict[str, Any]] = {}
        client = self._get_client(VLMRole.PRIMARY)
        t0 = time.perf_counter()
        try:
            healthy = client.is_healthy()
            error: str | None = None
        except Exception as exc:  # pragma: no cover - defensive
            healthy = False
            error = str(exc)
        latency_ms = int((time.perf_counter() - t0) * 1000)
        for role in (VLMRole.PRIMARY, VLMRole.SECONDARY, VLMRole.CRITIC):
            _, model = self.resolve(role)
            detail: dict[str, Any] = {
                "healthy": healthy,
                "base_url": self._base_url,
                "model": model,
                "latency_ms": latency_ms,
            }
            if error is not None:
                detail["error"] = error
            results[role] = detail
        return BackendHealth(
            backend_name=self.name,
            overall_healthy=healthy,
            roles=results,
        )

    def send_vision_request(
        self,
        request: "VisionRequest",
        *,
        role: VLMRole = VLMRole.PRIMARY,
        schema: dict[str, Any] | None = None,
    ) -> "VisionResponse":
        client = self._get_client(role)
        _, model = self.resolve(role)
        response_format = self._build_response_format(schema)
        return client.send_vision_request(
            request,
            model=model,
            response_format=response_format,
        )

    async def send_vision_request_async(
        self,
        request: "VisionRequest",
        *,
        role: VLMRole = VLMRole.PRIMARY,
        schema: dict[str, Any] | None = None,
    ) -> "VisionResponse":
        # The async client binds the model on the client itself, so the
        # per-role client selects the correct model. response_format is not
        # plumbed through the async path yet (mirrors LMStudioBackend); the
        # sync path covers all schema-bound call sites today.
        client = self._get_client(role)
        return await client.send_vision_request_async(request)

    def _build_response_format(
        self,
        schema: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        """Translate a JSON-Schema dict into an OpenAI ``response_format``.

        Returns ``None`` when ``schema`` is ``None`` (unconstrained path).
        When ``force_json_object`` is set (DashScope strict-schema fallback,
        risk R1), returns ``{"type": "json_object"}`` and relies on Veridoc's
        L5 schema re-validation instead of decode-time enforcement.
        """
        if schema is None:
            return None
        if self._force_json_object:
            return {"type": "json_object"}
        return {
            "type": "json_schema",
            "json_schema": {
                "name": "veridoc",
                "schema": schema,
            },
        }

    def close(self) -> None:
        for client in self._clients.values():
            try:
                client.close()
            except Exception:  # pragma: no cover - best effort
                pass
        self._clients.clear()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _get_client(self, role: VLMRole) -> LMStudioClient:
        if role not in self._clients:
            _, model = self.resolve(role)
            self._clients[role] = LMStudioClient(
                base_url=self._base_url,
                model=model,
                api_key=self._api_key,
                **self._client_kwargs,
            )
        return self._clients[role]


# Protocol conformance is asserted at runtime in
# ``tests/unit/test_qwen_cloud_backend.py`` via ``isinstance(backend, VLMBackend)``.
