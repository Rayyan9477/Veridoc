# HANDOFF — Intelligent Document-Extraction Platform

> Engineering onboarding for the next developer (or AI session) picking up this codebase.
> The **entire existing codebase at `d:/Repo/PDF` is the foundation.** Every enhancement below
> is built *on top of* the current LangGraph/FastAPI/Next.js platform — there is no carve-out,
> no separate repo, no rewrite. Read the CODEBASE MAP in `CLAUDE.md`/the system context alongside this doc.

---

## 1. What We're Building

The platform is a Python 3.11 agentic document-extraction system: PDFs/images → LangGraph
StateGraph (preprocess → analyze → extract → reconcile → validate → critic → route) →
structured JSON/Excel/FHIR exports, fronted by a FastAPI API and a Next.js 14 app-router SPA.
It already supports dual-VLM heterogeneous extraction, provenance threading, profile detection
(medical-RCM / finance / generic), HIPAA-grade security, and a pluggable observability dispatcher.

We are adding **two durable product capabilities** ("pillars"):

### Pillar 1 — Managed Bedrock Model Layer
Replace the local VLM backends (LM Studio / vLLM / Gemma) with a **Bedrock-only managed model
layer** driven by a single **Converse API** (region `us-east-1`). The dual-VLM topology maps
cleanly onto two cross-model Bedrock models:

- **Pass-1 primary vision** → **Qwen3-VL-235B-A22B** (`qwen.qwen3-vl-235b-a22b`)
- **Pass-2 verification + reconciler arbitration + critic + RCA narration** → **Amazon Nova Pro** (`amazon.nova-pro-v1:0`)

This gives us serverless scaling (no GPU ops), per-tenant cost attribution from Converse
`usage`/`metrics`, and confidence-gated Pass-2 to control spend.

### Pillar 2 — Agent Observability & Self-Healing
Add first-class **Splunk** (HEC) and **OpenTelemetry GenAI** sinks behind the existing
`ObservabilityDispatcher`, correlate an **app-plane** (Converse usage/latency/cost spans) with
an **infra-plane** (Bedrock CloudWatch metrics + model-invocation logs) via `trace_id` +
`requestMetadata`, add an **agentic RCA copilot** (Nova Pro over a Splunk MCP Server, with a
local SPL guardrail), and a **self-healing policy engine** (model/region failover, model
quarantine, raise human-review threshold, open a ticket via the existing webhook DLQ).

---

## 2. Locked Decisions

| # | Decision | Value / Rule |
|---|----------|--------------|
| D1 | Model layer | Bedrock-only via **one Converse API**; remove dependence on local backends for the managed path |
| D2 | Region | `us-east-1` |
| D3 | Pass-1 primary | Qwen3-VL-235B-A22B — `qwen.qwen3-vl-235b-a22b` (serverless, In-Region only) |
| D4 | Pass-2 / critic / reconciler arbitration / RCA | Amazon Nova Pro — `amazon.nova-pro-v1:0`, use the `us.` geo (inference profile) for burst |
| D5 | Cost control | Confidence-gated Pass-2 + Nova Pro prompt caching (≤20K tokens, 5-min TTL) |
| D6 | Per-tenant attribution | Tag every Converse call via `requestMetadata` (`tenant_id`, `processing_id`, `trace_id`) |
| D7 | Retries / scaling limit | boto3 **adaptive** retries; per-model serverless **TPM/RPM quotas** are the scaling ceiling |
| D8 | CI | No AWS in CI — tests use a `FakeBedrockClient` |
| D9 | Telemetry sinks | Splunk HEC first-class + OTel GenAI exporter, both behind `ObservabilityDispatcher` |
| D10 | Splunk index / auth | index = `agent_telemetry`; HEC header `Authorization: Splunk <token>`; sourcetype `veridoc:agent` |
| D11 | OTel GenAI attrs | `gen_ai.provider.name=aws.bedrock`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` |
| D12 | Canonical attrs | Promote the (currently dead) `build_pass_span_attrs()` to the telemetry source-of-truth |
| D13 | Two telemetry planes | app-plane (Converse spans) + infra-plane (CloudWatch AWS/Bedrock incl. TTFT/OTPS + model-invocation logs), correlated by `trace_id` + `requestMetadata` |
| D14 | RCA copilot | Nova Pro generates SPL itself (Splunk Cloud `saia_*` AI tools are OUT OF SCOPE locally) over **Splunk MCP Server** |
| D15 | SPL guardrail | LOCAL guardrail blocks `\|delete`, `\|outputlookup`, and unbounded searches before any SPL runs |
| D16 | Self-healing autonomy | AUTOMATIC in dev/staging, **HUMAN-APPROVED in prod**; every action emitted as telemetry |
| D17 | Self-healing channel | MCP is **read-only** → policy engine is **in-app**; tickets open via the existing webhook DLQ |
| D18 | License target | **Apache-2.0** for any public release |
| D19 | License blocker | PyMuPDF/`fitz` is **AGPL-3.0** (`pyproject.toml:60`) while repo is declared Proprietary (`pyproject.toml:10`) → must resolve before public release |
| D20 | License resolution | Swap PDF rasterization `fitz` → **pypdfium2** (Apache-2.0/BSD); prefer `opencv-python-headless` |

---

## 3. Verified Bedrock Facts

| Fact | Detail |
|------|--------|
| API | Single **Converse** API on `bedrock-runtime` (`boto3.client("bedrock-runtime").converse(...)`) |
| Region | `us-east-1` |
| Qwen3-VL-235B | model id `qwen.qwen3-vl-235b-a22b`; serverless on `bedrock-runtime`; **256K** context; text + image; **max output 8K**; **In-Region only** |
| Nova Pro | model id `amazon.nova-pro-v1:0`; use **`us.` geo profile** for burst; **300K** context; text + image + video; **tool-use**; **prompt caching ≤20K tokens / 5-min TTL**; latency-optimized inference; **native PDF document block** (no rasterization needed for PDF) |
| Nova Pro image limits | ≤ **20 images**, each ≤ **3.75 MB** and ≤ **8000 px**; ≤ **25 MB** total payload, else stage to **S3** |
| Usage block | Converse returns `usage{inputTokens, outputTokens}` + `metrics{latencyMs}` |
| Attribution | tag calls via `requestMetadata` for per-tenant cost attribution |
| Retries | boto3 **adaptive** retry mode |
| Scaling limit | per-model serverless **TPM/RPM** quotas |
| Cost control | confidence-gated Pass-2 + Nova prompt caching |
| Field mapping | `usage.inputTokens` → `VisionResponse.usage["prompt_tokens"]`; `usage.outputTokens` → `["completion_tokens"]`; sum → `["total_tokens"]`; `metrics.latencyMs` → `VisionResponse.latency_ms` |
| Constrained decoding | **No XGrammar on Bedrock** → schema cannot be enforced at decode time; post-hoc validate `parsed_json`, set `DecodingTrace.schema_enforced=False` |
| CI | No AWS calls — `FakeBedrockClient` returns canned Converse responses |

> Reuse the existing `VisionResponse.usage` keys (`prompt_tokens` / `completion_tokens` /
> `total_tokens`) — there is no shared normalisation layer, so the mapping **must** happen
> inside the Bedrock backend.

---

## 4. Verified Splunk Facts

| Fact | Detail |
|------|--------|
| Local stack | `docker run splunk/splunk:latest`, ports **8000** (UI), **8089** (mgmt), **8088** (HEC) |
| HEC | Enable HEC, **create index first**; POST to `http://localhost:8088/services/collector` |
| HEC index | `agent_telemetry`; sourcetype `veridoc:agent` |
| HEC auth | header `Authorization: Splunk <HEC_TOKEN>` (HEC token is **distinct** from the MCP token) |
| OTel GenAI | exporter sets `gen_ai.provider.name=aws.bedrock`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` |
| Infra-plane | Bedrock CloudWatch `AWS/Bedrock` metrics (incl. **TTFT** / **OTPS**) + model-invocation logs, ingested via Splunk Add-on for AWS / Observability Cloud |
| Correlation | app-plane ↔ infra-plane joined by `trace_id` + `requestMetadata` |
| MCP server | Splunk MCP Server, **app 7931**; connect via **mcp-remote** with a **Bearer encrypted token, audience=mcp**; token caps `mcp_tool_execute` / `mcp_tool_admin` / `edit_tokens_own` |
| MCP tools | `splunk_run_query` (**cap 1000 events / 60s** → use `stats`/`timechart`), `splunk_get_metadata`, `splunk_get_indexes`, `splunk_get_index_info`, `splunk_get_knowledge_objects`, `splunk_run_saved_search` (beta) |
| MCP scope | read-only; Cloud `saia_*` AI tools + hosted models are OUT OF SCOPE locally → Nova Pro generates SPL itself |
| SPL guardrail (local) | block `\|delete`, `\|outputlookup`, and unbounded searches before execution |
| Two tokens | **HEC token** (ingest) ≠ **MCP Bearer token** (audience=mcp, query) — keep separate in settings |

---

## 5. Reusable Seams — Where To Make Each Change

These are the exact attach points drawn from the codebase map. **Prefer extending these
open/closed surfaces over rewrites.** Line numbers are anchors; verify on open (the repo moves).

### Pillar 1 — Bedrock model layer

| Change | File : line | Notes |
|--------|-------------|-------|
| Add backend enum value | `src/config/settings.py:79-81` | add `BEDROCK = "bedrock"` to `VLMBackendName` (today: `LM_STUDIO`/`VLLM`/`GEMMA`) |
| Add Bedrock settings group | `src/config/settings.py` (after `GemmaBackendSettings`, ~`:264`) | new `BedrockBackendSettings(env_prefix="BEDROCK_")`: region, model ids, `us.` profile, cache-checkpoint, S3 staging bucket |
| Wire settings group | `src/config/settings.py:267-316` (`VLMSettings`) | add `bedrock: BedrockBackendSettings = Field(default_factory=...)` |
| Factory dispatch branch | `src/client/backends/factory.py:55-65` | add `elif backend_name == "bedrock": backend = _build_bedrock_backend(settings)` (today raises `ValueError` for it) |
| Factory builder | `src/client/backends/factory.py` (~`:147` region) | add `_build_bedrock_backend(settings)` reading `settings.vlm.bedrock` |
| New backend module | `src/client/backends/bedrock_backend.py` (new) | implement `VLMBackend` protocol via `boto3 bedrock-runtime.converse()` |
| Backend protocol contract | `src/client/backends/protocol.py:150-207` | implement `resolve(role)` → PRIMARY=`qwen.qwen3-vl-235b-a22b`, SECONDARY/CRITIC=`amazon.nova-pro-v1:0`; set caps: `supports_logprobs=False`, `supports_constrained_decoding=False`, `supports_dual_vlm=True`, `supports_multi_image=True` |
| Export new backend | `src/client/backends/__init__.py:16-35` | add `BedrockVLMBackend` to imports + `__all__` |
| Usage → VisionResponse mapping | `src/client/lm_client.py:186-239` | map `inputTokens`/`outputTokens`/`latencyMs` into the existing `VisionResponse.usage` keys + `latency_ms` |
| **Critical coupling to break** | `src/agents/base.py:164-188` | `__init__` hard-codes `self._client = client or LMStudioClient()` — no injection point for a `VLMBackend`. `send_vision_request` (`:237-413`) and `send_vision_request_with_schema` (`:416-595`) call `self._client.send_vision_request(...)` **directly**, bypassing the `VLMBackend` protocol, and hard-code `backend_name="lm_studio"` in the `DecodingTrace` (`:554`). To route PRIMARY→Qwen and SECONDARY/CRITIC→Nova, the **backend must absorb the role dispatch** — refactor BaseAgent to call a backend, or route through `constrained_decode()` which already uses the protocol cleanly |
| Clean protocol call-site (reuse) | `src/client/constrained.py:118-203` | `constrained_decode()` already calls `backend.send_vision_request(schema=...)` — the one place wired correctly; Bedrock backend validates schema post-hoc, sets `schema_enforced=False` |
| `requestMetadata` injection | `src/agents/base.py:334-358` (VLM call block) | forward `{tenant_id, processing_id, trace_id}` from state through the backend into the Converse call |
| Nova prompt caching | inside `bedrock_backend.send_vision_request` before the boto3 call | add cache-point block when `system_prompt` length > threshold (≤20K tokens, 5-min TTL) — apply to Pass-2 / critic / reconciler |
| Provenance model id | `src/pipeline/provenance.py:158` (`Provenance.vlm_model_id`) | set to `qwen.qwen3-vl-235b-a22b` / `amazon.nova-pro-v1:0` |
| Pipeline call sites (sync) | `src/api/routes/documents.py:309` and `:375` | where `run_extraction_pipeline` / `PipelineRunner` run — Bedrock replaces local VLM here transparently via the backend |
| Client injection points | `src/pipeline/runner.py:52` and `src/agents/orchestrator.py:1608` (`create_extraction_workflow(client=...)`) | both accept a `client` — the seam for swapping in the Bedrock-backed client |
| Multi-record blind spot | `src/extraction/multi_record.py:31` | directly instantiates `LMStudioClient` + `VisionRequest`, bypassing the backend/router — must be migrated too |
| VLM queue-depth gate | `src/client/backends/queue_depth.py:44-63`; `settings.vlm.max_concurrent_requests` (`settings.py:301`) | defaults to **0 (unbounded)** — Bedrock TPM/RPM quotas make an explicit cap mandatory in prod |

### Pillar 2 — Observability & self-healing

| Change | File : line | Notes |
|--------|-------------|-------|
| Splunk HEC sink | `src/monitoring/observability.py:66` (`_Sink` base), register in `from_settings()` `:277-312` | add `SplunkHECSink(_Sink)` posting to `:8088/services/collector`, index `agent_telemetry`, `Authorization: Splunk <token>` |
| OTel GenAI sink | same file, same factory | add `OTelGenAISink(_Sink)` with `gen_ai.provider.name=aws.bedrock`, `gen_ai.usage.*` |
| Observability settings | `src/config/settings.py:1120-1159` (`ObservabilitySettings`) | add `splunk_enabled`, `splunk_hec_url`, `splunk_hec_token` (SecretStr), `splunk_index`, `otel_genai_enabled`, `otel_endpoint`, `otel_service_name`, plus MCP `splunk_mcp_url` / `splunk_mcp_token` |
| **Promote dead canonical helper** | `src/monitoring/observability.py:436-506` (`build_pass_span_attrs`) | it is exported + tested but has **zero production call-sites**; replace ad-hoc dicts in `base.py:380-390`, `orchestrator.py:733-744`, `critic.py:297-309` with calls to it; extend with `gen_ai.*` + `bedrock.request_metadata` + `splunk.*` |
| App-plane span enrichment | `src/agents/base.py:344` & `:521` (`start_span`) and `:363`/`:544` (`record_llm_call`) | inject Converse `usage`/`metrics` + `requestMetadata` once the Bedrock backend returns them |
| Span constants (dead) | `src/monitoring/observability.py:430-433` (`SPAN_EXTRACTION_PASS`/`SPAN_RECONCILER`/`SPAN_CRITIC`) | defined but never opened — wire them when promoting the helper |
| trace_id bridge | `src/security/audit.py:1434` (`bind_trace_id`) → `observability.py:560` (`_read_trace_id_from_context`) | the `trace_id` minted here must flow into `requestMetadata['trace_id']` so app-plane correlates with Bedrock CloudWatch logs in Splunk |
| RCA copilot node | new `NODE_RCA` after `NODE_HUMAN_REVIEW` in `build_workflow` (`src/agents/orchestrator.py:510-515`) | new `RCAAgent` wraps Nova Pro Converse → generates SPL → Splunk MCP (`splunk_run_query`), gated by `LOCAL_SPL_GUARDRAIL` |
| Self-healing policy engine | new `src/agents/self_healing.py`; attach as post-`ROUTE` node (`orchestrator.py:608`) **and** in Bedrock backend error handling | `PolicyEngine`: model/region failover, quarantine degraded model (disable in `ModelRouter._models`), raise human-review threshold, open ticket via webhook DLQ; **AUTOMATIC dev/staging, HUMAN-APPROVED prod**; emit every action as telemetry |
| Ticket channel (reuse) | `src/queue/webhook_dlq.py:269` (`enqueue_failed`) / `src/queue/webhook_store.py` | the existing DLQ is the policy engine's escalation channel |
| Human-approval gate (reuse) | `src/api/routes/queue.py:182` (`Permission.SYSTEM_ADMIN` pattern) | reuse for prod approval of healing actions |
| Poison-subscription hook | `src/queue/webhook_dlq.py:437` (`detect_poison_subscription`) | call on each `claim_due()` cycle; emit telemetry; RCA can query the error history |
| VLM health check swap | `src/api/routes/health.py:110` (`_check_vlm_health`) and dashboard summary `dashboard.py:193` | probe Bedrock connectivity instead of LM Studio |
| Prometheus model labels | `src/monitoring/metrics.py:323` (`_init_vlm_metrics`) | labels by `agent` only — add `model_id`/`pass` to split Qwen Pass-1 vs Nova Pass-2 cost |

### License remediation (AGPL → Apache-2.0)

| Change | File : line | Notes |
|--------|-------------|-------|
| `fitz` call site 1 (unconditional import) | `src/preprocessing/pdf_processor.py:21` | swap to `pypdfium2`; rewrite `render_page()` (`:466`) + `process()` (`:631`) |
| `fitz` call site 2 (lazy) | `src/pipeline/runner.py:404` (`_load_and_convert_pdf`) | swap `fitz.open` / `get_pixmap` / `tobytes("png")` → pypdfium2 |
| `fitz` call site 3 (lazy) | `src/pipeline/runner.py:533` (`_convert_pdf_bytes_to_images`) | swap stream path |
| pyproject deps | `pyproject.toml:10`, `:60`, `:63` | license → Apache-2.0; drop `PyMuPDF`; `opencv-python` → `opencv-python-headless` |
| Nova native PDF | `src/api/routes/documents.py:309/375` pipeline | exploit Nova Pro's native PDF document block to skip rasterization for the Nova path |

---

## 6. Run It Locally

> Working directory is `d:/Repo/PDF`. Shell examples assume Git Bash; PowerShell equivalents in parentheses.

### 6.1 Python env + deps
```bash
python -m venv .venv && source .venv/Scripts/activate      # (.venv\Scripts\Activate.ps1)
pip install -e ".[dev,observability]"                       # add boto3 + OTel exporter as they land
```

### 6.2 CLI extraction (`main.py`)
```bash
# Single-document extract
python main.py extract path/to/document.pdf --schema cms_1500 --output result.json

# Batch a directory
python main.py batch path/to/dir --output out/

# Inspect resolved config
python main.py config
```
The CLI default `vlm_model` is `qwen/qwen3-vl-8b` (`main.py:113`, points at local LM Studio) —
update once the Bedrock backend lands.

### 6.3 FastAPI backend + Next.js frontend (one command)
```bash
# Spawns uvicorn (src.api.app:app on :8000) + Next.js dev (:3000) via ProcessManager
python main.py            # web-server is the default subcommand
```
- API: `http://localhost:8000`  (health: `/api/v1/health`, metrics: `/api/v1/metrics`)
- Frontend: `http://localhost:3000`  (`NEXT_PUBLIC_API_URL=http://localhost:8000`)

Run the API alone:
```bash
uvicorn src.api.app:app --host 0.0.0.0 --port 8000 --reload --reload-dir src
```
Frontend alone:
```bash
cd frontend && npm install && npm run dev -- --port 3000
```

### 6.4 Optional infra
```bash
# Redis (async Celery path; system degrades to sync when absent)
docker run -d -p 6379:6379 redis:latest

# Arize Phoenix (existing OTLP sink, optional)
#   set OBSERVABILITY_PHOENIX_ENABLED=true ; default endpoint http://localhost:6006
```

### 6.5 Splunk local stack
```bash
docker run -d --name splunk \
  -p 8000:8000 -p 8089:8089 -p 8088:8088 \
  -e SPLUNK_START_ARGS='--accept-license' \
  -e SPLUNK_PASSWORD='ChangeMe_Strong1' \
  splunk/splunk:latest

# 1) Splunk Web at http://localhost:8000  (admin / SPLUNK_PASSWORD)
# 2) Settings → Indexes → New Index: name = agent_telemetry   (CREATE INDEX FIRST)
# 3) Settings → Data Inputs → HTTP Event Collector → Enable + New Token
#    -> capture the HEC token (distinct from the MCP token)
# 4) Smoke-test HEC ingest:
curl -k https://localhost:8088/services/collector \
  -H "Authorization: Splunk <HEC_TOKEN>" \
  -d '{"index":"agent_telemetry","sourcetype":"veridoc:agent","event":{"msg":"hec_smoke_ok"}}'

# 5) MCP (app 7931): mint a SEPARATE Bearer token, audience=mcp,
#    caps mcp_tool_execute / mcp_tool_admin / edit_tokens_own; connect via mcp-remote.
```

### 6.6 Bedrock smoke test (boto3 Converse)
Requires AWS creds for `us-east-1` with Bedrock model access enabled for both models. **CI uses
`FakeBedrockClient` instead — never call real AWS in tests.**
```python
# scripts/bedrock_smoke.py  (run: python scripts/bedrock_smoke.py)
import base64, boto3
from botocore.config import Config

brt = boto3.client(
    "bedrock-runtime",
    region_name="us-east-1",
    config=Config(retries={"mode": "adaptive", "max_attempts": 4}),
)

def converse(model_id, image_path, prompt):
    with open(image_path, "rb") as fh:
        img_bytes = fh.read()
    resp = brt.converse(
        modelId=model_id,
        messages=[{
            "role": "user",
            "content": [
                {"text": prompt},
                {"image": {"format": "png", "source": {"bytes": img_bytes}}},
            ],
        }],
        inferenceConfig={"maxTokens": 4096, "temperature": 0.1},
        requestMetadata={"tenant_id": "default", "processing_id": "smoke-1", "trace_id": "smoke-trace"},
    )
    usage, metrics = resp["usage"], resp["metrics"]
    print(model_id, "->",
          "in", usage["inputTokens"], "out", usage["outputTokens"], "latencyMs", metrics["latencyMs"])
    print(resp["output"]["message"]["content"][0]["text"][:500])

# Pass-1 primary (Qwen3-VL-235B, In-Region only, max output 8K)
converse("qwen.qwen3-vl-235b-a22b", "sample_page.png", "List every field you can read.")

# Pass-2 / critic (Nova Pro; use us. geo profile id for burst)
converse("us.amazon.nova-pro-v1:0", "sample_page.png", "Audit the extraction; emit bboxes.")
```
> Nova Pro payload rules: ≤20 images, each ≤3.75 MB / ≤8000 px, ≤25 MB total — stage to S3 above that.
> Map `usage.inputTokens/outputTokens` and `metrics.latencyMs` into `VisionResponse` per §3.

### 6.7 Tests
```bash
pytest                          # asyncio_mode=auto; 121 test files across unit/integration/security/e2e
pytest tests/unit -q
```

---

## 7. Phased Roadmap (with concrete first tasks)

### Phase A — Bedrock backend (foundation)
1. Add `VLMBackendName.BEDROCK` + `BedrockBackendSettings` (`settings.py:79`, after `:264`) and wire into `VLMSettings`.
2. Write `FakeBedrockClient` (canned Converse responses incl. `usage`/`metrics`) under `tests/` first — TDD the mapping.
3. Implement `src/client/backends/bedrock_backend.py` against the `VLMBackend` protocol; `resolve()` role→model map; usage→`VisionResponse` mapping; post-hoc schema validation (`schema_enforced=False`).
4. Add factory branch + builder (`factory.py:55-65`, `:147`) and export (`__init__.py:16-35`).
5. **Break the BaseAgent coupling** (`base.py:164-188`, `:237-413`, `:416-595`) so role dispatch reaches the backend; fix the hard-coded `backend_name="lm_studio"` trace (`:554`).
6. Run §6.6 smoke + the FakeBedrock unit tests green.

### Phase B — Attribution & cost control
1. Inject `requestMetadata` (`tenant_id`/`processing_id`/`trace_id`) through `base.py:334-358`.
2. Add Nova Pro prompt caching for Pass-2/critic/reconciler.
3. Implement confidence-gated Pass-2 (skip Pass-2 when Pass-1 confidence clears threshold).
4. Set `Provenance.vlm_model_id` to the Bedrock ids; add `model_id`/`pass` Prometheus labels (`metrics.py:323`).

### Phase C — Telemetry sinks
1. Add `splunk_*` + `otel_*` fields to `ObservabilitySettings` (`settings.py:1120`).
2. Implement `SplunkHECSink` + `OTelGenAISink` (`observability.py:66`); register in `from_settings()`.
3. **Promote `build_pass_span_attrs()`** to the source-of-truth; replace ad-hoc dicts at the three call-sites; add `gen_ai.*` keys.
4. Verify HEC ingest into `agent_telemetry` and OTel GenAI spans; confirm `trace_id` correlation.

### Phase D — Infra-plane correlation
1. Stand up Splunk Add-on for AWS to ingest `AWS/Bedrock` CloudWatch metrics (TTFT/OTPS) + model-invocation logs.
2. Confirm app-plane ↔ infra-plane join on `trace_id` + `requestMetadata`.

### Phase E — RCA copilot + self-healing
1. Build the local SPL guardrail (`block |delete / |outputlookup / unbounded`); unit-test it.
2. Connect to Splunk MCP (app 7931, Bearer audience=mcp) via mcp-remote; add `RCAAgent` (Nova Pro) generating SPL, `NODE_RCA` after `NODE_HUMAN_REVIEW`.
3. Implement `PolicyEngine` (`src/agents/self_healing.py`): failover / quarantine / threshold-raise / DLQ ticket; AUTOMATIC dev-staging, HUMAN-APPROVED prod; emit every action.

### Phase F — License remediation (pre-public)
1. Swap all three `fitz` call sites → pypdfium2; `opencv-python` → headless; license → Apache-2.0.
2. Exploit Nova Pro native PDF block on the Nova path.

---

## 8. Open Items / Risks

- **BaseAgent bypasses the VLMBackend protocol** (`base.py:350-358`) — biggest blocker; role dispatch never reaches a backend on the base path. Must be refactored before dual-Bedrock topology works end-to-end.
- **No `FakeBedrockClient` / zero Bedrock references in `tests/`** — build the CI harness first.
- **`max_concurrent_requests` defaults to 0 (unbounded)** (`settings.py:301`) — Bedrock TPM/RPM quotas make an explicit cap mandatory; no startup assertion exists.
- **`from_settings()` is a closed factory** (`observability.py:277`) — no plugin registry; adding sinks edits the method body.
- **`build_pass_span_attrs` + SPAN_* constants are dead code** — promote before Bedrock attribution lands.
- **Dual-VLM gated by `ExtractionEngine.DUAL_VLM` but defaults to LEGACY** (`settings.py`) — shadow-validate before promoting.
- **Reconciler bbox round-trip (tiebreaker step 3) silently skipped when `backend=None`** (`orchestrator.py:1845`) — degraded but unflagged.
- **Critic audits only the first page** of multi-page docs (`critic.py:26-27`).
- **Multi-record path hard-codes `LMStudioClient`** (`multi_record.py:31`) — blind spot for migration.
- **`extraction.db` declared but unimplemented** (`settings.py`); dashboard metrics fully stubbed (`dashboard.py:67-88`); `GET /documents/{id}` + reprocess always 404 — no persistence layer.
- **Frontend stale endpoints** — `processApi` calls `/process/upload` & `/process/async`, `previewApi` calls `/preview` — backend serves `/documents/*`; these 404.
- **Two parallel auth channels** — localStorage tokens (frontend) vs HttpOnly cookies (backend) with no reconciliation.
- **`AlertManager.check_rules()` has no scheduled caller** — the rule engine never fires in production paths.
- **`pyproject.toml` console script `doc-extract = src.cli:main`** but `src/cli.py` doesn't exist — real entrypoint is `main.py:main()`.
- **`pyproject.toml` lacks** `boto3`, `opentelemetry-exporter-otlp-proto-http`, `opentelemetry-semantic-conventions` — Bedrock + Splunk sinks can't be installed today.

---

## 9. Paste-Ready New-Session Kickoff Prompt

```
You are picking up an intelligent document-extraction platform (Python 3.11, LangGraph,
FastAPI, Next.js) at d:/Repo/PDF. The ENTIRE existing codebase is the foundation — build
ON TOP of it; never propose a carve-out, separate repo, or rewrite. Read HANDOFF.md and the
CODEBASE MAP first.

We are adding two durable product capabilities:

PILLAR 1 — Managed Bedrock model layer: replace local backends (LM Studio/vLLM/Gemma) with a
Bedrock-only layer using ONE Converse API in us-east-1. Pass-1 primary vision = Qwen3-VL-235B
(qwen.qwen3-vl-235b-a22b, 256K ctx, max output 8K, In-Region only). Pass-2 verification +
reconciler arbitration + critic + RCA = Amazon Nova Pro (amazon.nova-pro-v1:0, us. geo profile
for burst, 300K ctx, tool-use, prompt caching ≤20K tokens/5-min TTL, native PDF block, ≤20 imgs
/3.75MB/8000px, ≤25MB else S3). Converse returns usage{inputTokens,outputTokens}+metrics{latencyMs};
tag every call via requestMetadata for per-tenant attribution; boto3 adaptive retries; TPM/RPM
quotas are the scaling limit; cost control = confidence-gated Pass-2 + Nova prompt caching;
tests use a FakeBedrockClient (no AWS in CI).

PILLAR 2 — Agent observability & self-healing: pluggable sinks behind ObservabilityDispatcher —
Splunk HEC (index=agent_telemetry, header 'Authorization: Splunk <token>') + OTel GenAI exporter
(gen_ai.provider.name=aws.bedrock, gen_ai.usage.*). Promote build_pass_span_attrs() to the
telemetry source-of-truth. Correlate app-plane (Converse spans) + infra-plane (Bedrock CloudWatch
TTFT/OTPS + model-invocation logs via Splunk Add-on for AWS) by trace_id + requestMetadata.
Agentic RCA copilot (Nova Pro) over Splunk MCP Server (app 7931, Bearer audience=mcp, tools
splunk_run_query[cap 1000 events/60s -> stats/timechart], splunk_get_metadata, etc.); Nova Pro
generates SPL itself, gated by a LOCAL SPL guardrail blocking |delete/|outputlookup/unbounded.
In-app self-healing PolicyEngine (model/region failover, quarantine degraded model, raise
human-review threshold, open ticket via existing webhook DLQ): AUTOMATIC in dev/staging,
HUMAN-APPROVED in prod; emit every action as telemetry.

LICENSE: target Apache-2.0; blocker = PyMuPDF/fitz is AGPL-3.0 (pyproject.toml:60) while repo
is Proprietary (pyproject.toml:10) — resolve by swapping fitz → pypdfium2 (Apache-2.0/BSD) at
the three call sites; prefer opencv-python-headless.

KEY SEAMS (verify on open):
- Bedrock backend: settings.py:79 (enum) + new BedrockBackendSettings; factory.py:55-65 branch +
  _build_bedrock_backend; new src/client/backends/bedrock_backend.py implementing VLMBackend
  (protocol.py:150); usage mapping in lm_client.py VisionResponse. CRITICAL: BaseAgent
  (base.py:164-188, 237-413, 416-595) bypasses the VLMBackend protocol and hard-codes
  LMStudioClient + backend_name="lm_studio" — must be refactored so role dispatch reaches the backend.
- Telemetry: observability.py:66 (_Sink) + from_settings():277; ObservabilitySettings settings.py:1120;
  promote build_pass_span_attrs() observability.py:436 (dead code) over ad-hoc dicts in base.py:380,
  orchestrator.py:733, critic.py:297; trace_id bridge audit.py:1434.
- RCA/self-healing: NODE_RCA after NODE_HUMAN_REVIEW (orchestrator.py:510); PolicyEngine in new
  src/agents/self_healing.py attached post-ROUTE (orchestrator.py:608); ticket via webhook_dlq.py:269.

START WITH: Phase A. Build FakeBedrockClient + unit tests first, then bedrock_backend.py, then the
factory wiring, then break the BaseAgent coupling. Run the boto3 Converse smoke test (HANDOFF.md §6.6)
and pytest. Do NOT call real AWS in CI. Keep everything product-framed.
```
