---
title: Veridoc — Fix plan for the consolidated review findings
audience: maintainers, reviewers
companion_doc: ./CODEBASE_REVIEW.md
last_updated: 2026-05-24
status: PROPOSED — awaiting approval before execution
---

# Veridoc — Fix plan

> **Status: PROPOSED — no code will change until this plan is approved.** Companion to [`CODEBASE_REVIEW.md`](./CODEBASE_REVIEW.md). Every fix below is traceable back to a numbered finding in the review.

## Guiding constraints (carried from the master plan)

1. **The 2853-test baseline stays green at every merge.** Net-new tests are additive; no test gets weakened to make a fix pass.
2. **One PR per finding** where practical — keeps reverts surgical, gives reviewers a small surface to confirm.
3. **Behaviour changes ship behind a default-off legacy flag** when there's any chance a downstream caller relies on the broken behaviour (mirrors the `*_BYPASS_ACK` pattern from Phase 7 / 8).
4. **Every PR's gate is a pytest command listed in the PR body.** No "passes locally" claims without a reproducible command.
5. **No commits without explicit approval at the gate boundaries** marked **STOP — confirm with user**.
6. **Default-deny on safety knobs.** New env-var flags default to the safer behaviour (auth on, mask full, signing required).

## Pre-flight digging (already done, summarised here)

Before this plan was written, the following extra verifications were performed (beyond the agents' reports):

| Check | Result |
|---|---|
| Other `**state_returning_fn(...)` spread bugs in `src/` | None. Bug is **exactly** at `extractor_pass1.py:181` + `extractor_pass2.py:222`. |
| `TokenPayload` has `tenant_id`? | **No.** Field absent. JWT issuance path needs tenant_id too. |
| `User` model has `tenant_id`? | **No.** Field absent. User store / signup / login paths all need it. |
| `authStore.ts` references `DEV_AUTO_LOGIN`? | **No coupling.** Fix is contained to `ProtectedRoute.tsx`. |
| Routes with `Depends(...)` or `require_*` in `routes/queue.py` + `routes/webhooks.py` | **Zero.** Every route in both files is dependency-free. |
| `validation_is_valid` / `_requires_retry` / `_requires_human_review` declared in `ExtractionState`? | **No.** Written by validator (`:887-889`) and read by orchestrator (`:1338-1340`) but never declared. |
| Critic `verify_bbox` actually dead code? | **Downgraded.** The orchestrator comment at `:1320-1326` is correct: the reconciler runs `perform_bbox_roundtrip` inline (`orchestrator.py:1847`), so falling through to confidence routing is intentional. Agent A's framing was wrong; **this is not a P1**. |
| `lm_client` populates `tool_calls` on `VisionResponse.usage`? | **No.** Zero references to `tool_calls` in `lm_client.py`. `gemma_backend.parse_tool_calls` structured path is dead — only the regex fallback runs. |
| `batch_process_task` signature carries profile/modality overrides? | **No.** Lines `tasks.py:631-640` accept neither; child `process_document_task.s(...)` at `:676-684` doesn't forward them. |
| `_previous_ece` persisted to disk? | **No.** Only line-582 in-memory init + line-713 in-memory write. No `_load_ece_history` / `_save_ece_history` in module. |

These confirmations rule out three scenarios that would have changed the plan:
- The auth-middleware fix is **not** the whole tenant-isolation fix — TokenPayload + User model also need `tenant_id`.
- The Critic `verify_bbox` finding is downgraded out of the P1 list.
- The DLQ race is **cross-process**, not within-process — `self._lock` is a `threading.Lock`, useless across Celery worker processes.

---

# Phase R1 — P0 emergency fixes (1 working day, 9 PRs)

These are the bugs that turn "the demo works" into "the security and correctness story does not hold up." **None is hard. Four are single-line changes.** All target the `main` branch directly because the architecture-level merge plan in `VERIDOC_MASTER_PLAN.md` is unaffected.

Each PR has: a one-line fix description, the file:line surface, the new test(s) it lands with, the verification command, and the rollback story.

## R1.1 — `set_status` spread clobber [Agent A P0-1, verified]

**Files.** `src/agents/extractor_pass1.py:181`, `src/agents/extractor_pass2.py:222`.

**Fix.** Replace
```python
**set_status(state, ExtractionStatus.EXTRACTING),
```
with
```python
"status": ExtractionStatus.EXTRACTING.value,
```
in both files. Two-line diff total.

**New tests.**
- `tests/integration/test_pass_handoff_to_reconciler.py` — wire `ExtractorPass1Agent` and `ExtractorPass2Agent` through the orchestrator's `_reconcile_state` closure with mocked VLM responses; assert that **both** `pass1_result` and `pass2_result` arrive at the reconciler non-empty.
- `tests/unit/test_extractor_pass_agents.py` — extend existing test: assert that after `_run` returns, `state["pass1_result"]` (and `pass2_result`) equals the agent-computed payload (not the pre-call value).

**Gate.** `pytest tests/integration/test_pass_handoff_to_reconciler.py tests/unit/test_extractor_pass_agents.py -v`.

**Rollback.** Single revert. The previous behaviour was broken anyway, so rollback restores the original silent-loss bug — no downstream regression.

**Why this is P0.** The "dual-VLM" architecture is silently single-VLM in shipping code. Every dual-VLM extraction handed the reconciler `{}` from at least one pass.

## R1.2 — Auth middleware writes `user_claims` + JWT carries `tenant_id` [Agent C P0-1, verified]

**Fix surface is wider than the review caught.** TokenPayload and User both lack `tenant_id`. Full fix:

1. **`src/security/rbac.py`** — add `tenant_id: str = "default"` to `User` (line 173) and to `TokenPayload` (line 258). Add it to `TokenPayload.to_dict` and `from_dict` (lines 270-300). Add it to `TokenManager.create_access_token` so issuance reads `user.tenant_id` and embeds it as a JWT claim. Backwards-compatible: missing claim → `"default"`.
2. **`src/api/middleware.py`** — after line 644, add `request.state.user_claims = payload.to_dict()` and `request.state.tenant_id = payload.tenant_id`.
3. **`src/api/tenant_middleware.py`** — no change needed; the existing read at line 93 will now resolve.

**New tests.**
- `tests/unit/test_token_payload_tenant.py` — round-trip TokenPayload with tenant_id; assert default.
- `tests/integration/test_tenant_middleware_jwt.py` — issue token for `user.tenant_id = "acme"`, hit a protected route, assert `request.state.tenant_id == "acme"`.
- `tests/integration/test_tenant_isolation_e2e.py` — two simultaneous extractions with different tenant ids; assert FAISS / audit / rate-limit buckets show zero cross-tenant data.

**Gate.** `pytest tests/unit/test_token_payload_tenant.py tests/integration/test_tenant_middleware_jwt.py tests/integration/test_tenant_isolation_e2e.py -v`.

**Backwards compat.** Existing tokens (without `tenant_id` claim) decode to `"default"` via `data.get("tenant_id", "default")` in `from_dict`. No forced re-login.

**Why this is P0.** Multi-tenant isolation is theatre as-is — every authenticated user collapses onto the default tenant regardless of JWT.

## R1.3 — `DEV_AUTO_LOGIN` env-gated + production refusal [Agent F P0-1, verified]

**Files.**
- `frontend/src/components/auth/ProtectedRoute.tsx:9` — change to:
  ```ts
  const DEV_AUTO_LOGIN =
    process.env.NEXT_PUBLIC_DEV_AUTO_LOGIN === 'true' &&
    process.env.NODE_ENV !== 'production';
  ```
- `frontend/next.config.js` — add a top-level assertion:
  ```js
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.NEXT_PUBLIC_DEV_AUTO_LOGIN === 'true'
  ) {
    throw new Error(
      'DEV_AUTO_LOGIN cannot be true in production builds. Unset NEXT_PUBLIC_DEV_AUTO_LOGIN.'
    );
  }
  ```
- `.github/workflows/ci.yml` — add a grep gate: `if grep -RInE "const DEV_AUTO_LOGIN = true" frontend/src; then exit 1; fi`.

**New tests.** `frontend/src/__tests__/protected-route-dev-flag.test.tsx` — mock `process.env`, render ProtectedRoute in `production` env with the flag, assert the auth gate fires.

**Gate.**
- `cd frontend && NODE_ENV=production NEXT_PUBLIC_DEV_AUTO_LOGIN=true npm run build` should fail with the new error.
- `cd frontend && npm test -- protected-route-dev-flag`.

**Why this is P0.** Every `next build` today compiles an auth bypass on. Anyone navigating directly to `/dashboard` skips auth.

## R1.4 — CI uses `vitest`, not `jest` [Agent F P1-1, verified]

**File.** `.github/workflows/ci.yml:143`.

**Fix.**
```diff
- run: npx jest --passWithNoTests
- continue-on-error: true
+ run: npm test
```

(`package.json` already has `"test": "vitest run"`.)

**New tests.** None — this PR makes the existing two tests (`login.test.tsx`, `source-view.test.tsx`) actually run.

**Gate.** Push to a feature branch, watch the CI job. Expect to see both tests reported. If they fail (likely — they've never run), this PR also fixes their immediate failures.

**Risk.** Tests may fail when finally executed; landing this in the same PR as the dev-flag PR helps because R1.3 adds the third test.

**Why this is P0.** The frontend CI signal is currently meaningless.

## R1.5 — DLQ `isolation_level="DEFERRED"` [Agent E P0-2, verified]

**File.** `src/queue/webhook_dlq.py:245`.

**Fix.**
```diff
- conn = sqlite3.connect(self._db_path, isolation_level=None, check_same_thread=False)
+ conn = sqlite3.connect(self._db_path, isolation_level="DEFERRED", check_same_thread=False)
```

Plus: confirm every multi-statement code path (`reschedule_failed_attempt`, `detect_poison_subscription`, the upsert in `enqueue_failed`) ends with `conn.commit()`. The existing calls become real after this change.

**New tests.**
- `tests/integration/test_dlq_concurrent_reschedule.py` — spawn two `multiprocessing.Process` workers that both call `reschedule_failed_attempt` on the same entry; assert the final `attempts` count equals the sum of bumps (not 1).
- `tests/unit/test_webhook_dlq.py` — add an isolation-level assertion: open `_connect()`, run `conn.isolation_level`, expect `"DEFERRED"`.

**Gate.** `pytest tests/integration/test_dlq_concurrent_reschedule.py tests/unit/test_webhook_dlq.py -v`.

**Rollback.** Single revert. The autocommit behaviour is the current production behaviour; reverting restores it.

**Why this is P0.** Multi-statement DLQ operations are non-atomic across Celery workers. Phase 8.5-C2 claimed to fix this; the actual merge did not change the line.

## R1.6 — `/queue/{queue_name}/purge` requires `SYSTEM_ADMIN` [Agent C P0-5, verified]

**File.** `src/api/routes/queue.py:174`.

**Fix.**
```diff
- async def purge_queue(queue_name: str):
+ async def purge_queue(
+     queue_name: str,
+     _: None = Depends(require_permission(Permission.SYSTEM_ADMIN)),
+ ):
```

(Add the `from fastapi import Depends` and `from src.api.middleware import require_permission` and `from src.security.rbac import Permission` imports.)

**New tests.**
- `tests/security/test_queue_purge_auth.py` — call with a viewer JWT → 403; with admin JWT → 200.

**Gate.** `pytest tests/security/test_queue_purge_auth.py -v`.

**Why this is P0.** Any viewer DOSes Celery with one POST.

## R1.7 — Webhook routes require `API_WEBHOOK` permission [Agent C P0-4, verified]

**Files.** Every route handler in `src/api/routes/webhooks.py` (8 handlers, lines 96-261).

**Fix.** Add `_: None = Depends(require_permission(Permission.API_WEBHOOK))` to each handler. Once R1.2 has landed, also scope every store query by `request.state.tenant_id`.

**New tests.**
- `tests/security/test_webhook_route_auth.py` — viewer JWT on each of the 8 endpoints → 403. Admin/operator JWT → 200/204.
- `tests/integration/test_webhook_tenant_scoping.py` (after R1.2 lands) — subscribe as tenant A, query as tenant B → empty.

**Gate.** `pytest tests/security/test_webhook_route_auth.py -v`.

**Dependency.** Tenant-scoping piece depends on R1.2. The auth-gate piece can ship first.

**Why this is P0.** Combined with R1.8 (SSRF), any viewer can register an attacker URL and exfiltrate document content via webhook delivery.

## R1.8 — SSRF: reject IPv6-mapped IPv4 + 6to4 + Teredo [Agent C P0-3 / Agent E P0-4, verified]

**File.** `src/queue/_url_safety.py:64-86`.

**Fix.** In `_is_private_or_unsafe`, after the existing checks, add:
```python
if isinstance(addr, ipaddress.IPv6Address):
    # Unwrap IPv4-mapped (::ffff:0:0/96) and re-check.
    if addr.ipv4_mapped is not None:
        inner_unsafe, inner_reason = _is_private_or_unsafe(addr.ipv4_mapped)
        if inner_unsafe:
            return True, f"ipv6_mapped_{inner_reason}"
    # 6to4 (2002::/16) — extract the embedded IPv4 and re-check.
    if addr in ipaddress.ip_network("2002::/16"):
        try:
            inner = ipaddress.IPv4Address(int(addr) >> 80 & 0xFFFFFFFF)
            inner_unsafe, inner_reason = _is_private_or_unsafe(inner)
            if inner_unsafe:
                return True, f"6to4_{inner_reason}"
        except (ValueError, OverflowError):
            pass
    # Teredo (2001::/32) — block entirely; tunnels arbitrary IPv4.
    if addr in ipaddress.ip_network("2001::/32"):
        return True, "teredo"
```

**New tests.**
- `tests/security/test_ssrf_ipv6_mapped.py` — parametrised:
  - `::ffff:127.0.0.1` → rejected (`ipv6_mapped_loopback`)
  - `::ffff:169.254.169.254` → rejected (`ipv6_mapped_link_local`)
  - `::ffff:10.0.0.1` → rejected (`ipv6_mapped_private`)
  - `2002:7f00:0001::` (6to4 wrapping 127.0.0.1) → rejected
  - `2001::1` (Teredo) → rejected
  - `::ffff:8.8.8.8` → allowed (public IPv4)

**Gate.** `pytest tests/security/test_ssrf_ipv6_mapped.py -v`.

**Why this is P0.** Bypasses the SSRF gate on Python ≤ 3.10 entirely; version-fragile on 3.12.

## R1.9 — Smoke verification + dependency-aware merge order

After all 8 fixes land independently:

1. Full pytest baseline: `pytest tests/ -m "not slow"` → expect **≥ 2853 + ~25 net new = ~2878 passing**, 11 pre-existing skips.
2. `cd frontend && npm test` → expect 3 tests passing (login + source-view + new dev-flag).
3. `cd frontend && npx tsc --noEmit` → exit 0.
4. CI: full green on the next push (lint, both test matrix entries, frontend).
5. Manual smoke: log in, upload a CMS-1500 in healthcare mode, verify the FHIR Bundle contains all extracted fields (this is the regression test for R1.1).

**Merge order constraint.** R1.7's tenant-scoping piece depends on R1.2. Otherwise the 8 PRs are independent and can land in any order.

### STOP — confirm with user before executing Phase R1.

---

# Phase R2 — P1 hardening (this sprint, ~10 PRs)

P1s grouped by file family to minimise reviewer churn. Each PR is its own surface but small enough to review in 10 minutes.

## R2.1 — `_previous_ece` persistence [Agent D P0-1, downgraded to P1]

**File.** `src/validation/calibration.py:582,658,713`.

**Fix.** Add `_load_ece_history()` (reads `<storage_dir>/_ece_history.json` at `__init__`) and `_save_ece_history()` (atomically writes after each successful fit). Persist `(profile, tenant_id) → ece` shape.

**Tests.** `tests/integration/test_calibration_ece_persistence.py` — instantiate, fit, dispose, re-instantiate, attempt a regressed fit → assert gate fires.

## R2.2 — `DualPassComparator` single-pass exclusion [Agent D P0-2]

**File.** `src/validation/dual_pass.py:580-586`.

**Fix.** Add a `SINGLE_PASS_ONLY` category that's excluded from `agreement_results` and the denominator of `overall_agreement_rate`.

**Tests.** Extend `tests/unit/test_dual_pass.py` — 5-field record with 2 fields legitimately only in pass1 → agreement rate computed on the 3 shared fields, not 5.

## R2.3 — `_to_float` accounting-negative `(1000.00)` [Agent D P0-4]

**File.** `src/validation/cross_field.py:897-900`.

**Fix.** Lift the parentheses-to-negative transform from `dual_pass._extract_number` into a shared helper `src/utils/currency.py::parse_currency(text) -> float | None`. Both call sites use it.

**Tests.** Extend `tests/unit/test_cross_field.py` — sum rule on an EOB with `(125.00)` adjustment → fires correctly.

## R2.4 — Schema-builder text sanitisation [Agent D P0-5]

**Files.** `src/schemas/schema_builder.py` + new `src/schemas/_sanitize.py`.

**Fix.** Add `_sanitize_schema_text(text: str) -> str` that strips newlines, angle brackets, backticks, control chars; cap at 500 chars. Apply in `FieldBuilder.display_name / description / examples` setters and in `generate_zero_shot_schema`.

**Tests.** `tests/unit/test_schema_text_sanitizer.py` — adversarial inputs neutralised.

## R2.5 — Async error-handler ordering + `LM_MIN_MAX_TOKENS` floor + `constrained_decode_async` parity [Agent B P0-1, P1-2, P1-3]

**Files.** `src/client/lm_client.py:831-834`, `:797-801`, `src/client/constrained.py:236`.

**Fix.**
1. Swap `APIConnectionError` / `APITimeoutError` order on the async path.
2. Extract `_apply_min_max_tokens_floor(req)` helper; call from both sync `_send_single_request` and async `send_vision_request_async`.
3. In `constrained_decode_async`, replace `schema_enforced=False` with the same `bool(schema is not None and backend.capabilities().supports_constrained_decoding)` expression the sync path uses.

**Tests.**
- `tests/unit/test_lm_client_async.py::test_timeout_classified_correctly` — mock `APITimeoutError` raised during async call → assert `LMTimeoutError`, not `LMConnectionError`.
- `tests/unit/test_lm_client_async.py::test_min_max_tokens_floor_async` — `LM_MIN_MAX_TOKENS=8192`, request with `max_tokens=512` → backend sees 8192.
- `tests/unit/test_constrained_decode.py::test_async_schema_enforced_flag` — assert `DecodingTrace.schema_enforced` is True when the backend supports it.

## R2.6 — `_repair_json` URL preservation [Agent B P1-1]

**File.** `src/client/lm_client.py:707-708`.

**Fix.** Replace the negative-lookbehind regex with a tokeniser that walks the text, skips runs inside quoted strings, and only strips `//...` to end-of-line outside them. Add `_repair_json_strip_line_comments(text)` as a separate helper for testability.

**Tests.** `tests/unit/test_lm_client_repair.py::test_https_url_in_string_value_preserved` — `{"url": "https://api.example.com/v1"}` round-trips unchanged.

## R2.7 — Gemma `tool_calls` plumbing [Agent B P1-5]

**Files.** `src/client/lm_client.py:_send_single_request`, `src/client/backends/gemma_backend.py:parse_tool_calls`.

**Fix.** In `_send_single_request`, after building `VisionResponse`, also set `vision_response.usage["tool_calls"] = response.choices[0].message.tool_calls or []` (serialised to dicts). The structured path in `parse_tool_calls` then becomes the primary path.

**Tests.** `tests/unit/test_gemma_tool_calls.py::test_structured_path_populated` — mock OpenAI response with `tool_calls` set, assert `parse_tool_calls` returns the structured shape (not regex fallback).

## R2.8 — Production boot guard covers `STAGING` [Agent B P0-3]

**File.** `src/config/settings.py:1401`.

**Fix.**
```python
if self.app_env in (Environment.PRODUCTION, Environment.STAGING):
```
Document the change in a release-notes line so operators of existing staging deploys know to set `AUTH_BYPASS_ACK=1` if they were using the old behaviour intentionally.

**Tests.** `tests/unit/test_settings_validator.py::test_staging_refuses_auth_off_without_ack` — set `app_env=staging`, `auth_enabled=False`, no ack → raises.

## R2.9 — State-key drift: declare `validation_*` in `ExtractionState` [Agent A P0-2]

**File.** `src/pipeline/state.py` (TypedDict at ~line 380).

**Fix.** Add three fields:
```python
validation_is_valid: bool
validation_requires_retry: bool
validation_requires_human_review: bool
```

**Tests.** `tests/integration/test_state_checkpoint_validation_keys.py` — round-trip a state through LangGraph's SQLite checkpointer → assert keys survive.

## R2.10 — Critic prompt injection guard [Agent A P0-3]

**File.** `src/prompts/critic.py:171`.

**Fix.** Before `json.dumps(extraction, ...)`, walk every string value and:
1. Truncate at 500 chars.
2. Replace runs of 3+ backticks with `[BACKTICK_RUN]`.
3. Strip lines starting with "ignore" / "system:" / "you are" via a configurable blacklist (logged as warnings).

**Tests.** `tests/security/test_critic_prompt_injection.py` — extraction containing ` ``` ` and "Ignore all previous instructions" → sanitised value reaches the prompt; original is logged.

## R2.11 — Batch / reprocess task pass overrides [Agent E P0-6, P1-1]

**Files.** `src/queue/tasks.py:631-640,676-684,861-865`.

**Fix.**
1. Add `profile_override: str | None = None, modality_override: list[str] | None = None` to `batch_process_task` signature.
2. Forward to every `process_document_task.s(...)` call.
3. Same fix to `reprocess_failed_task`.

**Tests.** `tests/unit/test_batch_task_overrides.py` — patch `process_document_task.s`, call `batch_process_task(..., profile_override="medical-rcm")`, assert child signature carries the kwarg.

## R2.12 — Markdown + Excel PHI mask consistency [Agent E P0-7]

**Files.** `src/export/markdown_exporter.py:761-772`, `src/export/excel_exporter.py:1016`.

**Fix.** Both masker methods return `self.config.phi_mask_pattern` directly (matching the JSON exporter at `:694`). No partial-reveal.

**Tests.** `tests/unit/test_phi_mask_exporters.py` — assert all three exporters produce identical mask shape on identical input.

### STOP — confirm with user before executing Phase R2.

---

# Phase R3 — Polish + remaining P1s (sprint after, ~6 PRs)

These are lower-impact P1s plus the most useful P2s. Each is a single-file change.

| PR | Fix | Files |
|---|---|---|
| R3.1 | JWT issuer + audience claims | `src/security/rbac.py:447-462,530` |
| R3.2 | Audit chain verifier bridges rotation gaps | `src/security/audit.py:1568-1677` |
| R3.3 | `_mask_metadata` walks list-typed values | `src/security/audit.py:848-871` |
| R3.4 | PHI regex coverage (SSN-without-dash, international phone, DEA/NPI, EU date, IPv6) | `src/security/audit.py:213-238` |
| R3.5 | `revoke_api_key` admin perm string fix | `src/api/routes/auth.py:1093-1095` |
| R3.6 | Phoenix `start_span` propagates exception info | `src/monitoring/observability.py:353-367` |
| R3.7 | `VectorStoreManager.for_tenant` allowlist regex | `src/memory/vector_store.py:108` |
| R3.8 | Frontend bbox-overlay letterbox math | `frontend/src/components/document/PdfPageCanvas.tsx:53-93` |
| R3.9 | Frontend `Bearer` token same-origin assertion | `frontend/src/components/document/AuthenticatedImage.tsx:42-44`, `frontend/src/lib/api.ts:473` |
| R3.10 | `SourceViewTab` distinguishes 404 from infra error | `frontend/src/components/document/SourceViewTab.tsx:94-96` |

Each PR ships with a targeted unit test and a one-line gate.

### STOP — confirm with user before executing Phase R3.

---

# Phase R4 — Cleanup + the long-standing CI gate flip (background, 2-3 PRs)

| PR | Fix | Surface |
|---|---|---|
| R4.1 | Ruff 245-issue cleanup (mostly mechanical) | repo-wide |
| R4.2 | Mypy `# type:` comment in `metrics.py:177` + flip `\|\| true` off | `src/monitoring/metrics.py`, `.github/workflows/ci.yml` |
| R4.3 | DLQ poison-detect TOCTOU narrowing (add `BEGIN IMMEDIATE` around the check-and-disable) | `src/queue/webhook_dlq.py:422-507` |
| R4.4 | `rcm_signing.backend == "unconfigured"` prod-boot guard | `src/config/settings.py` (model_validator) |
| R4.5 | Frontend `tsconfig.json` includes `__tests__/` | `frontend/tsconfig.json:32` |

Each gated by `pytest tests/ -m "not slow"` staying at the expected count and the CI suite turning green with the `\|\| true` removed.

### STOP — confirm with user before executing Phase R4.

---

# Verification end-state

After all four phases land:

1. **Pytest baseline:** 2853 + ~50 net new = **~2900 passing**, 11 pre-existing skips.
2. **Frontend:** `npm test` runs 3+ tests green; `tsc --noEmit` exit 0; CI runs vitest, not jest.
3. **CI:** ruff and mypy block (no `\|\| true`); the lint job is real signal again.
4. **Tenant isolation:** end-to-end e2e test asserts zero cross-tenant data leakage across FAISS, audit, calibration, rate-limit.
5. **Pen-test surface:** the 3 first-afternoon findings from the review (`/queue/purge` open, webhooks open, tenant theatre) are all closed.
6. **HIPAA mask consistency:** all 3 exporters mask identically.
7. **SSRF:** parametrised test against IPv6-mapped, 6to4, Teredo, and direct IPv4 all behave consistently across Python 3.11 / 3.12.
8. **Calibration:** ECE gate survives process restart.

---

# Risks & explicit decisions

| Risk / decision | Position |
|---|---|
| TokenPayload schema change is a JWT-encoding change | Backwards-compatible: missing `tenant_id` claim decodes to `"default"`. No forced re-login. |
| `DualPassComparator` agreement-rate denominator change shifts retry/review thresholds | Land behind a `DUAL_PASS_LEGACY_AGREEMENT_RATE=1` env var for one release. Default new behaviour. |
| Webhook route auth-gate flip will 403 any existing client without the right perm | Document in release notes; the previous behaviour was a security hole, not a feature. |
| DLQ `DEFERRED` isolation may slow throughput under contention | SQLite `DEFERRED` only acquires a write lock at the first `INSERT`/`UPDATE`. Throughput impact is negligible for the DLQ workload (low write rate). |
| `_repair_json` URL fix could regress on a different real-world input | New test plus the existing comment-stripping tests give us a regression net. If a fresh artefact breaks, log the input and add a parametrised case. |
| Frontend test suite was never green; turning it on may surface real failures | R1.4 ships in the same commit as R1.3, so the new dev-flag test makes 3-of-3 the success bar. If a pre-existing test fails on CI but passes locally, that's a CI-environment fix, not a test fix. |
| `STAGING` boot guard tightening breaks existing staging deploys | Document `AUTH_BYPASS_ACK=1` escape; mirrors the production pattern. |
| The 245-issue ruff cleanup is a big PR | Split by rule code (`UP`, `F`, `B`, etc.) into 4-5 child PRs. Avoid mixing auto-fix and manual fix in the same PR. |

---

# Working assumptions (flag if wrong)

1. **No commits without explicit approval at each STOP boundary.** Plan is the contract; user is the gate.
2. **`main` is the integration branch.** All R1 PRs target it.
3. **The 8 R1 fixes can ship today.** None requires a roadmap conversation or stakeholder buy-in.
4. **R2-R4 land over the next ~2 weeks** based on reviewer bandwidth.
5. **No new features in this plan.** R1-R4 is integrity work only. Phase 9 (Bedrock pivot) is unaffected and resumes after R2.
6. **Test counts are estimates** — the actual delta depends on how many edge cases each new test parametrises.
7. **The `set_status` spread bug exists in the current `main` and has shipped in every Phase 5+ release.** The fix is small; the regression discovery is the genuinely embarrassing part.

---

# Done definition for Phase R1 (the gate the user is approving today)

- All 9 R1 PRs reviewed, merged to `main`, CI green on each.
- Test baseline ≥ 2878 passing.
- `frontend/ npm test` exit 0 with ≥ 3 tests.
- Manual smoke: 5-minute walkthrough — login → upload `data/demo/cms1500_faxed.pdf --mode healthcare` → assert FHIR Bundle has all expected fields → verify the `tenant_id` claim flows from JWT to per-tenant FAISS bucket.
- The 3 first-afternoon pen-test findings from the review are confirmed closed (purge requires admin, webhook requires API_WEBHOOK perm, JWT tenant id wins over default).

Once R1 is done, propose R2 for approval. Same gate pattern.

### STOP — this plan is now ready for review. Awaiting approval to execute Phase R1.
