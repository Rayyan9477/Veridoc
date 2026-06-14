"""Regression suite — R1.2 tenant_id end-to-end through JWT + middleware.

Before R1.2:

* ``User`` had no ``tenant_id`` field.
* ``TokenPayload`` had no ``tenant_id`` field.
* ``AuthenticationMiddleware`` never wrote ``request.state.user_claims``
  or ``request.state.tenant_id``.

Effect: every authenticated user collapsed onto the default tenant
regardless of which tenant their JWT had been issued for. Per-tenant
FAISS / calibration / audit / rate-limit buckets all keyed by the same
ID. The R1.2 fix wires ``tenant_id`` end-to-end:

1. ``User.tenant_id`` (default ``"default"``).
2. ``TokenPayload.tenant_id`` (issued by ``create_access_token``).
3. ``AuthenticationMiddleware`` writes both ``user_claims`` (full dict)
   and ``tenant_id`` (resolved) onto ``request.state``.
4. ``TenantResolverMiddleware`` (existing) reads them and routes
   per-tenant state.

This file asserts the wiring at each layer plus the end-to-end JWT →
``request.state.tenant_id`` round-trip.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from src.api.middleware import AuthenticationMiddleware
from src.security.rbac import (
    RBACManager,
    Role,
    TokenPayload,
)


@pytest.fixture(autouse=True)
def reset_rbac():
    RBACManager.reset_instance()
    yield
    RBACManager.reset_instance()


@pytest.fixture
def rbac(tmp_path) -> RBACManager:
    return RBACManager.get_instance(
        secret_key="tenant-jwt-wiring-test-secret-key-XYZ-12345",
        user_storage_path=str(tmp_path / "users.json"),
    )


# ---------------------------------------------------------------------------
# Layer 1 — TokenPayload tenant_id round-trip
# ---------------------------------------------------------------------------


class TestTokenPayloadTenantId:
    def test_default_tenant_id(self) -> None:
        p = TokenPayload(
            sub="u1",
            username="u1",
            roles=["viewer"],
            permissions=[],
            exp=datetime.now(UTC),
            iat=datetime.now(UTC),
            jti="jti1",
        )
        assert p.tenant_id == "default"

    def test_explicit_tenant_id_round_trip(self) -> None:
        p = TokenPayload(
            sub="u1",
            username="u1",
            roles=[],
            permissions=[],
            exp=datetime.now(UTC),
            iat=datetime.now(UTC),
            jti="jti2",
            tenant_id="acme-corp",
        )
        assert p.to_dict()["tenant_id"] == "acme-corp"
        p2 = TokenPayload.from_dict(p.to_dict())
        assert p2.tenant_id == "acme-corp"

    def test_legacy_payload_without_tenant_id_defaults(self) -> None:
        """Pre-R1.2 tokens have no ``tenant_id`` claim. ``from_dict``
        must default rather than raise — no forced re-login on upgrade."""
        legacy = {
            "sub": "u1",
            "username": "u1",
            "roles": [],
            "permissions": [],
            "exp": int(datetime.now(UTC).timestamp()) + 3600,
            "iat": int(datetime.now(UTC).timestamp()),
            "jti": "legacy-jti",
            "token_type": "access",
            # NB: no ``tenant_id``
        }
        p = TokenPayload.from_dict(legacy)
        assert p.tenant_id == "default"


# ---------------------------------------------------------------------------
# Layer 2 — User.tenant_id default + create_user kwarg
# ---------------------------------------------------------------------------


class TestUserTenantId:
    def test_default_user_tenant_is_default(self, rbac: RBACManager) -> None:
        user = rbac.users.create_user(
            username="alice",
            email="alice@test.local",
            password="P@ssword-alice-2026!",
            roles={Role.VIEWER},
        )
        assert user.tenant_id == "default"

    def test_create_user_with_explicit_tenant(self, rbac: RBACManager) -> None:
        user = rbac.users.create_user(
            username="bob",
            email="bob@acme.test",
            password="P@ssword-bob-2026!",
            roles={Role.VIEWER},
            tenant_id="acme-corp",
        )
        assert user.tenant_id == "acme-corp"

    def test_user_dict_round_trip_preserves_tenant(self, rbac: RBACManager) -> None:
        user = rbac.users.create_user(
            username="charlie",
            email="charlie@example.com",
            password="P@ssword-charlie-2026!",
            roles={Role.VIEWER},
            tenant_id="globex",
        )
        d = user.to_dict()
        assert d["tenant_id"] == "globex"


# ---------------------------------------------------------------------------
# Layer 3 — JWT issuance embeds the user's tenant_id as a claim
# ---------------------------------------------------------------------------


class TestTokenIssuanceEmbedsTenant:
    def test_access_token_carries_user_tenant_id(self, rbac: RBACManager) -> None:
        user = rbac.users.create_user(
            username="dave",
            email="dave@acme.test",
            password="P@ssword-dave-2026!",
            roles={Role.VIEWER},
            tenant_id="acme-corp",
        )
        token, _expires = rbac.tokens.create_access_token(user)
        payload = rbac.tokens.validate_token(token)
        assert payload.tenant_id == "acme-corp"

    def test_refresh_token_carries_user_tenant_id(
        self, rbac: RBACManager
    ) -> None:
        user = rbac.users.create_user(
            username="eve",
            email="eve@globex.test",
            password="P@ssword-eve-2026!",
            roles={Role.VIEWER},
            tenant_id="globex",
        )
        token, _expires = rbac.tokens.create_refresh_token(user)
        payload = rbac.tokens.validate_token(token)
        assert payload.tenant_id == "globex"


# ---------------------------------------------------------------------------
# Layer 4 — AuthenticationMiddleware populates request.state.user_claims
# and request.state.tenant_id from the JWT
# ---------------------------------------------------------------------------


@pytest.fixture
def echo_app(rbac: RBACManager) -> FastAPI:
    """Tiny app with AuthN middleware + an echo route that returns the
    tenant_id the middleware bound on ``request.state``."""
    app = FastAPI()
    app.add_middleware(AuthenticationMiddleware, rbac_manager=rbac)

    @app.get("/echo-tenant")
    async def echo(request: Request) -> dict[str, str | None]:
        return {
            "tenant_id": getattr(request.state, "tenant_id", None),
            "user_claims_tenant_id": (
                getattr(request.state, "user_claims", {}) or {}
            ).get("tenant_id"),
            "username": getattr(request.state, "username", None),
        }

    return app


class TestMiddlewareTenantPropagation:
    def test_default_tenant_token_lands_default(
        self,
        echo_app: FastAPI,
        rbac: RBACManager,
    ) -> None:
        user = rbac.users.create_user(
            username="frank",
            email="frank@test.local",
            password="P@ssword-frank-2026!",
            roles={Role.VIEWER},
        )
        token, _ = rbac.tokens.create_access_token(user)
        client = TestClient(echo_app)
        r = client.get(
            "/echo-tenant",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["tenant_id"] == "default"
        assert body["user_claims_tenant_id"] == "default"

    def test_acme_tenant_token_lands_acme(
        self,
        echo_app: FastAPI,
        rbac: RBACManager,
    ) -> None:
        user = rbac.users.create_user(
            username="grace",
            email="grace@acme.test",
            password="P@ssword-grace-2026!",
            roles={Role.VIEWER},
            tenant_id="acme-corp",
        )
        token, _ = rbac.tokens.create_access_token(user)
        client = TestClient(echo_app)
        r = client.get(
            "/echo-tenant",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["tenant_id"] == "acme-corp"
        assert body["user_claims_tenant_id"] == "acme-corp"
        assert body["username"] == "grace"

    def test_globex_user_does_not_leak_into_acme(
        self,
        echo_app: FastAPI,
        rbac: RBACManager,
    ) -> None:
        """Two users on two different tenants — each request's bound
        tenant_id matches its JWT, not a shared default."""
        u_acme = rbac.users.create_user(
            username="harry",
            email="harry@acme.test",
            password="P@ssword-harry-2026!",
            roles={Role.VIEWER},
            tenant_id="acme-corp",
        )
        u_globex = rbac.users.create_user(
            username="ivy",
            email="ivy@globex.test",
            password="P@ssword-ivy-2026!",
            roles={Role.VIEWER},
            tenant_id="globex",
        )
        t_acme, _ = rbac.tokens.create_access_token(u_acme)
        t_globex, _ = rbac.tokens.create_access_token(u_globex)

        client = TestClient(echo_app)
        r_acme = client.get(
            "/echo-tenant",
            headers={"Authorization": f"Bearer {t_acme}"},
        )
        r_globex = client.get(
            "/echo-tenant",
            headers={"Authorization": f"Bearer {t_globex}"},
        )
        assert r_acme.json()["tenant_id"] == "acme-corp"
        assert r_globex.json()["tenant_id"] == "globex"
