"""Regression suite — route-level auth gates.

P0 from the audit: several admin / write routes shipped with **zero**
``Depends(require_permission(...))`` gates, so any authenticated viewer
(or even any request that survives ``AuthenticationMiddleware`` with no
RBAC manager configured) could trigger them.

The fixed routes:

* ``POST /api/v1/queue/{name}/purge`` — requires ``system:admin``.
* ``POST /api/v1/webhooks`` (and the rest of ``routes/webhooks.py``) —
  requires ``api:webhook``.

This file boots a minimal FastAPI app with the real
``AuthenticationMiddleware`` so the gates actually fire against forged
viewer / admin / operator JWTs.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api.middleware import AuthenticationMiddleware
from src.security.rbac import RBACManager, Role, User


@pytest.fixture(autouse=True)
def reset_rbac():
    RBACManager.reset_instance()
    yield
    RBACManager.reset_instance()


@pytest.fixture
def rbac_manager(tmp_path) -> RBACManager:
    return RBACManager.get_instance(
        secret_key="route-auth-gate-test-secret-key-XYZ-12345",
        user_storage_path=str(tmp_path / "users.json"),
    )


def _make_user(
    rbac: RBACManager,
    username: str,
    roles: set[Role],
) -> User:
    """Create + persist a test user with the given roles. ``UserStore``
    derives permissions from roles via ``User.get_all_permissions()``.
    """
    return rbac.users.create_user(
        username=username,
        email=f"{username}@test.local",
        password=f"P@ssword-{username}-2026!",
        roles=roles,
    )


def _bearer(rbac: RBACManager, user: User) -> dict[str, str]:
    # ``TokenManager.create_access_token`` returns (token_str, expiry).
    token, _expires = rbac.tokens.create_access_token(user)
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def app_with_queue(rbac_manager: RBACManager) -> FastAPI:
    """App with the queue router + real AuthN middleware."""
    from src.api.routes.queue import router as queue_router

    app = FastAPI()
    app.add_middleware(AuthenticationMiddleware, rbac_manager=rbac_manager)
    app.include_router(queue_router, prefix="/api/v1")
    return app


@pytest.fixture
def app_with_webhooks(rbac_manager: RBACManager) -> FastAPI:
    """App with the webhooks router + real AuthN middleware."""
    from src.api.routes.webhooks import router as wh_router

    app = FastAPI()
    app.add_middleware(AuthenticationMiddleware, rbac_manager=rbac_manager)
    app.include_router(wh_router, prefix="/api/v1")
    return app


# ---------------------------------------------------------------------------
# R1.6 — /queue/{name}/purge requires system:admin
# ---------------------------------------------------------------------------


class TestQueuePurgeAuth:
    def test_unauthenticated_request_rejected(
        self, app_with_queue: FastAPI
    ) -> None:
        client = TestClient(app_with_queue)
        r = client.post("/api/v1/queue/celery/purge")
        # AuthenticationMiddleware does not 401 on missing token — it
        # defers to per-route dependencies. ``require_permission`` then
        # fires 403 because ``request.state.permissions`` is empty.
        # Either 401 or 403 satisfies "request was rejected".
        assert r.status_code in (401, 403), r.text

    def test_viewer_role_gets_403(
        self,
        app_with_queue: FastAPI,
        rbac_manager: RBACManager,
    ) -> None:
        user = _make_user(rbac_manager, "viewer1", roles={Role.VIEWER})
        client = TestClient(app_with_queue)
        r = client.post(
            "/api/v1/queue/celery/purge",
            headers=_bearer(rbac_manager, user),
        )
        assert r.status_code == 403, r.text
        body: dict[str, Any] = r.json()
        # FastAPI wraps custom dict details under ``detail``; the
        # ``require_permission`` dependency uses ``"forbidden"`` as the
        # ``error`` field and includes the required perm in ``message``.
        detail = body.get("detail", {})
        if isinstance(detail, dict):
            assert detail.get("error") == "forbidden", body
            assert "system:admin" in detail.get("message", ""), body

    def test_manager_role_gets_403(
        self,
        app_with_queue: FastAPI,
        rbac_manager: RBACManager,
    ) -> None:
        # MANAGER has document + user perms but NOT system:admin.
        user = _make_user(rbac_manager, "mgr1", roles={Role.MANAGER})
        client = TestClient(app_with_queue)
        r = client.post(
            "/api/v1/queue/celery/purge",
            headers=_bearer(rbac_manager, user),
        )
        assert r.status_code == 403, r.text

    def test_admin_role_passes_the_gate(
        self,
        app_with_queue: FastAPI,
        rbac_manager: RBACManager,
    ) -> None:
        """Admin gets past the gate — downstream may still 503 if Redis
        is unavailable in the test env (we accept any non-403 response
        as proof the gate didn't fire)."""
        user = _make_user(rbac_manager, "admin1", roles={Role.ADMIN})
        client = TestClient(app_with_queue)
        r = client.post(
            "/api/v1/queue/celery/purge",
            headers=_bearer(rbac_manager, user),
        )
        assert r.status_code != 403, (
            f"Admin should pass require_permission(SYSTEM_ADMIN); "
            f"got 403 with body: {r.text}"
        )


# ---------------------------------------------------------------------------
# R1.7 — webhook routes require api:webhook
# ---------------------------------------------------------------------------


class TestWebhookAuth:
    """Each webhook route under ``src/api/routes/webhooks.py`` must
    refuse a viewer JWT with 403 and accept a JWT carrying
    ``api:webhook``.

    We exercise the three highest-impact handlers (subscribe, list,
    delete). The remaining 5 share the same gate dependency once R1.7
    lands; one representative per HTTP verb keeps the suite small but
    catches regressions on the shared `require_permission(API_WEBHOOK)`
    invocation.
    """

    def test_subscribe_rejects_viewer(
        self,
        app_with_webhooks: FastAPI,
        rbac_manager: RBACManager,
    ) -> None:
        user = _make_user(rbac_manager, "v2", roles={Role.VIEWER})
        client = TestClient(app_with_webhooks)
        r = client.post(
            "/api/v1/webhooks",
            json={"url": "https://example.com/hook", "events": ["x"]},
            headers=_bearer(rbac_manager, user),
        )
        assert r.status_code == 403, r.text

    def test_list_rejects_viewer(
        self,
        app_with_webhooks: FastAPI,
        rbac_manager: RBACManager,
    ) -> None:
        user = _make_user(rbac_manager, "v3", roles={Role.VIEWER})
        client = TestClient(app_with_webhooks)
        r = client.get(
            "/api/v1/webhooks",
            headers=_bearer(rbac_manager, user),
        )
        assert r.status_code == 403, r.text

    def test_delete_rejects_viewer(
        self,
        app_with_webhooks: FastAPI,
        rbac_manager: RBACManager,
    ) -> None:
        user = _make_user(rbac_manager, "v4", roles={Role.VIEWER})
        client = TestClient(app_with_webhooks)
        r = client.delete(
            "/api/v1/webhooks/nonexistent-id",
            headers=_bearer(rbac_manager, user),
        )
        assert r.status_code == 403, r.text

    def test_admin_passes_the_gate(
        self,
        app_with_webhooks: FastAPI,
        rbac_manager: RBACManager,
    ) -> None:
        """ADMIN carries every permission, including ``api:webhook`` —
        must pass the gate. The downstream handler may still return
        400/404 because no store is wired in the test app; we accept
        any non-403 as proof the gate didn't fire.

        Note: in the production role map only ADMIN carries
        ``api:webhook`` today. A future ``Role.WEBHOOK_OPERATOR`` would
        be a natural addition, but is out of scope for this regression
        test.
        """
        user = _make_user(rbac_manager, "admin2", roles={Role.ADMIN})
        client = TestClient(app_with_webhooks)
        r = client.get(
            "/api/v1/webhooks",
            headers=_bearer(rbac_manager, user),
        )
        assert r.status_code != 403, (
            f"Admin should pass require_permission(API_WEBHOOK); "
            f"got 403 with body: {r.text}"
        )
