# ARCHITECTURE.md — Intelligent Document-Extraction Platform

> System design of record. Python 3.11 · LangGraph · FastAPI · Next.js 14. Covers the whole platform plus two locked enhancement pillars — the **Bedrock Model Layer** and **Agent Observability & Self-Healing** — woven into the existing foundation. Every seam cites a real `file:line` so the design is directly actionable. The existing codebase is the foundation; all enhancements are designed *on top of it*, not as a carve-out.

---

## 1. Executive Summary & Product Vision

### 1.1 What the platform is

An agentic, vision-first document-extraction platform that turns unstructured documents (PDF, DOCX, XLSX, images, DICOM, EDI/X12) into validated, provenance-tracked structured data. It is purpose-built for high-stakes domains — medical revenue-cycle management (CMS-1500, UB-04, EOB, superbills), finance (W-2, 1099, bank statements, invoices), and a generic fallback — where *accuracy, traceability, and compliance* matter more than raw throughput.

The processing core is a LangGraph `StateGraph` (`src/agents/orchestrator.py:396`) that streams a single `ExtractionState` TypedDict (`src/pipeline/state.py:380`) through up to 14 named nodes across two parallel tracks (adaptive VLM-first and legacy). The differentiating capability is a **heterogeneous dual-VLM** extraction pattern: a primary vision model extracts (Pass-1), an independent auditor model re-reads with mandatory bounding boxes (Pass-2), a deterministic reconciler fuses the two with a 5-step tiebreaker (`src/agents/reconciler.py:260`), and an optional independent critic scores trust (`src/agents/critic.py:180`). Every field carries provenance (`src/pipeline/provenance.py:66`) surfaced in the UI's Source View.

### 1.2 Product vision and the two pillars

The platform graduates from a developer-operated, locally-hosted system into a **managed, observable, self-healing service** through two durable capability investments:

1. **Bedrock Model Layer (Pillar 1).** Replace local backends (LM Studio / vLLM / Gemma) with a single managed model layer on Amazon Bedrock using one Converse API surface in `us-east-1`. Cross-model dual-VLM: **Qwen3-VL-235B-A22B** (`qwen.qwen3-vl-235b-a22b`) as Pass-1 primary vision, **Amazon Nova Pro** (`amazon.nova-pro-v1:0`, `us.` geo profile) as Pass-2 verification + reconciler arbitration + critic + RCA narration. This removes local GPU operational burden, gives per-tenant token-and-latency attribution from the Converse `usage`/`metrics` blocks, and makes cost a tunable function of confidence-gated Pass-2 plus Nova Pro prompt caching.

2. **Agent Observability & Self-Healing (Pillar 2).** Promote the existing pluggable `ObservabilityDispatcher` (`src/monitoring/observability.py:271`) into a first-class telemetry spine with two correlated planes — an **app plane** (Converse usage/latency/cost spans) and an **infra plane** (Bedrock CloudWatch metrics + model-invocation logs) — exported to **Splunk** (HEC) and an **OpenTelemetry GenAI** exporter. On top sits an agentic **RCA copilot** (Nova Pro generating guarded SPL over a Splunk MCP Server) and an in-app **self-healing policy engine** (failover, quarantine, threshold-raise, ticket-open) that is automatic in dev/staging and human-approved in prod.

### 1.3 Impact

| Dimension | Before | After (target) |
| --- | --- | --- |
| Model operations | Self-hosted GPUs, manual scaling, no SLA | Managed serverless Bedrock; scaling limit is per-model TPM/RPM quota |
| Cost visibility | None per call | Per-tenant token + latency attribution via Converse `usage`/`metrics` + `requestMetadata` |
| Accuracy mechanism | Dual-VLM exists but opt-in (`LEGACY` default) | Cross-model dual-VLM with confidence-gated Pass-2 + critic arbitration |
| Observability | Phoenix + PostHog only; canonical helper is dead code | Splunk + OTel GenAI sinks; two correlated planes; canonical attrs promoted to source-of-truth |
| Incident response | Manual log spelunking | RCA copilot (6-step) + self-healing policy state machine |
| Licensing | AGPL `fitz` vs Proprietary repo (blocker) | `pypdfium2` (Apache/BSD) rasterization; Apache-2.0 public surface |

---

## 2. System Context & C4-Style Container View

### 2.1 System context (L1)

```
                        ┌──────────────────────────────────────────────┐
   Document Submitter   │                                              │
   (API client / UI) ──▶│   Intelligent Document-Extraction Platform   │◀── Reviewer (human-in-loop)
                        │                                              │
   Webhook Subscriber ◀─│   PDF/DOCX/XLSX/IMG/DICOM/EDI  ▶  structured │
                        │   JSON / Excel / Markdown / FHIR / receipt   │
                        └───────┬───────────────┬───────────────┬──────┘
                                │               │               │
                  ┌─────────────▼──┐   ┌────────▼────────┐  ┌───▼──────────┐
                  │ Amazon Bedrock │   │ Splunk (HEC +   │  │ AWS          │
                  │ Converse API   │   │ MCP Server 7931)│  │ CloudWatch   │
                  │ Qwen3-VL +     │   │ index=agent_    │  │ AWS/Bedrock  │
                  │ Nova Pro       │   │ telemetry       │  │ metrics+logs │
                  └────────────────┘   └─────────────────┘  └──────────────┘
```

### 2.2 Container view (L2) — current + target

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                                  PLATFORM (single repo, d:/Repo/PDF)                      │
│                                                                                          │
│  ┌────────────────────┐        ┌──────────────────────────────────────────────────────┐ │
│  │  Next.js 14 SPA     │  HTTP  │  FastAPI app  (src/api/app.py:156)                    │ │
│  │  frontend/          │◀──────▶│  CORS▶SecHdr▶Metrics▶Audit▶RateLimit▶Auth▶Tenant      │ │
│  │  dashboard, source  │ Bearer │  routers: documents, health, dashboard, tasks, queue, │ │
│  │  view, provenance   │        │  schemas, auth, webhooks  (/api/v1)                   │ │
│  └────────────────────┘        └───────────────┬──────────────────────────────────────┘ │
│                                                 │ run_extraction_pipeline (graph.py:14)   │
│  ┌──────────────────────────────────────────────▼─────────────────────────────────────┐ │
│  │  PipelineRunner (runner.py:40)  ──▶  OrchestratorAgent / LangGraph StateGraph        │ │
│  │  PREPROCESS▶SPLIT▶ANALYZE|LAYOUT▶COMPONENTS▶TABLE▶SCHEMA▶EXTRACT                      │ │
│  │     ▶[PASS1▶PASS2▶RECONCILE]▶VALIDATE▶[CRITIC▶COMBINER]▶ROUTE▶COMPLETE|RETRY|REVIEW   │ │
│  └───────┬───────────────────────────────────────────────────────┬─────────────────────┘ │
│          │ send_vision_request (base.py:237)                      │ emit_event/start_span  │
│  ┌───────▼───────────────────────────┐               ┌───────────▼───────────────────────┐│
│  │  Model Client + Backend Layer      │               │  ObservabilityDispatcher           ││
│  │  BaseAgent▶self._client (base.py)  │               │  (observability.py:271)            ││
│  │  ModelRouter (model_router.py)     │               │  sinks: Phoenix, PostHog           ││
│  │  VLMBackend protocol (protocol.py) │               │  + [Splunk HEC] + [OTel GenAI]◀NEW  ││
│  │  factory.get_backend (factory.py)  │               └───────────┬───────────────────────┘│
│  │  LMStudio | vLLM | Gemma           │                           │ infra-plane corr.       │
│  │  + [Bedrock Converse]   ◀── NEW    │                           │ (trace_id+reqMetadata)  │
│  └───────┬────────────────────────────┘                          │                         │
│          │ boto3 bedrock-runtime.converse()                       │                         │
│  ┌───────▼──────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────▼────────────────────┐  │
│  │ Mem0/FAISS memory │  │ Result store  │  │ Webhook DLQ  │  │ Self-Healing PolicyEngine │  │
│  │ memories.json     │  │ data/results/ │  │ dlq.db SQLite│  │ + RCA copilot (Nova Pro)  │◀─NEW
│  │ corrections.json  │  │               │  │ (ticket sink)│  │ over Splunk MCP (guarded) │  │
│  └──────────────────┘  └──────────────┘  └──────────────┘  └───────────────────────────┘  │
│  Checkpoints: MemorySaver | SqliteSaver (.extraction_checkpoints) | Postgres               │
│  Async: Celery + Redis (graceful sync fallback when Redis absent)                          │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Legend: `◀── NEW` = enhancement pillar; everything else exists today.

---

## 3. Current-State Architecture by Layer

### 3.1 Orchestration & Agent Layer

**Responsibilities.** Compile and execute the LangGraph `StateGraph`; route across legacy / VLM-first / dual-VLM / critic topologies; own checkpointing, retry, and human-review interrupt/resume; emit run-boundary telemetry.

**Key interfaces.**
- `OrchestratorAgent.build_workflow(...)` → `StateGraph` — `src/agents/orchestrator.py:396`
- `OrchestratorAgent.run_extraction(initial_state, thread_id)` — `src/agents/orchestrator.py:679`
- `OrchestratorAgent.resume_extraction(thread_id, updated_state, *, human_corrections, ...)` — `src/agents/orchestrator.py:842`
- Conditional edges: `_determine_pipeline` (`:1387`), `_determine_route` (`:1270`), `_determine_retry_target` (`:1362`)
- Factory `create_extraction_workflow(...)` — `src/agents/orchestrator.py:1608`
- Node constants (`NODE_PREPROCESS`, `NODE_EXTRACT_PASS1/2`, `NODE_RECONCILE`, `NODE_CRITIC`, `NODE_CRITIC_COMBINER`, `NODE_ROUTE`) — `src/agents/orchestrator.py:66-99`

**Data flow.** `PipelineRunner.extract_from_pdf` → `create_initial_state` → `run_extraction` → `compiled_workflow.invoke`. `_determine_pipeline` branches on `state.use_adaptive_extraction`; dual-VLM chain `NODE_EXTRACT→PASS1→PASS2→RECONCILE→VALIDATE` is wired at `:576-605`; critic splice `VALIDATE→CRITIC→CRITIC_COMBINER→ROUTE`; route conditional edges at `:608-634`. `_reconcile_state` closure runs the per-page reconciler and dual-writes `merged_extraction` + `merged_extraction_v2` (`:1838-2000`).

**Notable debt.** `CriticAgent` audits only the first page of multi-page docs (`src/agents/critic.py:26-27`); reconciler tiebreaker step 3 (bbox round-trip) silently skips when `backend=None`, the current default (`orchestrator.py:1845`); `MemorySaver` silently substitutes for SQLite when the checkpoint package is absent (`:218-229`).

### 3.2 Model Client + Backend Layer

**Responsibilities.** A three-tier stack: (1) `LMStudioClient` — low-level OpenAI-compat HTTP with tenacity retries and JSON repair; (2) `VLMBackend` protocol — role routing (`PRIMARY/SECONDARY/CRITIC/LITE`); (3) `factory.get_backend()` — process-wide singleton dispatch on `settings.vlm.backend`. `ModelRouter` adds an orthogonal `ModelTask`/`VLMRole` routing axis.

**Key interfaces.**
- `VLMBackend` protocol (`resolve(role)`, `send_vision_request(..., role, schema)`) — `src/client/backends/protocol.py:150`
- `VLMRole` enum — `src/client/backends/protocol.py:39`
- `get_backend(settings)` with if/elif dispatch (`lm_studio|vllm|gemma|raise`) — `src/client/backends/factory.py:35,55-65`
- `BaseAgent.send_vision_request(...)` — `src/agents/base.py:237`; `send_vision_request_with_schema(...)` — `:416`
- `ModelRouter.route_for_agent` / `role_for_agent` / `route_for_role` — `src/client/model_router.py:354,386,401`
- `VisionRequest` (`:72`) / `VisionResponse` (`:186`) — `src/client/lm_client.py`

**Critical seam reality.** `BaseAgent.__init__` hard-codes `self._client = client or LMStudioClient()` (`src/agents/base.py:181`), and `send_vision_request` calls `self._client.send_vision_request(...)` **directly, bypassing the `VLMBackend` protocol**. The `role` kwarg flows only into observability spans. Only `constrained_decode()` (`src/client/constrained.py:118`) routes cleanly through the protocol. `send_vision_request_with_schema` also hard-codes `backend_name='lm_studio'` in its `DecodingTrace` (`base.py:554`). These are the precise points Pillar 1 must reach.

### 3.3 Pipeline + Preprocessing

**Responsibilities.** PDF/file → base64 page images; image enhancement; non-PDF routing; multi-record extraction.

**Key interfaces.**
- `PipelineRunner.extract_from_pdf(...)` — `src/pipeline/runner.py:112`; `extract_from_bytes` — `:186`; `extract_multi_record` — `:785`
- `_load_and_convert_pdf` (`fitz.open`, `get_pixmap`, `tobytes("png")`, `get_text`) — `src/pipeline/runner.py:393-464`; bytes path `:519-592`
- `PDFProcessor.render_page` — `src/preprocessing/pdf_processor.py:466`; unconditional `import fitz` — `:21`
- `ImageEnhancer.enhance` (deskew/denoise/CLAHE/fax-binarize) — `src/preprocessing/image_enhancer.py:195`
- `FileProcessorFactory.process` — `src/preprocessing/file_factory.py:72`

**License blocker.** PyMuPDF (`fitz`) is AGPL-3.0 (`pyproject.toml:60`) while the repo declares Proprietary (`pyproject.toml:10`). Three call sites: `pdf_processor.py:21`, `runner.py:404`, `runner.py:533`. Resolution: swap to `pypdfium2` (Apache-2.0/BSD), and `opencv-python` → `opencv-python-headless` (`pyproject.toml:63`).

### 3.4 Observability + Metrics

**Responsibilities.** Fan out spans/events/LLM-call records to opt-in sinks; serve Prometheus; evaluate alert rules.

**Key interfaces.**
- `ObservabilityDispatcher` (slots dataclass, `sinks: list[_Sink]`) — `src/monitoring/observability.py:271`; `from_settings()` — `:277`
- `emit_event` (`:318`), `start_span` (`:334`), `record_llm_call` (`:372`)
- `build_pass_span_attrs(...)` canonical helper — `src/monitoring/observability.py:436`
- `_Sink` protocol — `:66`; `PhoenixSink` (`:95`), `PostHogSink` (`:206`)
- `MetricsRegistry.get_instance` / `get_metrics` — `src/monitoring/metrics.py:113,518`; `/metrics` — `src/api/routes/health.py:451`
- `AlertManager.fire_alert` / `check_rules` — `src/monitoring/alerts.py:1460,1733`

**Notable debt.** `build_pass_span_attrs` is **dead code** — defined, exported, tested, but no production call-site uses it; each emit builds ad-hoc dicts with inconsistent keys (`model` vs `model_id`). `SPAN_*` constants (`:430-433`) are unreferenced. `AlertManager.check_rules` has no scheduled caller. `PhoenixSink.record_llm_call` is a no-op relying on OpenInference auto-instrumentation that will not fire for a boto3 Bedrock client. There are no Splunk, OTel GenAI, or CloudWatch ingestion paths.

### 3.5 Security + Compliance

**Responsibilities.** Eight-layer HIPAA-oriented stack: JWT HS256 auth, file-persisted revocation, multi-tenant isolation, two-layer PHI redaction, tamper-evident audit hash chain, SSRF-guarded webhooks with SQLite DLQ, route-level RBAC.

**Key interfaces.**
- `RBACManager.validate_access(token, perms, roles)` — `src/security/rbac.py:1194`; tenant_id embedded in claims (`:195-201,265-314`)
- `TenantResolverMiddleware.dispatch` (JWT claim > admin header > default) — `src/api/tenant_middleware.py:76`
- `bind_trace_id` / `trace_scope` (structlog contextvars) — `src/security/audit.py:1434,1497`
- `check_public_url` (IPv4-mapped/6to4/Teredo unwrap) — `src/queue/_url_safety.py:148`
- `WebhookDLQ.enqueue_failed` / `detect_poison_subscription` — `src/queue/webhook_dlq.py:269,437`
- `enforce_mask_phi` (`src/security/phi_mask.py:176`); `PHIRedactor.redact_record` (`src/security/phi_redactor.py:211`)

**Cross-plane hook.** `trace_id` minted in `bind_trace_id` (`audit.py:1434`) is the correlation key that will bridge app-plane spans to infra-plane Bedrock CloudWatch logs in Pillar 2.

### 3.6 API + Frontend

**Responsibilities.** FastAPI factory `create_app()` (`src/api/app.py:156`) with strict middleware ordering (`:204-317`) and eight routers under `/api/v1`. Next.js SPA with React-Query polling and a Source View provenance UI.

**Key interfaces.**
- `process_document(...)` — `src/api/routes/documents.py:186`; `get_document_provenance` — `:1103`; `get_document_page_image` — `:1017`
- `_check_vlm_health()` (probes LM Studio) — `src/api/routes/health.py:110`; `/metrics` — `:451`
- `require_permission(permission)` dependency factory — `src/api/middleware.py:832`
- Frontend `fetchProvenance` — `frontend/src/lib/api/provenance.ts:100`; `SourceViewTab` — `frontend/src/components/document/SourceViewTab.tsx`

**Notable debt.** Dashboard metrics are stubbed zeros (`dashboard.py:67-88`); `GET /documents/{id}` always 404 (`documents.py:878`); `_check_vlm_health` is LM-Studio-specific (replace for Bedrock).

### 3.7 Config + Data Models

**Responsibilities.** Single Pydantic `Settings` root (`src/config/settings.py:1305`) composing 21 nested groups; provenance model; schema/profile/export type systems.

**Key interfaces.**
- `VLMSettings` (`env_prefix=VLM_`) — `src/config/settings.py:267`; `VLMBackendName` (LM_STUDIO/VLLM/GEMMA) — `:65`
- `ObservabilitySettings` (Phoenix+PostHog only) — `:1120`; `ExtractionEngine` (LEGACY/DUAL_VLM) — `:502`
- `Provenance` / `FieldValue[T]` — `src/pipeline/provenance.py:66,263`
- `DocumentType` (16) — `src/schemas/base.py:16`; `ProfileDescriptor` — `src/profiles/descriptor.py:78`

### 3.8 Memory + Stores

**Responsibilities.** Mem0 JSON-backed memory + FAISS/Qdrant vectors; LangGraph checkpoints; Celery/Redis; result store; webhook DLQ.

**Key interfaces.**
- `Mem0Client.add/search` — `src/memory/mem0_client.py:277,330`; `ContextManager.retrieve_context` — `src/memory/context_manager.py:92`
- `OrchestratorAgent._create_checkpointer` — `src/agents/orchestrator.py:186`
- `is_redis_available` — `src/queue/__init__.py:39`; `ResultStore.save` — `src/storage/result_store.py:56`

---

## 4. Pillar 1 — Bedrock Model Layer (Target State, Full)

### 4.1 Design intent

Collapse three local backends into one managed Converse surface, while keeping every existing abstraction intact. The `VLMBackend` protocol and `factory.get_backend()` are open/closed extension points — Bedrock slots in as a fourth backend with **zero core rewrites** to agents. A `FakeBedrockClient` keeps CI fully offline.

### 4.2 Backend abstraction & insertion seams

| Concern | Existing seam (`file:line`) | Change |
| --- | --- | --- |
| Enum value | `VLMBackendName` — `src/config/settings.py:65` | Add `BEDROCK = "bedrock"` |
| Settings group | `VLMSettings` — `src/config/settings.py:267,293-295` | Add `bedrock: BedrockBackendSettings` (`env_prefix=BEDROCK_`): `region="us-east-1"`, model IDs, `prompt_cache_min_tokens=2048`, `nova_geo_profile="us."`, `max_concurrent_requests`, `confidence_gate_threshold`, adaptive-retry knobs |
| Factory branch | `factory.get_backend` — `src/client/backends/factory.py:55-65` | Add `elif backend_name == "bedrock": backend = _build_bedrock_backend(settings)` + builder near `:147` |
| New backend file | (new) `src/client/backends/bedrock_backend.py` | `BedrockVLMBackend(VLMBackend)` using `boto3.client("bedrock-runtime").converse()` |
| Export | `src/client/backends/__init__.py:27-35` | Add `BedrockVLMBackend` to `__all__` |
| Agent client injection | `BaseAgent.__init__` — `src/agents/base.py:181` | Allow a `VLMBackend` to be injected; route `send_vision_request` through `backend.send_vision_request(..., role=role, schema=...)` instead of `self._client` directly — closes the protocol-bypass debt (`base.py:350-358`) |
| Trace correctness | `send_vision_request_with_schema` — `src/agents/base.py:554` | Replace hard-coded `backend_name='lm_studio'` with `backend.name` |
| Capabilities | `BackendCapabilities` — `src/client/backends/protocol.py:68-114` | Bedrock: `supports_logprobs=False`, `supports_constrained_decoding=False`, `supports_dual_vlm=True`, `supports_multi_image=True` |

### 4.3 Cross-model dual-VLM role map

`BedrockVLMBackend.resolve(role)` returns `(region_or_endpoint, model_id)`:

| `VLMRole` | Agent(s) | Model | Model ID | Notes |
| --- | --- | --- | --- | --- |
| `PRIMARY` | `extractor_pass1` (`extractor_pass1.py:47`) | Qwen3-VL-235B-A22B | `qwen.qwen3-vl-235b-a22b` | serverless, In-Region only, 256K ctx, text+image, max output 8K |
| `SECONDARY` | `extractor_pass2` (`extractor_pass2.py:105`) | Nova Pro | `amazon.nova-pro-v1:0` (`us.` geo) | bbox-mandated audit, tool-use, 300K ctx |
| `CRITIC` | `critic` (`critic.py:159`) | Nova Pro | `amazon.nova-pro-v1:0` (`us.` geo) | trust score + recommendation |
| reconciler arbitration | `_reconcile_state` bbox round-trip (`orchestrator.py:1845`) | Nova Pro | `amazon.nova-pro-v1:0` | inject backend so tiebreaker step 3 stops silently skipping |
| RCA narration | `RCAAgent` (Pillar 2) | Nova Pro | `amazon.nova-pro-v1:0` | SPL generation + narration |

`ModelRouter.role_for_agent` (`model_router.py:386`) already maps `extractor_pass2→SECONDARY`, `critic→CRITIC`; the backend absorbs role dispatch transparently so agents are unchanged.

### 4.4 Converse usage attribution

Map the Converse response into the existing `VisionResponse` (`src/client/lm_client.py:186-239`) inside `BedrockVLMBackend.send_vision_request`:

```
response = client.converse(modelId=model_id, messages=[...], system=[...],
                           inferenceConfig={"maxTokens": min(req.max_tokens, 8000),
                                            "temperature": req.temperature},
                           toolConfig=tool_cfg,                       # structured output
                           requestMetadata={"tenant_id": ..., "processing_id": ...,
                                            "trace_id": ...})         # per-tenant attribution
usage   = response["usage"]      # {inputTokens, outputTokens, totalTokens, cacheReadInputTokens?}
metrics = response["metrics"]    # {latencyMs}

VisionResponse.usage = {"prompt_tokens": usage["inputTokens"],
                        "completion_tokens": usage["outputTokens"],
                        "total_tokens": usage["totalTokens"]}
VisionResponse.latency_ms = metrics["latencyMs"]
```

`requestMetadata` is sourced from `ExtractionState.tenant_id`/`processing_id` and the `trace_id` from `bind_trace_id` (`audit.py:1434`). `Provenance.vlm_model_id` (`provenance.py:158`) is set to the resolved Bedrock model ID per pass.

### 4.5 Structured output via tool-use (no XGrammar)

Bedrock has no XGrammar/guided decoding, so constrained decoding becomes **tool-use forcing + post-hoc validation**:

1. Convert the Pydantic schema (`Pass2AuditorEnvelope`, `CriticReport`, etc.) to a Converse `toolSpec.inputSchema.json`.
2. Set `toolConfig.toolChoice = {"tool": {"name": schema_name}}` to force a single structured emission.
3. Parse `output.message.content[].toolUse.input` → `parsed_json`.
4. Validate against the Pydantic model; on failure, one bounded repair retry.
5. In `constrained_decode` (`src/client/constrained.py:118`), set `DecodingTrace.schema_enforced=False` and `backend_name="bedrock"`.

Qwen3-VL Pass-1 keeps the permissive `JSONObjectEnvelope`; Nova Pro Pass-2/critic use forced tool-use for bbox-mandated output.

### 4.6 Confidence-gating (cost control)

Pass-1 (Qwen3-VL) always runs. Pass-2 (Nova Pro) is **gated**: skip when Pass-1 per-page confidence ≥ `bedrock.confidence_gate_threshold` (default 0.92) for non-PHI, non-medical-RCM profiles. Gate evaluated in the `_run_extractor_pass2` node before dispatch (`orchestrator.py` `_run_extractor_pass2`). When skipped, reconciler records `tiebreaker=single_pass` (`reconciler.py:84-105`) and the saved Pass-2 token cost is emitted as a telemetry counter. PHI/medical-RCM profiles override the gate to always dual-pass (compliance floor).

### 4.7 Nova Pro prompt caching

For Nova Pro calls, when the system prompt exceeds `bedrock.prompt_cache_min_tokens`, insert a `cachePoint` block (≤20K tokens, 5-min TTL) after the stable prefix (schema instructions, profile prompt fragment, validator rules). Cache hits surface as `usage.cacheReadInputTokens`, emitted as `gen_ai.usage.cache_read_input_tokens`. Applied to Pass-2, critic, reconciler arbitration, and RCA — the four Nova Pro slots whose prefixes are stable across pages/documents.

### 4.8 Resilience, quotas, failover

- **Adaptive retries.** `boto3` `Config(retries={"mode": "adaptive", "max_attempts": 5})` — handles `ThrottlingException` with client-side rate backpressure.
- **Scaling limit.** Per-model serverless TPM/RPM quota is the true ceiling. Application-level `vlm_queue_slot` semaphore (`src/client/backends/queue_depth.py:44`) must be set to a non-zero cap (current default 0 = unbounded is a production risk).
- **Failover (driven by Pillar 2 policy engine).** On sustained `Throttling/ServiceUnavailable`: (a) Pass-2 region/geo failover (Nova `us.` profile burst), (b) quarantine degraded model in `ModelRouter._models`, (c) degrade to single-VLM (Pass-1 only) with raised human-review threshold.

### 4.9 Security / IAM / guardrails

- **IAM least-privilege.** Task role limited to `bedrock:InvokeModel` / `bedrock:Converse` on the two model ARNs in `us-east-1`; CloudWatch `logs:PutLogEvents` for model-invocation logging.
- **No AWS in CI.** `FakeBedrockClient` returns deterministic Converse-shaped responses; `factory` builder accepts an injected client for tests.
- **Data residency.** Qwen3-VL is In-Region only; Nova `us.` geo profile keeps inference within US regions. PHI never leaves the boundary; payloads >25MB go via S3 reference (image limits below).
- **SPL guardrail.** Any SPL produced by the RCA copilot is filtered by a LOCAL guardrail blocking `|delete`, `|outputlookup`, and unbounded queries (see Pillar 2).

### 4.10 Image preprocessing limits (Bedrock-specific)

| Constraint | Value | Enforcement point |
| --- | --- | --- |
| Max images per request | 20 | Batch page images in `BedrockVLMBackend` |
| Per-image size | ≤ 3.75 MB and ≤ 8000 px | Resize in `runner._resize_image` (`runner.py:606`) tuned to Bedrock |
| Total payload | ≤ 25 MB inline; else S3 | Add S3-upload fallback in backend |
| Native PDF block | Nova Pro supports document block | Optional: bypass rasterization for Nova PDF inputs (currently all paths rasterize — tech debt) |

---

## 5. Pillar 2 — Agent Observability & Self-Healing (Target State, Full)

### 5.1 Canonical telemetry contract (OTel GenAI mapping)

Promote `build_pass_span_attrs` (`observability.py:436`) from dead code to the **single source of truth**. Extend it with `gen_ai.*` keys and replace ad-hoc dicts at `base.py:380-390`, `orchestrator.py:733-744`, `critic.py:297-309`.

| Canonical attr (helper key) | OTel GenAI semantic convention | Source |
| --- | --- | --- |
| `pass` | `gen_ai.operation.name` | pass label |
| `model_id` | `gen_ai.request.model` / `gen_ai.response.model` | `resolve(role)` |
| (provider) | `gen_ai.provider.name = aws.bedrock` | constant |
| `tokens_in` | `gen_ai.usage.input_tokens` | Converse `usage.inputTokens` |
| `tokens_out` | `gen_ai.usage.output_tokens` | Converse `usage.outputTokens` |
| (cache) | `gen_ai.usage.cache_read_input_tokens` | Converse `usage.cacheReadInputTokens` |
| `latency_ms` | `gen_ai.server.request.duration` | Converse `metrics.latencyMs` |
| `trace_id` | `trace_id` | `bind_trace_id` contextvar |
| `tenant_id` | `tenant.id` | `request.state.tenant_id` |
| `profile` | `veridoc.profile` | detected profile |
| `document_type` | `veridoc.document_type` | analyzer |
| (cost) | `veridoc.cost_usd` | computed from tokens × price |

### 5.2 Pluggable sink architecture

Add two `_Sink` subclasses (`observability.py:66`) and register in `from_settings()` (`:277,292-307`) parallel to Phoenix/PostHog:

- **`SplunkHECSink`** — POST to `http://localhost:8088/services/collector`, header `Authorization: Splunk <HEC_TOKEN>`, `index=agent_telemetry`, `sourcetype=veridoc:agent`. (HEC token is distinct from the MCP token.)
- **`OTelGenAISink`** — OTLP exporter with `gen_ai.provider.name=aws.bedrock` and `gen_ai.usage.*` on every span; reuses the canonical attrs.

New `ObservabilitySettings` fields (`settings.py:1120`): `splunk_enabled`, `splunk_hec_url`, `splunk_hec_token: SecretStr`, `splunk_index`, `otel_genai_enabled`, `otel_endpoint`.

### 5.3 Two correlated telemetry planes

```
APP PLANE (in-process)                         INFRA PLANE (AWS)
 build_pass_span_attrs ─▶ Dispatcher            CloudWatch AWS/Bedrock metrics
   ├─ SplunkHECSink ─▶ index=agent_telemetry      (TTFT, OTPS, invocations, throttles)
   └─ OTelGenAISink ─▶ OTLP collector           Bedrock model-invocation logs
                                                       │
        trace_id  +  requestMetadata  ◀── correlation key ──▶  Splunk Add-on for AWS /
        (audit.py:1434)                                          Observability Cloud
```

Both planes land in Splunk and are joined on `trace_id` + `requestMetadata` (tenant_id, processing_id).

### 5.4 Dashboards (Splunk, `index=agent_telemetry`)

1. **Cost & usage** — tokens in/out, cache-read ratio, cost_usd by tenant/model/profile.
2. **Latency & reliability** — TTFT, OTPS, p50/p95/p99 `latencyMs`, throttle rate (infra plane).
3. **Accuracy** — Pass-1/Pass-2 agreement, reconciler tiebreaker distribution, critic recommendations, human-review rate.
4. **Self-healing** — actions taken (failover/quarantine/threshold/ticket), approval latency, MTTR.

### 5.5 RCA copilot — 6-step chain (Nova Pro over Splunk MCP)

Connect to Splunk MCP Server (app 7931) via `mcp-remote` with a Bearer encrypted token (`audience=mcp`, caps `mcp_tool_execute`). `saia_*` AI tools are Cloud-only / out of scope, so **Nova Pro generates SPL itself**, gated by the LOCAL SPL guardrail.

1. **Trigger** — a self-healing condition or human review fires; collect `trace_id`, tenant, model, pass.
2. **Generate SPL** — Nova Pro drafts SPL (prefer `stats`/`timechart`; cap 1000 events/60s).
3. **Guardrail** — LOCAL filter blocks `|delete`, `|outputlookup`, unbounded queries; else reject + regenerate.
4. **Query** — execute via `splunk_run_query` (+ `splunk_get_metadata`, `splunk_get_indexes`, `splunk_get_index_info`, `splunk_get_knowledge_objects`, `splunk_run_saved_search` beta).
5. **Diagnose** — Nova Pro correlates app-plane spans with infra-plane throttle/latency to a root cause.
6. **Narrate + recommend** — produce a structured RCA narrative and a recommended policy action; emit as telemetry.

### 5.6 Self-healing policy engine — state machine

In-app (MCP is read-only). Automatic in dev/staging; **human-approved in prod** (maps to `Permission.SYSTEM_ADMIN`, `queue.py:182`). Every action emitted via `dispatcher.emit_event`.

```
        ┌─────────┐  signal breach (throttle/latency/low-confidence/critic)
        │ HEALTHY │──────────────────────────────────────────────┐
        └────▲────┘                                               ▼
             │ clear                                        ┌────────────┐
             │                                              │ DIAGNOSING │ (RCA copilot)
             │                                              └─────┬──────┘
             │                                                    │ root cause
        ┌────┴──────┐   prod: approval                     ┌──────▼───────┐
        │ RECOVERED │◀────────────────────────────────────│  PROPOSING   │ action set
        └────▲──────┘                                      └──────┬───────┘
             │ verify                                  dev/stg auto │ prod: gate
        ┌────┴──────┐   apply: failover | quarantine |       ┌─────▼──────┐
        │  HEALING  │◀──── raise-review-threshold |  ────────│  APPROVED  │
        └───────────┘      open-ticket (webhook DLQ)         └────────────┘
```

Actions: model/region failover, quarantine degraded model (disable in `ModelRouter._models`), raise human-review threshold, open ticket via `WebhookDLQ.enqueue_failed` (`webhook_dlq.py:269`). Attach the engine as a post-`ROUTE` node in `build_workflow` (`orchestrator.py:608`) and inside `BedrockVLMBackend` error handling.

---

## 6. End-to-End Sequence Flows

### 6.1 Extraction with confidence-gating

```
Client ─▶ POST /documents/process (documents.py:186)
  └─▶ run_extraction_pipeline (graph.py:14) ─▶ PipelineRunner.extract_from_pdf (runner.py:112)
        1. PREPROCESS: pypdfium2 rasterize ─▶ base64 page_images
        2. ANALYZE/LAYOUT: detect_profile, document_type, modalities
        3. PASS1 (Qwen3-VL, PRIMARY): per-page extract  ─▶ pass1_result, usage span
        4. GATE: if conf ≥ threshold AND not PHI/RCM ─▶ skip PASS2 (emit cost-saved)
                 else PASS2 (Nova Pro, SECONDARY, forced tool-use, bbox) ─▶ pass2_result
        5. RECONCILE: 5-step tiebreaker; Nova arbitration on bbox round-trip
        6. VALIDATE: hallucination/codes/cross-field ─▶ overall_confidence
        7. CRITIC (Nova Pro): trust_score + recommendation ─▶ COMBINER reweights
        8. ROUTE (_determine_route): complete | retry | human_review
  ◀─ ProcessResponse (merged_extraction + provenance)
```

### 6.2 Telemetry → Splunk (both planes)

```
Every VLM slot (base.py:344):
  build_pass_span_attrs(... gen_ai.*) ─▶ dispatcher.start_span / record_llm_call / emit_event
     ├─ SplunkHECSink  ─▶ POST :8088/services/collector  (index=agent_telemetry, Splunk <HEC>)
     └─ OTelGenAISink  ─▶ OTLP collector (gen_ai.provider.name=aws.bedrock)
Bedrock Converse(requestMetadata={trace_id, tenant_id}) ─▶ CloudWatch AWS/Bedrock + invocation logs
     └─ Splunk Add-on for AWS ─▶ index=agent_telemetry
JOIN in Splunk: app-plane span.trace_id == infra-plane log.requestMetadata.trace_id
```

### 6.3 Detect → diagnose → heal

```
PolicyEngine watches dispatcher events:
  DETECT: throttle rate ↑ OR p95 latency ↑ OR critic=human_review OR conf ↓
     ▼
  DIAGNOSE (RCA copilot, 6-step): Nova Pro ─▶ guarded SPL ─▶ splunk_run_query ─▶ root cause
     ▼
  PROPOSE: {failover Pass-2 region | quarantine Qwen3-VL | raise review threshold | open ticket}
     ▼
  GATE: dev/staging ─▶ auto-apply ;  prod ─▶ require SYSTEM_ADMIN approval
     ▼
  HEAL: mutate ModelRouter._models / queue_depth / threshold ; WebhookDLQ.enqueue_failed (ticket)
     ▼
  VERIFY ─▶ RECOVERED ─▶ HEALTHY   (every transition emitted as telemetry)
```

---

## 7. Cross-Cutting Concerns

- **Security.** JWT HS256, tenant-bound claims (`rbac.py:265-314`), two-layer PHI redaction, SHA-256 audit hash chain, SSRF-guarded webhooks. Bedrock IAM least-privilege; `trace_id` bridges audit ↔ Bedrock logs. SPL guardrail prevents destructive queries.
- **Multi-tenancy.** `TenantResolverMiddleware` (`tenant_middleware.py:76`) → `request.state.tenant_id` → `requestMetadata` on every Converse call → per-tenant cost/latency in Splunk. Per-tenant FAISS isolation (`vector_store.py:80`); per-tenant rate limits (`middleware.py:282`).
- **Reliability.** boto3 adaptive retries; `vlm_queue_slot` semaphore; LangGraph checkpoint/resume; Celery→sync graceful degradation; webhook DLQ with exponential backoff + poison detection.
- **Cost governance.** Confidence-gated Pass-2; Nova Pro prompt caching; cost telemetry by tenant/model/profile; quota-aware concurrency cap. Cost = f(gated Pass-2, cache-read ratio).
- **Data residency.** `us-east-1`; Qwen3-VL In-Region only; Nova `us.` geo; PHI confined to boundary; >25MB via S3 reference.

---

## 8. Canonical Telemetry / Event Schema (Formal Field Table)

| Field | Type | Required | Source `file:line` | Description |
| --- | --- | --- | --- | --- |
| `pass` | str | yes | `observability.py:474` | `pass1_vlm` / `pass2_auditor` / `reconciler` / `critic` / `validator` |
| `gen_ai.provider.name` | str | yes | new (sink) | constant `aws.bedrock` |
| `gen_ai.request.model` | str | yes | `protocol.py:169` resolve | resolved model ID |
| `gen_ai.usage.input_tokens` | int | yes | Converse `usage.inputTokens` | prompt tokens |
| `gen_ai.usage.output_tokens` | int | yes | Converse `usage.outputTokens` | completion tokens |
| `gen_ai.usage.cache_read_input_tokens` | int | no | Converse `usage` | Nova cache hits |
| `gen_ai.server.request.duration` | float(ms) | yes | Converse `metrics.latencyMs` | server latency |
| `trace_id` | str | yes | `audit.py:1434` | correlation key (both planes) |
| `tenant.id` | str | yes | `tenant_middleware.py:76` | per-tenant attribution |
| `veridoc.processing_id` | str | yes | `state.py:549` | document run id |
| `veridoc.profile` | str | no | `profiles/registry.py:148` | detected profile |
| `veridoc.document_type` | str | no | `analyzer.py` | CMS-1500 etc. |
| `veridoc.page_number` | int | no | per-page loop | 1-based |
| `veridoc.cost_usd` | float | no | computed | tokens × price |
| `veridoc.confidence` | float | no | `validator.py` | overall confidence |
| `veridoc.tiebreaker` | str | no | `reconciler.py:84-105` | reconciliation path |
| `veridoc.healing_action` | str | no | PolicyEngine | failover/quarantine/threshold/ticket |
| `bedrock.throttled` | bool | no | backend error path | throttle flag |
| `index` | const | yes | sink | `agent_telemetry` (Splunk) |

---

## 9. Architecture Decision Records (Summary)

| ADR | Decision | Rationale | Trade-off |
| --- | --- | --- | --- |
| 1 | One Converse API, two models (Qwen3-VL primary, Nova Pro secondary/critic/reconciler/RCA) | Single integration surface; heterogeneous models reduce correlated error | Quotas per-model become scaling ceiling |
| 2 | Bedrock as a `VLMBackend` behind `factory.get_backend` (`factory.py:55-65`) | Open/closed; no agent rewrites; testable | Must close `BaseAgent` protocol-bypass debt (`base.py:350-358`) |
| 3 | Structured output via tool-use + post-hoc validation | No XGrammar on Bedrock | `schema_enforced=False`; needs repair retry |
| 4 | Confidence-gated Pass-2 (override for PHI/RCM) | Cost control without accuracy loss on hard pages | Gate tuning risk; compliance floor mandatory |
| 5 | Nova Pro prompt caching on stable prefixes | Lower input-token cost | ≤20K tokens / 5-min TTL constraints |
| 6 | Promote `build_pass_span_attrs` to source-of-truth (`observability.py:436`) | Eliminates ad-hoc dict drift; enables OTel GenAI | One-time refactor of 3 call-sites |
| 7 | Two correlated planes joined on `trace_id` + `requestMetadata` | End-to-end app↔infra correlation | Requires Splunk Add-on for AWS |
| 8 | RCA copilot generates SPL locally, guardrail-gated | `saia_*` Cloud-only / out of scope | Must maintain LOCAL SPL guardrail |
| 9 | Self-healing auto in dev/staging, human-approved in prod | Safety vs. speed by environment | Prod MTTR bounded by approval latency |
| 10 | Swap `fitz`→`pypdfium2`; Apache-2.0 public surface | AGPL vs Proprietary blocker (`pyproject.toml:10,60`) | Rasterization re-validation across 3 sites |
| 11 | `FakeBedrockClient` for CI | No AWS creds in CI | Maintain fake in lockstep with real shapes |

---

## 10. Deployment Topology & Environments

| Component | Dev | Staging | Prod |
| --- | --- | --- | --- |
| API (uvicorn `src.api.app:app`) | localhost:8000 | container | autoscaled containers |
| Frontend (Next.js) | localhost:3000 | container | CDN + container |
| Model layer | `FakeBedrockClient` / LM Studio | Bedrock `us-east-1` | Bedrock `us-east-1` (+ `us.` geo burst) |
| Checkpointer | MemorySaver/SQLite | SQLite | Postgres (durable) |
| Queue | sync fallback | Redis+Celery | Redis+Celery (AUTH) |
| Splunk | docker `splunk/splunk:latest` 8000/8089/8088 | shared | enterprise/cloud |
| Self-healing | automatic | automatic | human-approved (`SYSTEM_ADMIN`) |

Splunk local bring-up: run container; enable HEC; **create `index=agent_telemetry` first**; mint two distinct tokens — HEC (`Splunk <token>`) and MCP (Bearer, `audience=mcp`).

---

## 11. Phased Enhancement Roadmap

1. **Phase A — License unblock.** Swap `fitz`→`pypdfium2` (`runner.py:404,533`; `pdf_processor.py:21`); `opencv-python-headless`; relicense public surface Apache-2.0.
2. **Phase B — Bedrock backend.** `BedrockBackendSettings`, `VLMBackendName.BEDROCK`, `BedrockVLMBackend`, factory branch, `FakeBedrockClient`, Converse usage mapping, tool-use structured output.
3. **Phase C — Close protocol bypass.** Route `BaseAgent.send_vision_request` through the backend; fix `DecodingTrace.backend_name`; inject reconciler bbox-round-trip backend.
4. **Phase D — Cost levers.** Confidence-gated Pass-2 + Nova prompt caching + quota-aware concurrency cap.
5. **Phase E — Telemetry spine.** Promote `build_pass_span_attrs`; add `SplunkHECSink` + `OTelGenAISink`; `ObservabilitySettings` fields; dashboards; infra-plane via Splunk Add-on.
6. **Phase F — RCA + self-healing.** Splunk MCP wiring; SPL guardrail; `RCAAgent`; `PolicyEngine` state machine + prod approval gate.
7. **Phase G — Promote dual-VLM.** Shadow-validate then flip `ExtractionEngine` default from `LEGACY` to `DUAL_VLM` (`settings.py:502,549`).

---

## 12. Open Items to Verify

1. **Per-page critic.** `CriticAgent` audits only page 1 (`critic.py:26-27`) — decide whether Nova Pro per-page critic is in scope for prod accuracy.
2. **Reconciler arbitration backend.** Confirm injecting Nova Pro into `_reconcile_state` (`orchestrator.py:1845`) is acceptable cost for bbox round-trip on every reconcile.
3. **Confidence-gate threshold.** Calibrate `bedrock.confidence_gate_threshold` against the eval harness before prod; confirm PHI/RCM override is exhaustive.
4. **Native PDF block.** Decide whether to exploit Nova Pro's native PDF document block to bypass rasterization for Nova inputs (currently all paths rasterize).
5. **Quota sizing.** Obtain Qwen3-VL and Nova Pro TPM/RPM quotas for `us-east-1` to size the `vlm_queue_slot` cap (`queue_depth.py:44`, default 0/unbounded).
6. **Token storage reconciliation.** Frontend localStorage tokens vs. backend HttpOnly cookies — two parallel auth channels (`api.ts:52-57` vs `auth.py:135-192`).
7. **Stale frontend endpoints.** `processApi`/`previewApi` paths (`api.ts:242-282,320`) mismatch backend routes — confirm before Bedrock-engine provenance shape changes.
8. **Dashboard stubs.** `dashboard.py:67-88` returns zeros — wire to real metrics store once persistence lands.
9. **Checkpoint durability.** Silent `MemorySaver` fallback (`orchestrator.py:218-229`) — assert durable checkpointer in staging/prod.
10. **Cost pricing source.** Confirm authoritative per-token pricing for `veridoc.cost_usd` computation per model/region.
