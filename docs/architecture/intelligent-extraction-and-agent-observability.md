# Intelligent Document Extraction & Agent Observability — System Design

**Status:** Design (architecture only)
**Audience:** Engineering, Platform, Solution Architecture
**Scope:** Two enhancement pillars on the existing extraction platform — (1) a managed **AWS Bedrock model layer** with a cross-model dual-VLM topology, and (2) an **Agent Observability & Self-Healing** capability with a pluggable Splunk-first-class telemetry plane and an agentic RCA copilot.

---

## 1. Product Vision

Turn the extraction platform into a **self-observing, self-diagnosing document-intelligence system**. Two outcomes drive every decision:

1. **Trustworthy extractions at managed cost.** Two architecturally-independent vision models cross-check each other; the system spends a second model only when the first is uncertain.
2. **Operational truth in real time.** The pipeline streams its own agent telemetry to whatever observability backend the customer owns, and an agentic copilot turns anomalies into plain-language root-cause + remediation — reducing time-to-detect and time-to-resolve for silent model degradation.

**Why it matters (impact):** in high-stakes domains (e.g. healthcare RCM), a silently degraded VLM doesn't error — it produces subtly wrong fields that become mis-coded claims and downstream denials. Catching that within minutes, with attributable cost and provenance, is the difference between a demo-grade pipeline and a production system enterprises can run.

---

## 2. Current State → Target State

| Capability | Today | Enhancement |
|---|---|---|
| Model serving | Local backends (LM Studio / vLLM / Gemma) via `VLMBackend` factory | **Bedrock-only** managed layer; new `BedrockVLMBackend` (Converse API) |
| Vision topology | Dual-pass (primary/secondary) + critic, same-family models | **Cross-model** dual-VLM: Qwen3-VL primary, Nova Pro verify+critic → uncorrelated errors |
| Second-pass cost | Runs per configuration | **Confidence-gated** second pass + Nova prompt caching → controlled cost |
| Telemetry schema | `build_pass_span_attrs` canonical helper exists but is **unused (dead)** | Promote to the **single source of truth**; standardize attributes end-to-end |
| Observability sinks | Dispatcher + Phoenix + PostHog (off by default); Prometheus metrics | Add **SplunkHECSink (first-class)** + **OTel GenAI exporter**; all pluggable |
| Model telemetry | App logs only | **Two planes**: app-level Converse usage/latency/cost spans + infra-level Bedrock CloudWatch/invocation logs |
| Incident response | Manual dashboard reading | **Agentic RCA copilot** (detect→diagnose→recommend) over Splunk MCP |
| Remediation | Manual | **Policy-driven self-healing** (model/region failover, threshold raise, ticket) with guardrails |
| PHI handling | `PHIRedactor` post-extraction | Redact **before any telemetry egress**; Bedrock Guardrails on prompts/images |

Reused as-is: LangGraph orchestrator, `ExtractorPass1/2`, critic, reconciler, validator, provenance model, RBAC/multi-tenant, webhook DLQ, Next.js frontend, metrics registry.

---

## 3. Architecture (container view)

```
            ┌──────────────────────────────────────────────────────────────────┐
            │                       EXTRACTION PLATFORM                          │
  PDF ─────▶│  LangGraph: analyze → split → pass1 → pass2 → reconcile → critic   │
            │            → validate                                              │
            │     each node → ObservabilityDispatcher (single chokepoint)        │
            └───────┬───────────────────────────────────────────┬──────────────┘
                    │ Converse() (images, tool-use, streaming)    │ telemetry (spans/events/llm_call)
                    ▼                                             ▼
   ┌────────────────────────────────┐        ┌───────────────────────────────────────────┐
   │  AWS BEDROCK (serverless)       │        │  TELEMETRY PLANE (pluggable sinks)          │
   │  ┌──────────────────────────┐  │        │  ┌─────────┐ ┌──────────┐ ┌─────────────┐  │
   │  │ Qwen3-VL-235B  (pass1)    │  │        │  │ Splunk  │ │ OTel     │ │ Phoenix/    │  │
   │  │ qwen.qwen3-vl-235b-a22b   │  │        │  │ HEC     │ │ GenAI    │ │ PostHog/    │  │
   │  ├──────────────────────────┤  │        │  │ (1st-   │ │ exporter │ │ Prometheus  │  │
   │  │ Nova Pro (pass2 + critic │  │        │  │ class)  │ │          │ │             │  │
   │  │ + reasoning + RCA)       │  │        │  └────┬────┘ └────┬─────┘ └─────────────┘  │
   │  │ amazon.nova-pro-v1:0     │  │        └───────┼───────────┼──────────────────────────┘
   │  └──────────────────────────┘  │                │           │  (PHI-redacted before egress)
   │  Guardrails · retries · quotas  │                ▼           ▼
   └───────────────┬─────────────────┘        ┌──────────────────────────────┐
                   │ CloudWatch AWS/Bedrock     │ SPLUNK (Docker/Cloud)        │
                   │ metrics + invocation logs ─▶│ index=agent_telemetry        │
                   │ (Splunk Add-on for AWS /    │ + MCP Server (/services/mcp) │
                   │  Observability Cloud)       └───────────────┬──────────────┘
                   ▼                                             │ MCP (Bearer, aud=mcp)
            ┌───────────────────────────────────────────────────▼──────────────┐
            │  AGENTIC RCA COPILOT (Nova Pro)                                    │
            │   detect(anomaly) → get_metadata → gen SPL → [local SPL guardrail] │
            │   → run_query → get_knowledge_objects → RCA brief + recommendation │
            │   → POLICY ENGINE (self-heal: failover / threshold / ticket)       │
            └───────────────────────────────────────────────────────────────────┘
                   │ rca_completed + actions
                   ▼
            LIVE CONSOLE (Next.js): pipeline ▸ model-health panels ▸ RCA card + tool-trace
```

---

## 4. Pillar 1 — Bedrock Model Layer

### 4.1 Backend abstraction
- New `BedrockVLMBackend` implements the existing `VLMBackend` protocol so the factory and `ModelRouter` are unchanged conceptually; `settings.vlm.backend = "bedrock"` becomes the only production backend.
- **Single API: Bedrock `Converse`** for all models (uniform request/response, tool-use, guardrails, image + native PDF `document` blocks, and a normalized `usage{inputTokens,outputTokens}` + `metrics{latencyMs}` envelope). Streaming via `ConverseStream`.
- **Test double:** a `FakeBedrockClient` (records calls, returns canned `usage`/content) so unit tests and CI run with **no AWS dependency**.

### 4.2 Cross-model role mapping
| Role | Model | Model ID |
|---|---|---|
| Pass-1 primary vision | **Qwen3-VL-235B-A22B** | `qwen.qwen3-vl-235b-a22b` |
| Pass-2 verification (multimodal) | **Amazon Nova Pro** | `amazon.nova-pro-v1:0` (geo `us.`/`eu.` for burst) |
| Reconciler / Critic / RCA narration | **Amazon Nova Pro** | `amazon.nova-pro-v1:0` |
| Cheap triage/router (optional) | **Nova Lite** | `amazon.nova-lite-v1:0` |
| Hard-page adjudication (optional) | **Nova Premier** | (confirm ID on model card) |

Two different families ⇒ **uncorrelated errors**, which makes the existing `dual_pass_agreement` disagreement signal genuinely meaningful (not two correlated guesses). Roles are config-driven and swappable by model ID (Converse makes Pass-1↔Pass-2 an A/B flag to tune on labeled forms).

### 4.3 Structured output
Use Converse **tool-use** (`toolConfig` with a JSON `inputSchema`) to force schema-valid field extraction, replacing brittle prompt-only JSON. The existing schema-constrained path (`send_vision_request_with_schema`) maps cleanly to a tool spec.

### 4.4 Resilience & quotas (the real scaling constraint)
- **Adaptive retries** (boto3 `mode="adaptive"`, max 5) for `ThrottlingException` / `ModelTimeoutException` / `ServiceUnavailableException`.
- **Per-model, per-region serverless TPM/RPM quotas** are the scaling limit, not host capacity. Qwen3-VL is **In-Region only** (10 regions incl. us-east-1/2, us-west-2); Nova Pro supports **cross-region geo profiles** (`us.`/`eu.`) for burst. Design: primary region + Nova geo-profile burst + optional multi-region fan-out for Qwen on sustained throttle.
- **Circuit breaker** per model: on sustained throttle/error, trip to failover model/region and emit a telemetry event (feeds self-healing).

### 4.5 Cost governance
- **Confidence-gated second pass:** run Pass-2 (Nova Pro) only when Pass-1 confidence < threshold or a field-criticality rule fires — avoids doubling vision cost on every page.
- **Prompt caching (Nova):** cache the system + schema prompt (≤20K tokens, 5-min TTL) across pages of a document; surfaces `cacheReadInputTokens` for savings tracking.
- **Latency-optimized inference** available for Nova Pro where TTFT matters.
- **Per-call cost** computed from `usage` × per-1K price → emitted as telemetry and attributed per tenant via Converse `requestMetadata`.
- ⚠️ **Open item:** confirm Qwen3-VL-235B and Nova Premier per-token pricing on the live Bedrock pricing page before locking the gating thresholds (a 235B MoE can be materially pricier per token).

### 4.6 Security & media handling
- **IAM least-privilege** for `bedrock:InvokeModel`/`Converse` scoped to the chosen model IDs; no long-lived keys (use the configured AWS CLI/role chain).
- **Bedrock Guardrails** (`guardrailConfig` + per-block image `guardContent`) for PHI/PII and prompt-injection defense.
- **Image preprocessing** to Bedrock limits: downsample to ≤3.75 MB / ≤8000 px, ≤20 images/request; payloads >25 MB go via S3 `s3Location` instead of inline bytes.

---

## 5. Pillar 2 — Agent Observability & Self-Healing

### 5.1 Canonical telemetry contract
Promote `build_pass_span_attrs` to the **single source of truth** and emit it from every agent (today it's dead code). Standardized attributes (PHI-redacted), aligned to **OTel GenAI semantic conventions**:

| Field | OTel GenAI mapping | Source |
|---|---|---|
| `model_id` | `gen_ai.request.model` | Converse modelId |
| `tokens_in` / `tokens_out` | `gen_ai.usage.input_tokens` / `output_tokens` | Converse `usage` |
| `latency_ms`, `ttft_ms` | span duration / `gen_ai.server.time_to_first_token` | Converse `metrics` / stream |
| `provider` | `gen_ai.provider.name = aws.bedrock` | constant |
| `pass`, `role`, `page_number` | custom | pipeline |
| `trace_id`, `tenant_id`, `profile`, `document_type` | resource/span attrs | context |
| events | `critic_disagreed`, `human_review_triggered`, `model_failover`, `rca_completed` | pipeline |

### 5.2 Pluggable sink architecture
Behind the existing `ObservabilityDispatcher`:
- **SplunkHECSink** — first-class; PHI-redact → HEC POST to `index=agent_telemetry`; never raises.
- **OTel GenAI exporter** — OTLP spans/metrics with `gen_ai.*` attributes → any OTel backend (incl. Splunk Observability Cloud / AI Agent Monitoring).
- **Phoenix / PostHog / Prometheus** — retained.
- All sinks config-gated; the platform ships sink-agnostic and customers route to what they own.

### 5.3 Two telemetry planes (correlated)
1. **App plane (richest, cheapest):** per-call Converse `usage`+`metrics`+computed cost → OTel/HEC spans, tagged with `trace_id` + `requestMetadata`.
2. **Infra plane (fleet-wide, no code path):** Bedrock **CloudWatch `AWS/Bedrock`** metrics (`Invocations`, `InvocationLatency`, `Input/OutputTokenCount`, `InvocationThrottles`, **TTFT**, **OTPS**) + **model-invocation logs** (CloudWatch/S3) → Splunk via the **Splunk Add-on for AWS** or **Observability Cloud Bedrock integration** (CloudWatch Metric Streams → Firehose → Splunk for low latency).

Correlate the two planes on `requestMetadata` tags + `trace_id`.

### 5.4 Dashboards
- **Model health:** P95 latency, TTFT, OTPS, tokens, $ cost, throttle rate — by model & role.
- **Quality:** cross-model disagreement rate, confidence distribution, human-review rate, hallucination/validation failures.
- **Pipeline:** stage latency, queue depth, throughput, DLQ depth.
- **FinOps:** per-tenant / per-document cost, cache-hit savings.

### 5.5 Agentic RCA copilot
Triggered by an **anomaly detector** (latency spike, disagreement spike, throttle/cost surge) — we own the trigger for deterministic timing. Chain over **Splunk MCP** (`splunk_*` tools; SPL generated by **Nova Pro**, since AI-Assistant `saia_*` tools are cloud-gated):
1. `splunk_get_metadata` — scope the data landscape.
2. Nova Pro generates aggregate SPL.
3. **Local SPL guardrail** (our tool) — block `|delete`/`|outputlookup`/unbounded ranges before execution.
4. `splunk_run_query` — aggregate only (1000-event/60s cap → `stats`/`timechart`).
5. `splunk_get_knowledge_objects` — is there a prior alert for this signal?
6. Nova Pro composes an **RCA brief** + copy-paste remediation; emits `rca_completed`.

### 5.6 Policy-driven self-healing
MCP is read-only, so closed-loop actions run **in-app** via a policy engine the RCA feeds:
- **Auto-failover** model/region on sustained throttle or latency regression.
- **Auto-quarantine** a degraded model (route around it) + raise the human-review confidence threshold.
- **Open a ticket / notify** (webhook → existing DLQ-backed delivery).
- Each action is guardrailed (rate-limited, reversible, optionally human-approved) and itself emitted as telemetry → closes the observability loop.

---

## 6. Cross-Cutting Concerns
- **Security:** PHI redaction before any egress; Bedrock Guardrails; IAM least-priv; encrypted Splunk MCP token (`audience=mcp`) distinct from HEC token (`Authorization: Splunk …`).
- **Multi-tenancy:** `tenant_id` on every span + Converse `requestMetadata` → per-tenant cost, quota, and isolation.
- **Reliability:** adaptive retries, circuit breakers, model/region failover, existing webhook DLQ for downstream delivery.
- **Privacy posture:** data-residency via region pinning; "no third-party model provider" satisfied (Bedrock is first-party AWS).

---

## 7. Key Architecture Decisions

| # | Decision | Rationale | Trade-off |
|---|---|---|---|
| ADR-1 | Bedrock-only via **Converse** | uniform multimodal API, swap models by ID, managed scaling/SLA | hard AWS dependency; mitigated by `FakeBedrockClient` for tests |
| ADR-2 | **Cross-model** dual-VLM (Qwen3-VL + Nova Pro) | uncorrelated errors → meaningful disagreement signal | two vendors to track; mitigated by Converse uniformity |
| ADR-3 | **Confidence-gated** Pass-2 + prompt caching | controls the cost of running two VLMs | gating thresholds need tuning on labeled data |
| ADR-4 | **Pluggable sinks**, Splunk first-class + OTel | customers route to owned backends; vendor-neutral | more sink code; isolated behind dispatcher |
| ADR-5 | **Two telemetry planes** correlated by tags | app plane = rich/cheap; infra plane = fleet-wide truth | correlation keys must be disciplined |
| ADR-6 | **Local SPL guardrail** (ours, not a platform feature) | safe autonomous querying; honest labeling | small maintenance surface |
| ADR-7 | **Self-heal in-app**, RCA recommends | MCP is read-only; keeps actions guardrailed/reversible | policy engine is net-new |

---

## 8. Enhancement Roadmap (phased)

1. **Bedrock backend** (`BedrockVLMBackend` + Converse + `FakeBedrockClient` tests) — backend swap, role mapping.
2. **Telemetry standardization** — promote canonical schema; enrich tokens/latency/cost; OTel GenAI attributes.
3. **Splunk sink + dashboards** — HEC sink, `agent_telemetry` index, model-health/quality/FinOps dashboards; Bedrock CloudWatch ingest.
4. **Confidence-gating + cost controls** — gated Pass-2, prompt caching, per-tenant cost attribution.
5. **RCA copilot** — anomaly detector + MCP chain + SPL guardrail.
6. **Self-healing policy engine** — failover/quarantine/threshold/ticket with guardrails.
7. **Console** — live model-health + RCA surface in the existing Next.js app.

---

## 9. Open Items to Verify
- Exact **per-token pricing** for Qwen3-VL-235B and Nova Premier (live pricing page).
- Default **serverless TPM/RPM quotas** per model in the target region (Service Quotas console) → request increases early.
- AWS **region** confirmation (default `us-east-1`; both models In-Region there).
- **Self-healing autonomy level** (fully automatic vs. human-approved actions) per environment.
- Splunk Add-on for AWS explicit `AWS/Bedrock` namespace coverage in the deployed version.
