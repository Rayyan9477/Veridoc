---
title: Veridoc — Consolidated codebase review
audience: maintainers
last_verified: 2026-05-22
reviewers: 6 parallel review agents across src/, frontend/, tests/, .github/
---

# Veridoc — Consolidated codebase review

> **Read-only review. No code changed.** Six parallel agents covered every directory under `src/`, the full `frontend/` tree, and `.github/workflows/ci.yml`. Four of the highest-impact P0 claims were spot-verified by direct file reads before inclusion in this report.
>
> **Status of the codebase:** 2853 tests pass locally, but several of the most important guarantees the system claims to ship are silently broken at runtime. Some claims that landed in Phase 8 and 8.5 do not match the code that actually merged.

## TL;DR — what a production launch must fix this week

| # | Finding | Surface | Verified |
|---|---|---|---|
| 1 | **Dual-VLM extraction silently writes stale state** — `**set_status(...)` spread in pass1/pass2 clobbers `pass1_result` / `pass2_result` | `src/agents/extractor_pass1.py:181`, `extractor_pass2.py:222` | **yes** |
| 2 | **Auth middleware never populates `user_claims`** → JWT-based tenant resolution is dead code; every user collapses onto the default tenant | `src/api/middleware.py:641-644` vs `src/api/tenant_middleware.py:93` | **yes** |
| 3 | **Frontend `DEV_AUTO_LOGIN = true`** is a hardcoded literal with no build-time guard; production builds compile auth bypass on | `frontend/src/components/auth/ProtectedRoute.tsx:9` | **yes** |
| 4 | **CI invokes `npx jest`, project ships `vitest`** with `continue-on-error: true` — frontend test suite never runs | `.github/workflows/ci.yml:143` | **yes** |
| 5 | **SQLite DLQ uses autocommit** (`isolation_level=None`); every explicit `conn.commit()` is a no-op; multi-statement ops are non-atomic | `src/queue/webhook_dlq.py:245` | **yes** |
| 6 | **`/queue/{queue_name}/purge`** has no permission check — any authenticated viewer can purge Celery | `src/api/routes/queue.py:174` | reported |
| 7 | **Webhook routes have no auth gate** — anyone can register an SSRF subscription URL | `src/api/routes/webhooks.py:95` | reported |
| 8 | **SSRF `_url_safety.py` accepts IPv6-mapped IPv4 loopback / metadata** (`::ffff:127.0.0.1`, `::ffff:169.254.169.254`) | `src/queue/_url_safety.py:64-86` | reported |

These eight together turn "the demo works" into "the security and correctness story does not hold up to a 30-minute pen-test."

---

## Process

Six review agents ran in parallel, each owning a non-overlapping slice:

| Agent | Scope | Tool |
|---|---|---|
| **A** | `src/agents/` · `src/pipeline/` · `src/extraction/` · `src/prompts/` | bug-analyzer-reproducer |
| **B** | `src/client/` (+ `backends/`) · `src/config/` | bug-analyzer-reproducer |
| **C** | `src/api/` (+ `routes/`) · `src/security/` | security-vulnerability-scanner |
| **D** | `src/validation/` · `src/schemas/` · `src/profiles/` · `src/memory/` · `src/preprocessing/` | bug-analyzer-reproducer |
| **E** | `src/export/` · `src/queue/` · `src/monitoring/` · `src/utils/` · `src/storage/` · `main.py` | bug-analyzer-reproducer |
| **F** | `frontend/` · `tests/` layout · `.github/workflows/ci.yml` | feature-dev:code-reviewer |

Each agent produced a P0/P1/P2/P3 ranked list with `path:line` citations. Two agents self-corrected findings on closer reading — a positive signal on report quality. Four highest-impact P0s were re-verified by direct file reads.

---

## P0 — fix before any new production deploy

### 1. `**set_status(...)` spread clobbers Pass 1 / Pass 2 results

**Where.** `src/agents/extractor_pass1.py:181` and `src/agents/extractor_pass2.py:222`.

```python
return update_state(state, {
    "pass1_result": pass1_result,
    "pass1_model_id": model_id_seen,
    ...
    **set_status(state, ExtractionStatus.EXTRACTING),   # <- clobbers everything above
})
```

`set_status` (`src/pipeline/state.py:716-725`) returns the **full** `ExtractionState`, not just the status fragment. Spreading it into the updates dict places every state key (including the **old** values of `pass1_result` / `pass2_result`) into the same dict — and Python dict literals resolve duplicate keys with the **later** entry winning. The freshly-extracted Pass 1 / Pass 2 results are silently overwritten with whatever was in state before the agent ran (typically `{}`).

**Net effect.** Every dual-VLM extraction passes `{}` to the reconciler from at least one pass — likely both — and the reconciler then treats every field as `single_pass` (or absent), making the pipeline behave as if Pass 2 doesn't exist. The "dual-VLM" narrative is silently single-VLM in shipping code.

**Fix.** Replace `**set_status(state, ExtractionStatus.EXTRACTING)` with `"status": ExtractionStatus.EXTRACTING.value` in both agents.

**Test gap.** `tests/unit/test_extractor_pass_agents.py` mocks `update_state` — that masks the spread bug. An integration test that wires both extractors through the reconciler would have caught it.

### 2. Auth middleware never sets `user_claims` — tenant isolation is theatre

**Where.** `src/api/middleware.py:641-644` writes `user_id`, `username`, `roles`, `permissions` to `request.state` only. `src/api/tenant_middleware.py:93` then reads `request.state.user_claims['tenant_id']` — always `None`. The JWT-tenant branch is dead; admin-only header override becomes the only non-default-tenant path; non-admin requests collapse onto `settings.api.default_tenant_id` regardless of which tenant issued the JWT.

**Fix.** In `AuthenticationMiddleware._authenticate` (or its caller at line 640), add `request.state.user_claims = payload.model_dump()`.

**Downstream impact.** Per-tenant FAISS isolation, per-tenant rate-limit buckets, per-tenant calibration tables, per-tenant audit logs — all collapse onto a single tenant because the upstream resolver never sees the JWT claim.

### 3. Frontend auth bypass compiled into production

**Where.** `frontend/src/components/auth/ProtectedRoute.tsx:9`:

```ts
const DEV_AUTO_LOGIN = true;
```

No `process.env.NODE_ENV` gate, no build-time assertion, no `.env.local` lookup. Every production `next build` ships with this literal `true`. Anyone navigating directly to `/dashboard`, `/documents/...`, `/tasks`, or `/settings` bypasses the auth check entirely.

**Fix.** Change to `const DEV_AUTO_LOGIN = process.env.NEXT_PUBLIC_DEV_AUTO_LOGIN === 'true';`, add an assertion in `next.config.js` that throws when both `NODE_ENV === 'production'` and the env var is `"true"`.

### 4. CI's frontend test step doesn't run any tests

**Where.** `.github/workflows/ci.yml:143`:

```yaml
run: npx jest --passWithNoTests
continue-on-error: true
```

`frontend/package.json` ships `vitest`, not `jest`. `npx jest --passWithNoTests` either downloads an ad-hoc jest with no config (exit 0) or fails-and-is-masked by `continue-on-error: true`. Either way the vitest test files (`login.test.tsx`, `source-view.test.tsx`) never execute. The green CI badge on the frontend job is meaningless.

**Fix.** Change to `npx vitest run`. Remove `continue-on-error: true`.

### 5. Webhook DLQ runs in SQLite autocommit mode

**Where.** `src/queue/webhook_dlq.py:245`:

```python
conn = sqlite3.connect(self._db_path, isolation_level=None, check_same_thread=False)
```

`isolation_level=None` is autocommit; every statement commits immediately. The explicit `conn.commit()` calls elsewhere in the module are no-ops. `reschedule_failed_attempt` (read row → compute next retry → write row) is two independent transactions. Two concurrent workers can both read the same row, both compute the next retry, both write — last-writer-wins on `attempts` count.

**Fix.** Pass `isolation_level="DEFERRED"`. The `commit()` calls already in the module become real.

This was scheduled in the master plan as Phase 8.5-C2 and the merge note implied it landed; the actual code never changed.

### 6. `/queue/{queue_name}/purge` is wide open

**Where.** `src/api/routes/queue.py:174`. Any authenticated user, including `VIEWER` role, can purge a Celery queue. One POST request kills every in-flight extraction.

**Fix.** `Depends(require_permission(Permission.SYSTEM_ADMIN))` on the route.

### 7. Webhook routes have no auth + no ownership scoping

**Where.** `src/api/routes/webhooks.py:95-262`. Subscribe, update, delete, DLQ-list, force-redeliver — all have no `require_permission` dependency and no per-subscription owner check. Combined with the SSRF gap below, any authenticated viewer can:

- Register an attacker-controlled URL as a subscription. Worker signs deliveries with the global signing secret and POSTs document content (including PHI) to that URL.
- Force-redeliver entries from another tenant's DLQ.
- List all tenants' delivery logs.

**Fix.** Add `Depends(require_permission(Permission.API_WEBHOOK))` on every endpoint, scope every query by `request.state.tenant_id` (requires #2 to land first).

### 8. SSRF: IPv6-mapped IPv4 loopback bypass

**Where.** `src/queue/_url_safety.py:64-86`. Python's `ipaddress.IPv6Address("::ffff:127.0.0.1").is_loopback` returns `False` (the check is `addr == ::1` only). The same is true for `::ffff:169.254.169.254` (AWS metadata) and IPv4-mapped private ranges. On Python 3.10 and below the `is_private` check on the mapped form is also `False`. Result: the SSRF gate accepts metadata IPs via the mapped-IPv6 form on every Python version the project supports.

**Fix.** After the initial `_is_private_or_unsafe` returns clean, check `if isinstance(addr, IPv6Address) and addr.ipv4_mapped is not None`, recurse on the unwrapped IPv4 form, reject if it's private/loopback/link-local/multicast.

---

## P1 — fix this sprint

### Validation & calibration (Agent D)

- **`PartitionedCalibrator._previous_ece` lives only in memory** (`src/validation/calibration.py:582`). Never written to or loaded from disk. Every process restart treats every partition as "first fit" and unconditionally accepts whatever the new fit produces — the ECE regression gate is bypassed.
- **`DualPassComparator` counts single-pass fields as disagreements** (`src/validation/dual_pass.py:580-586`). Documents where Pass 1 and Pass 2 legitimately specialise (e.g. EOB adjustments) get artificially low agreement rates and over-trigger retry / review.
- **`_to_float` doesn't handle accounting-negative `(1000.00)`** (`src/validation/cross_field.py:897-900`). The transform only exists in `dual_pass._extract_number`. Sum reconciliation on EOBs with credit adjustments silently passes when it should fire.
- **`schema_builder.py` has no sanitisation on user-supplied field metadata** (`src/schemas/schema_builder.py:61-89`). `display_name`, `description`, `examples` are stored raw and reach the VLM prompt unsanitised — prompt-injection surface on multi-tenant deployments.

### VLM client & async (Agent B)

- **Async error-handler ordering reversed** (`src/client/lm_client.py:831-834`): `APIConnectionError` caught before `APITimeoutError` (subclass), so async timeouts are silently mis-classified as `LMConnectionError`. The sync path was fixed in Phase 8.5-A7; the async copy was missed.
- **`_repair_json` line-comment regex corrupts `https://` URLs** (`src/client/lm_client.py:707-708`). Negative lookbehind allows `:` immediately before `//`, so URL content gets truncated as a comment.
- **`LM_MIN_MAX_TOKENS` floor missing on async path** (`lm_client.py:797-801`). Sync path honours it; async doesn't. Reasoning-model calls via async exhaust the budget on silent reasoning tokens.
- **`constrained_decode_async` hardcodes `schema_enforced=False`** (`src/client/constrained.py:236`). Sync path computes from `BackendCapabilities`; async always emits `False`. `DecodingTrace` misreports for every async call → `ConfidenceCalibrator` gets a corrupted signal.
- **`parse_tool_calls` structured path is unreachable** (`src/client/backends/gemma_backend.py:301`). `LMStudioClient` never populates `tool_calls` on `VisionResponse.usage`. The regex fallback is always the active path — defeating the "native function-calling" centrepiece on the structured side.
- **Production boot guard doesn't cover `STAGING`** (`src/config/settings.py:1401`). `if self.app_env == Environment.PRODUCTION` skips staging entirely. Staging can ship with `auth_enabled=False` / `phi.enabled=False` and the bypass-ack guards never fire.

### Pipeline & agents (Agent A)

- **`validation_is_valid` / `_requires_retry` / `_requires_human_review` are written/read but absent from `ExtractionState`** (`src/agents/validator.py:887-889` writes; `orchestrator.py:1338-1340` reads). LangGraph won't checkpoint keys absent from the TypedDict schema — recovery-replay sees `True` default and silently auto-accepts low-confidence extractions.
- **Critic `verify_bbox` recommendation is dead code** (`src/agents/orchestrator.py:1320-1334`). The routing table has no `verify_bbox` target; the recommendation is emitted but never acted on. The bbox-verification guarantee the architecture claims is not implemented.
- **`merged_extraction` values concatenated verbatim into Critic prompt** (`src/prompts/critic.py:171`). Adversarial document content can break out of the fenced code block and influence Critic recommendations.
- **`_is_placeholder` false-positive on 3-digit sequential numerics** (`src/agents/reconciler.py:145-149`). Valid medical-code segments like `"123"` may be classified as hallucination placeholders and dropped.
- **Pass 2 failure silently degrades to Pass 1-only with no confidence penalty** (`src/agents/orchestrator.py:1096-1111`). Documented as intentional fallback, but the promised penalty isn't applied.

### Export & ops (Agent E)

- **Markdown + Excel PHI masking partially exposes values** (`src/export/markdown_exporter.py:761-772`, `excel_exporter.py:1016`). Returns `Jo[REDACTED]oe` instead of full mask — HIPAA inference attack surface. JSON masker correctly returns just the pattern.
- **`batch_process_task` doesn't forward `profile_override` / `modality_override`** (`src/queue/tasks.py:676-684`). API-triggered Healthcare-mode batch jobs silently revert to auto-detect for every child task. The CLI batch path was correctly patched; the Celery path was missed.
- **`reprocess_failed_task` drops `profile_override` and `modality_override`** (`src/queue/tasks.py:861-865`). Healthcare-mode reprocessing falls back to auto-detect.
- **Phoenix `start_span` swallows exception info** (`src/monitoring/observability.py:353-367`). The `finally` exits all sinks with `(None, None, None)` regardless of exception state. Failed spans appear green in Phoenix.

### Security (Agent C)

- **`revoke_api_key` admin check uses wrong permission string** (`src/api/routes/auth.py:1093-1095`): `"admin" in permissions`. The Permission enum doesn't expose bare `"admin"` (it's `"system:admin"`). Admins can't manage pre-Phase-8 legacy keys.
- **JWT has no `iss` / `aud` claims** (`src/security/rbac.py:447-462`). Token validation accepts any token signed with the same secret. Cross-service-token-reuse risk if the secret leaks or is shared.
- **Audit chain verifier doesn't bridge rotation gaps** (`src/security/audit.py:1568-1677`). Per-file `previous_hash` walk doesn't link to the previous file's last `event_hash`. Retroactive tampering on rotated logs survives integrity check.
- **`_mask_metadata` skips list-typed values** (`src/security/audit.py:848-871`). `{"recipients": [...]}` lands in audit log unredacted.
- **PHI regex coverage gaps** (`src/security/audit.py:213-238`). Raw 9-digit SSN without dashes, international phone (`+44 ...`), 10-digit DEA/NPI outside `NPI:` context, European date `DD/MM/YYYY`, IPv6 client IPs — all unmasked.

### Frontend (Agent F)

- **Bearer token attached to arbitrary `src` URLs** (`frontend/src/components/document/AuthenticatedImage.tsx:42-44`, `lib/api.ts:473`). No same-origin assertion before attaching the JWT.
- **`tsconfig.json` excludes `__tests__/`** (`frontend/tsconfig.json:32`) — `tsc --noEmit` in CI skips test files. The two test files use `@ts-expect-error` for jsdom gaps that work, but new tests can ship with type errors.
- **Bbox overlay drifts under `object-contain` letterbox** (`frontend/src/components/document/PdfPageCanvas.tsx:53-93`). When aspect ratios mismatch, the SVG overlay covers the full element area but the image renders letterboxed inside it — bbox highlights end up offset from the actual image pixels.
- **`SourceViewTab` collapses network errors into the "feature unavailable" empty state** (`frontend/src/components/document/SourceViewTab.tsx:94-96`). Operators debugging a 500 see a docs link.
- **Modality chips have no ARIA state** (`frontend/src/components/documents/UploadOptions.tsx:253-270`). Multi-select toggles render as plain `<button>` with no `aria-checked`.
- **`handleCompleteReview` is a `console.log` no-op** (`frontend/src/app/documents/[id]/page.tsx:229-237`). The human-review submit button looks active but does nothing; PHI-adjacent data hits devtools.

---

## P2 — maintainability / robustness

- **DLQ poison-detect TOCTOU window** documented but not closed (`src/queue/webhook_dlq.py:422-507`).
- **`rcm_signing.backend == "unconfigured"` boot guard missing** (`src/config/settings.py`). Phase 7 PHI / Phase 8 auth pattern; not applied to RCM signing.
- **Markdown / Excel exporters use inconsistent PHI mask shape** vs JSON exporter — single-source masker would be safer.
- **`VectorStoreManager.for_tenant` blacklists `..` but allows `.` and `"tenants"`** (`src/memory/vector_store.py:108`). A crafted tenant id of `"."` resolves to the parent directory and reads cross-tenant FAISS files. Move to an allowlist regex.
- **Cross-field date parsing doesn't normalise tz-aware vs naive `datetime`** (`src/validation/cross_field.py:872-884`). `TypeError` on comparison silently aborts the rule.
- **`_validate_pos` in `medical_codes.py` hardcodes a 49-code set** that's already JSON-driven in `validators.py`. Two paths can diverge.
- **CORS prod check rejects `http://` but allows literal `"null"` and `"*"`** (`src/api/app.py:196-202`). Combined with `allow_credentials=True`, a `"null"` origin is a credentialed open-door.
- **`RateLimiter` initial-fill grants `burst` + accumulated tokens** in the first window (`src/api/middleware.py:354-357`). First burst is effectively 2× the configured size.
- **`update_state` deep-copies `pass1_result` / `pass2_result` on every call** (`src/pipeline/state.py:675-691`). Large multi-page results pay a per-node copy cost.
- **`consolidated_export.py` duplicates Provenance-sheet logic** from `excel_exporter.py`. Phase 8.5-C10 cleanup incomplete.
- **`tsc --noEmit` is the only real frontend CI gate** — `ruff` and `mypy` both use `|| true`, jest doesn't run. The lint job is decorative.

---

## P3 — nits / fast wins

- `import os as _os` inside hot path `src/client/lm_client.py:574`.
- `_is_weak_secret` substring match (`src/config/settings.py:1382`) false-trips legitimate secrets containing `"test"`.
- `Provenance.frozen=False` despite docstring claim "hashable" (`src/pipeline/provenance.py:105`).
- `BoundingBoxCoords.from_dict` doesn't clamp to `[0,1]` (the `from_normalized` constructor does — `src/pipeline/state.py:88-100`).
- Index-as-key in `Dropdown` (`frontend/src/components/ui/Dropdown.tsx:172,179`).
- `documentsApi.listRecent` is a permanent stub (`frontend/src/lib/api.ts:454-458`).

---

## What a 30-minute pen-test team finds

Top three exploitable findings, in order:

1. **`POST /api/v1/queue/<any>/purge`** with a viewer JWT empties Celery. No permission check. (`src/api/routes/queue.py:174`)
2. **`POST /api/v1/webhooks`** with an attacker URL → SSRF to AWS metadata via IPv4-mapped IPv6. Webhook routes have no auth gate; `_url_safety` accepts the mapped form. (`src/api/routes/webhooks.py:95` + `src/queue/_url_safety.py:64-86`)
3. **Tenant isolation is theatre.** `AuthenticationMiddleware` never populates `user_claims`, so cross-tenant queries against FAISS, audit log, rate-limit buckets all collapse onto the default tenant. (`src/api/middleware.py:641-644`)

---

## Tests — coverage gaps that would have caught these

Every P0 above is invisible to the current 2853-test baseline because:

1. **Pass 1 / Pass 2 set_status clobber** — unit tests mock `update_state`, masking the spread.
2. **Tenant claim propagation** — no integration test asserts that a JWT-issued tenant id reaches `VectorStoreManager.for_tenant(...)`.
3. **`DEV_AUTO_LOGIN` literal** — no `grep`/lint gate, no test that production build refuses the flag.
4. **CI `jest` vs `vitest`** — no test runs in the frontend CI, by design.
5. **DLQ atomicity** — no concurrent-writer test, no isolation-level assertion.
6. **SSRF IPv6-mapped IPv4** — no parametrised test against `::ffff:127.0.0.1` / `::ffff:169.254.169.254`.
7. **Calibration ECE persistence** — no test serialises a calibrator, restarts, refits with regressed data, asserts the gate fires.

---

## Recommended sequence

1. **Today.** Fix the 8 P0s. Small surface, large blast-radius. The `set_status` spread is a 1-line change in 2 files. The CI fix is 1 line. The DLQ isolation is 1 line. The auth-middleware claim propagation is 1 line. The `DEV_AUTO_LOGIN` env-gate is 1 line. The SSRF IPv6-mapped fix is ~6 lines. The two route auth gates are 1 line each.
2. **This sprint.** P1 list — calibration persistence, dual-pass single-pass handling, `_repair_json` URL fix, async error ordering, JWT iss/aud claims, PHI regex coverage, frontend bbox-letterbox math.
3. **Background cleanup.** P2 list as part of the long-standing ruff / mypy cleanup PR.
4. **Add the missing test layer.** Every P0 above has a corresponding test gap. The 2853-test baseline cannot stay green while shipping these bugs — closing the test layer is what prevents the next regression.

The architecture is sound. The Phase 8 and 8.5 designs were correct. The gap is between **design** and **what merged**: several "shipped" items either drifted in implementation or never landed at all. This is fixable — none of the eight P0s is hard, and four of them are single-line changes.
