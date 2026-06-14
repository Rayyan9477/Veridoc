"""V3 Phase 8 — webhook URL safety / SSRF defence.

The webhook dispatcher accepts subscriber URLs from authenticated
operators. A malicious URL can target internal services
(``http://internal-mongo:27017/``, AWS IMDSv1, GCP metadata, etc.)
unless we resolve the hostname and reject any IP that lies in a
private / loopback / link-local / multicast / metadata range.

This module exposes a single function ``check_public_url(url)`` that
parses the URL, resolves it via DNS, walks every returned address
through ``ipaddress.ip_address`` and rejects on any of:

* loopback (`127.0.0.0/8`, `::1`)
* private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`)
* link-local (`169.254/16`, `fe80::/10`)
* multicast (`224/4`, `ff00::/8`)
* reserved (e.g. `0/8`)
* CGNAT (`100.64/10`)
* cloud metadata IPs (``169.254.169.254`` covered by link-local;
  ``fd00::ec2:0`` covered by private)

Operators who legitimately need to reach internal hosts (staging /
on-prem) can set ``WEBHOOK_ALLOW_PRIVATE=1`` to disable the rejection.
This is a deployment-wide escape hatch; per-tenant allow-lists are
deferred.

DNS-rebinding mitigation: callers should pass the resolved IP
returned by ``check_public_url`` to httpx via the ``Host`` header
trick rather than re-resolving at request time. We expose the
resolved IPs from ``check_public_url`` so the caller can do that
when it wants to.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from dataclasses import dataclass, field
from urllib.parse import urlparse


@dataclass(frozen=True, slots=True)
class UrlSafetyResult:
    """Outcome of ``check_public_url``."""

    allowed: bool
    reason: str | None = None
    hostname: str | None = None
    resolved_ips: tuple[str, ...] = field(default_factory=tuple)


# Cloud metadata hostnames operators sometimes try to embed when
# they don't realise the IP-level filter would catch them.
_BLOCKED_HOSTNAMES: frozenset[str] = frozenset(
    {
        "localhost",
        "metadata.google.internal",
        "metadata.azure.com",
    }
)


def _is_private_or_unsafe(addr: ipaddress.IPv4Address | ipaddress.IPv6Address) -> tuple[bool, str | None]:
    """Return (unsafe, reason).

    For IPv6 addresses we unwrap three transition formats BEFORE the
    generic ``is_loopback``/``is_private``/``is_reserved`` checks so the
    inner destination governs the verdict (not the outer wrapper, which
    stdlib often classifies as ``reserved`` or ``private`` by accident
    of IETF block assignment).

    The three formats:

    * **IPv4-mapped IPv6** (``::ffff:0:0/96``) — ``::ffff:127.0.0.1``
      tunnels 127.0.0.1. Python's stdlib classifies the outer prefix as
      ``is_reserved``, so without explicit unwrap the reason string is
      misleading on some runtimes.
    * **6to4** (``2002::/16``) — destination IPv4 lives in bits [16, 48).
    * **Teredo** (``2001::/32``) — tunnels arbitrary IPv4 via UDP. The
      whole prefix is rejected conservatively because the destination
      IPv4 is XOR-obfuscated and not worth parsing.

    For an IPv6 transition format whose inner IPv4 is PUBLIC, we
    short-circuit ``return False, None`` so the outer wrapper's
    ``is_reserved`` flag doesn't false-trip. Otherwise legitimate
    ``::ffff:8.8.8.8`` traffic would be rejected as "reserved".
    """
    # IPv6 transition-format unwrapping runs FIRST so the specific
    # reason wins over the generic ``is_reserved`` / ``is_private``
    # classification of the outer wrapper prefix.
    if isinstance(addr, ipaddress.IPv6Address):
        # IPv4-mapped: ::ffff:a.b.c.d — judge by the IPv4 inner.
        mapped = addr.ipv4_mapped
        if mapped is not None:
            inner_unsafe, inner_reason = _is_private_or_unsafe(mapped)
            if inner_unsafe:
                return True, f"ipv6_mapped_{inner_reason}"
            # Inner is public — allow, don't trip outer ``is_reserved``.
            return False, None
        # 6to4: 2002:WWXX:YYZZ::/48 — embedded IPv4 is bits [16, 48).
        try:
            six_to_four = ipaddress.ip_network("2002::/16")
            if addr in six_to_four:
                inner_int = (int(addr) >> 80) & 0xFFFFFFFF
                inner = ipaddress.IPv4Address(inner_int)
                inner_unsafe, inner_reason = _is_private_or_unsafe(inner)
                if inner_unsafe:
                    return True, f"6to4_{inner_reason}"
                # Inner is public — allow.
                return False, None
        except (ValueError, OverflowError):
            pass
        # Teredo: 2001::/32 — block entire prefix. Destination IPv4 is
        # XOR-obfuscated in bits [96, 128); cleanest defence is reject.
        try:
            teredo = ipaddress.ip_network("2001::/32")
            if addr in teredo:
                return True, "teredo"
        except (ValueError, TypeError):
            pass

    # Generic safety checks (apply to IPv4 + non-transition IPv6).
    if addr.is_loopback:
        return True, "loopback"
    if addr.is_link_local:
        return True, "link_local"
    if addr.is_multicast:
        return True, "multicast"
    if addr.is_private:
        return True, "private"
    if addr.is_reserved:
        return True, "reserved"
    if addr.is_unspecified:
        return True, "unspecified"
    # CGNAT range 100.64.0.0/10 (RFC 6598). ``is_private`` already
    # covers this in modern Python (3.11+) but be explicit.
    try:
        cgnat = ipaddress.ip_network("100.64.0.0/10")
        if addr in cgnat:
            return True, "cgnat"
    except (ValueError, TypeError):
        pass

    return False, None


def check_public_url(url: str) -> UrlSafetyResult:
    """Validate a URL for safe outbound use; reject SSRF candidates.

    Resolves the hostname via ``socket.getaddrinfo`` and rejects when
    any returned address is private / loopback / link-local /
    multicast / reserved / CGNAT.

    Honours ``WEBHOOK_ALLOW_PRIVATE=1`` env var as an escape hatch
    for staging / on-prem deployments where webhooks legitimately
    target internal hosts.
    """
    try:
        parsed = urlparse(url)
    except Exception as e:
        return UrlSafetyResult(allowed=False, reason=f"parse_error: {e}")

    if parsed.scheme not in {"http", "https"}:
        return UrlSafetyResult(
            allowed=False,
            reason=f"unsupported_scheme: {parsed.scheme!r}",
        )

    hostname = parsed.hostname
    if not hostname:
        return UrlSafetyResult(allowed=False, reason="missing_hostname")

    # Hostname blocklist (covers the rare cases where a name maps to
    # something dangerous via /etc/hosts overrides).
    if hostname.lower() in _BLOCKED_HOSTNAMES:
        return UrlSafetyResult(
            allowed=False,
            reason=f"blocked_hostname: {hostname}",
            hostname=hostname,
        )

    # Escape hatch for staging / on-prem.
    if os.environ.get("WEBHOOK_ALLOW_PRIVATE", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }:
        return UrlSafetyResult(
            allowed=True,
            reason="allow_private_override",
            hostname=hostname,
        )

    # Resolve. ``getaddrinfo`` returns both IPv4 and IPv6 results when
    # available. Any single unsafe address fails the whole URL
    # because DNS-rebinding could swap to an unsafe entry on retry.
    try:
        infos = socket.getaddrinfo(
            hostname,
            None,
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as e:
        return UrlSafetyResult(
            allowed=False,
            reason=f"dns_resolution_failed: {e}",
            hostname=hostname,
        )

    resolved: list[str] = []
    for info in infos:
        sockaddr = info[4]
        ip_str = sockaddr[0]
        if ip_str not in resolved:
            resolved.append(ip_str)
        try:
            addr = ipaddress.ip_address(ip_str)
        except (ValueError, TypeError):
            continue
        unsafe, reason = _is_private_or_unsafe(addr)
        if unsafe:
            return UrlSafetyResult(
                allowed=False,
                reason=f"unsafe_ip ({reason}): {ip_str}",
                hostname=hostname,
                resolved_ips=tuple(resolved),
            )

    return UrlSafetyResult(
        allowed=True,
        hostname=hostname,
        resolved_ips=tuple(resolved),
    )
