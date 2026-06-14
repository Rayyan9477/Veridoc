"""Regression suite — SSRF via IPv6 transition formats.

The webhook SSRF gate at ``src/queue/_url_safety.py`` resolves a hostname
via DNS and rejects every result that is private / loopback / link-local
/ multicast / reserved / CGNAT. Python's stdlib ``ipaddress`` does NOT
see through three IPv6 transition formats by default:

* **IPv4-mapped IPv6** (``::ffff:0:0/96``) — ``IPv6Address.is_loopback``
  returns ``False`` for ``::ffff:127.0.0.1`` on every supported runtime.
* **6to4** (``2002::/16``) — the destination IPv4 lives in bits [16,48).
* **Teredo** (``2001::/32``) — tunnels arbitrary IPv4 via UDP.

Without explicit unwrapping a subscriber whose hostname resolves to one
of these formats can target cloud metadata IPs, internal services, or
loopback through the gate. The fix in ``_is_private_or_unsafe`` adds
three explicit branches; this file is the regression net.

These tests stub ``socket.getaddrinfo`` so they never make real DNS
calls and run on every CI runner.
"""

from __future__ import annotations

import socket
from unittest.mock import patch

import pytest

from src.queue._url_safety import check_public_url


def _resolve_to(ip: str):
    """Patch socket.getaddrinfo to return a single resolution to ``ip``.

    Decides AF_INET vs AF_INET6 from the address shape so the stubbed
    ``getaddrinfo`` matches reality.
    """
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    sockaddr: tuple = (ip, 0, 0, 0) if family == socket.AF_INET6 else (ip, 0)
    return patch(
        "src.queue._url_safety.socket.getaddrinfo",
        return_value=[(family, socket.SOCK_STREAM, 0, "", sockaddr)],
    )


# ---------------------------------------------------------------------------
# IPv4-mapped IPv6 (::ffff:a.b.c.d) — should be rejected when the inner
# IPv4 is private / loopback / link-local / metadata.
# ---------------------------------------------------------------------------


class TestIPv4MappedIPv6:
    @pytest.mark.parametrize(
        ("mapped_ip", "expected_reason_fragment"),
        [
            ("::ffff:127.0.0.1", "loopback"),
            ("::ffff:127.255.255.254", "loopback"),
            ("::ffff:10.0.0.1", "private"),
            ("::ffff:192.168.1.1", "private"),
            ("::ffff:172.16.0.1", "private"),
            ("::ffff:169.254.169.254", "link_local"),  # AWS metadata
            ("::ffff:169.254.0.1", "link_local"),
            # 0.0.0.0 is classified as both ``is_private`` and
            # ``is_unspecified`` in stdlib; ``is_private`` fires first
            # in the check order, so either reason fragment is correct.
            ("::ffff:0.0.0.0", "private"),
        ],
    )
    def test_unsafe_inner_ipv4_rejected(
        self, mapped_ip: str, expected_reason_fragment: str
    ) -> None:
        with _resolve_to(mapped_ip):
            result = check_public_url("http://attacker.example.com/")
        assert not result.allowed, (
            f"{mapped_ip} should have been rejected; reason={result.reason!r}"
        )
        assert expected_reason_fragment in (result.reason or ""), result.reason
        assert "ipv6_mapped" in (result.reason or ""), result.reason

    def test_public_ipv4_via_mapped_still_allowed(self) -> None:
        # 8.8.8.8 is a public IPv4 — the mapped form must NOT be rejected.
        with _resolve_to("::ffff:8.8.8.8"):
            result = check_public_url("http://attacker.example.com/")
        assert result.allowed, result.reason


# ---------------------------------------------------------------------------
# 6to4 (2002::/16) — embeds the destination IPv4 in bits [16, 48).
# Format: 2002:WWXX:YYZZ:: where W.X.Y.Z is the inner IPv4.
# ---------------------------------------------------------------------------


class TestSixToFour:
    @pytest.mark.parametrize(
        ("six_to_four_ip", "expected_reason_fragment"),
        [
            # 127.0.0.1 -> 0x7f000001 -> 2002:7f00:0001::
            ("2002:7f00:0001::", "loopback"),
            # 10.0.0.5 -> 0x0a000005 -> 2002:0a00:0005::
            ("2002:0a00:0005::", "private"),
            # 169.254.169.254 -> 0xa9fea9fe -> 2002:a9fe:a9fe::
            ("2002:a9fe:a9fe::", "link_local"),
        ],
    )
    def test_unsafe_inner_ipv4_rejected(
        self, six_to_four_ip: str, expected_reason_fragment: str
    ) -> None:
        with _resolve_to(six_to_four_ip):
            result = check_public_url("http://attacker.example.com/")
        assert not result.allowed, (
            f"{six_to_four_ip} should have been rejected; reason={result.reason!r}"
        )
        assert expected_reason_fragment in (result.reason or ""), result.reason
        assert "6to4" in (result.reason or ""), result.reason

    def test_public_ipv4_via_6to4_still_allowed(self) -> None:
        # 8.8.8.8 -> 0x08080808 -> 2002:0808:0808::
        with _resolve_to("2002:0808:0808::"):
            result = check_public_url("http://attacker.example.com/")
        assert result.allowed, result.reason


# ---------------------------------------------------------------------------
# Teredo (2001::/32) — block entire prefix conservatively. Teredo can
# tunnel arbitrary IPv4 destinations via UDP and the destination IPv4 is
# embedded with XOR obfuscation; cleanest defence is full-prefix reject.
# ---------------------------------------------------------------------------


class TestTeredo:
    @pytest.mark.parametrize(
        "teredo_ip",
        [
            "2001:0000:0000:0000:0000:0000:0000:0001",
            "2001:0:53aa:64c:30dd:8be1:9b81:8d8b",  # arbitrary Teredo address
        ],
    )
    def test_teredo_prefix_blocked(self, teredo_ip: str) -> None:
        with _resolve_to(teredo_ip):
            result = check_public_url("http://attacker.example.com/")
        assert not result.allowed, (
            f"{teredo_ip} should have been rejected; reason={result.reason!r}"
        )
        assert "teredo" in (result.reason or ""), result.reason


# ---------------------------------------------------------------------------
# Smoke — established behaviour still holds.
# ---------------------------------------------------------------------------


class TestExistingBehaviourStillCorrect:
    def test_public_ipv4_allowed(self) -> None:
        with _resolve_to("8.8.8.8"):
            result = check_public_url("http://dns.google/")
        assert result.allowed

    def test_public_ipv6_allowed(self) -> None:
        # 2606:4700:4700::1111 is Cloudflare's public DNS
        with _resolve_to("2606:4700:4700::1111"):
            result = check_public_url("http://one.one.one.one/")
        assert result.allowed

    def test_raw_ipv6_loopback_still_blocked(self) -> None:
        with _resolve_to("::1"):
            result = check_public_url("http://attacker.example.com/")
        assert not result.allowed
        assert "loopback" in (result.reason or "")
