"""
User roster API routes.

Veridoc has a real, persistent user store — ``UserStore`` in
``src/security/rbac.py`` reads/writes ``data/users.json`` and backs the
auth/RBAC layer. This router exposes a read-only listing of that store
so the Users screen shows the real roster instead of an empty shell.

Read-only by design: creating/editing users and role assignment flow
through the auth subsystem's privileged paths, which are out of scope
here. Sensitive fields (password hashes) are never returned.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from src.config import get_logger


logger = get_logger(__name__)
router = APIRouter()


def _get_user_store() -> Any:
    """Resolve the live user store.

    Prefers the RBAC manager already wired onto ``app.state`` (present
    when auth is enabled) or the process-wide RBAC singleton; otherwise
    reads the canonical ``data/users.json`` directly via a fresh
    ``UserStore`` (same file the RBAC manager uses). This works whether
    or not auth is enabled, without needing the JWT secret.
    """
    from src.security.rbac import RBACManager, UserStore

    instance = getattr(RBACManager, "_instance", None)
    if instance is not None:
        try:
            return instance.users
        except Exception:
            pass
    return UserStore()


def _project_user(user: Any) -> dict[str, Any]:
    """Project a ``User`` onto the roster shape (no sensitive fields)."""
    base = user.to_dict()  # already excludes password_hash
    metadata = getattr(user, "metadata", {}) or {}
    mfa = metadata.get("mfa_enabled")
    if mfa is None:
        mfa = metadata.get("mfa")
    return {
        "user_id": base.get("user_id", ""),
        "username": base.get("username", ""),
        "email": base.get("email", ""),
        "roles": base.get("roles", []),
        "tenant_id": base.get("tenant_id", "default"),
        "is_active": base.get("is_active", True),
        "is_locked": base.get("is_locked", False),
        "last_login": base.get("last_login"),
        # None => unknown (the store has no MFA field); the UI shows "—".
        "mfa_enabled": mfa if isinstance(mfa, bool) else None,
    }


@router.get(
    "/users",
    summary="List users",
    description=(
        "List users from the persistent user store (data/users.json), "
        "read-only. Password hashes are never returned."
    ),
)
async def list_users(
    http_request: Request,
    limit: int = 200,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """List users from the persistent RBAC user store."""
    request_id = getattr(http_request.state, "request_id", "")
    limit = max(1, min(limit, 1000))
    offset = max(0, offset)

    try:
        store = _get_user_store()
        users = store.list_users(limit=limit, offset=offset)
        roster = [_project_user(u) for u in users]
    except Exception as e:
        logger.error("list_users_error", request_id=request_id, error=str(e))
        # Honest failure: return an empty roster rather than fabricating.
        roster = []

    logger.info("list_users_request", request_id=request_id, count=len(roster))
    return roster
