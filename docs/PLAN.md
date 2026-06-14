# Veridoc EvidenceOps Agent + Schema Factory

## Summary
Build a judge-ready **EvidenceOps Agent** for document-heavy administrative work: Gemini extracts structured data from PDFs/images, links every answer to source pixels, asks Phoenix via MCP why the run succeeded or failed, improves the schema from trace/eval feedback, and exports an audit-ready evidence packet.

This directly matches the hackathon: functional web agent, Gemini + Google Cloud Agent Builder/ADK, partner MCP, hosted project, public open-source repo, and a real-world problem. The Arize track is the best fit because it explicitly rewards tracing, meaningful MCP use, evaluations, self-improvement, and impact. Sources: [Devpost overview](https://rapid-agent.devpost.com/), [rules](https://rapid-agent.devpost.com/rules), [Arize track](https://rapid-agent.devpost.com/details/arize-resources), [ADK docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/adk), [Phoenix MCP](https://arize.com/docs/phoenix/integrations/phoenix-mcp-server).

## Key Changes
- Build the submission as a **new hackathon module/workspace** inside the repo, not a generic continuation of old Veridoc:
  - name it `EvidenceOps Agent`
  - keep existing Veridoc primitives, but expose a newly created agentic workflow
  - make the “current repo predates contest” eligibility risk explicit in README
- Add `HACKATHON_MODE=true`:
  - require `VLM_BACKEND=gemini`
  - block LM Studio, Gemma, vLLM, Bedrock, OpenAI, and other non-Google AI runtimes
  - require Phoenix tracing/MCP configuration
  - fix license metadata so the public repo is visibly Apache 2.0
- Add a Gemini backend:
  - use Gemini structured outputs for extraction because Gemini supports JSON-schema outputs for data extraction and agent workflows
  - use Gemini function calling/tools for validation, review, export, and Phoenix trace inspection
  - use Gemini PDF/document understanding for direct document intake where practical, while preserving Veridoc’s page-image/provenance pipeline
- Add a code-owned Google ADK agent runtime:
  - deployable to Cloud Run or Agent Runtime
  - define MCP toolsets synchronously in `agent.py`, per ADK deployment guidance
  - agent tools: `create_evidence_run`, `get_evidence_run`, `inspect_source_bbox`, `propose_schema`, `run_schema_eval`, `inspect_phoenix_trace`, `record_review`, `export_packet`
- Make Phoenix visible in the product:
  - send ADK/Google GenAI traces using OpenInference instrumentation
  - connect `@arizeai/phoenix-mcp`
  - after every run, agent queries Phoenix MCP for trace/spans/eval results and writes a `TraceInsight`
  - show “why this field needs review” from trace evidence, not only confidence
- Add a durable Evidence Store:
  - persist extraction, page PNGs, provenance, confidence, validation, Phoenix trace ID, schema proposal/eval, human review decisions, export paths, and signed receipt metadata
  - replace the current broken list/detail/source-view path that depends on volatile checkpoints
- Add `/evidence` as the standout UI:
  - left: evidence runs
  - center: source document with bbox overlays
  - right: field inspector with confidence, validation, Phoenix trace insight, schema suggestion, review action, and packet export
  - no chatbot-first layout; the agent appears through task commands and trace-backed recommendations
- Add Schema Factory as the second act:
  - Gemini proposes/refines a schema from a sample document
  - run the proposed schema against the sample
  - Phoenix evals score coverage, hallucination risk, missing fields, tool-call correctness, and format adherence
  - save schema only after user approval

## Impact Angle
Use healthcare RCM/claims attachments as the main demo lane, because the impact is concrete and timely:
- CAQH reports a remaining **$21B** automation savings opportunity in healthcare administrative workflows.
- CAQH says attachments remain manual and burdensome.
- CMS finalized electronic health care claims attachment standards effective **May 26, 2026**, with compliance due 24 months later.
- MGMA reports denials are rising and often tied to insufficient documentation, eligibility, IDs, modifiers, and authorization issues.

Keep the product generic-first by also running an invoice sample through the same Schema Factory flow. Sources: [CAQH 2025 Index summary](https://www.dataspring.com/blog/2025-caqh-index-shows-u.s.-healthcare-avoided-258-billion-and-accelerated-automation-interoperability-and-ai-adoption), [CAQH attachments](https://www.dataspring.com/core/additional-medical-documentationattachments), [CMS claims attachments rule](https://www.cms.gov/newsroom/fact-sheets/administrative-simplification-adoption-standards-health-care-claims-attachments-transactions), [MGMA denials](https://www.mgma.com/mgma-stat/strategic-improvements-in-your-rcm-to-reduce-your-practices-claim-denials).

## Test Plan
- Unit:
  - mocked Gemini backend for structured output, tool calls, retries, health, and error handling
  - `HACKATHON_MODE` rejects non-Google AI backends
  - Evidence Store persists page images, provenance, trace IDs, schema evals, and packet metadata
- API:
  - create/list/get evidence runs
  - retrieve durable page images and provenance
  - record review decisions
  - export packet with trace summary and signed receipt
- Frontend:
  - `/evidence` empty/loading/failed/completed/review-needed states
  - bbox click sync between fields and source page
  - Phoenix trace insight panel renders actionable causes
  - schema proposal/test/save flow works
- Acceptance:
  - run one CMS-1500 and one invoice
  - Gemini is the only AI backend
  - Phoenix receives traces
  - Phoenix MCP result is saved into the evidence run
  - low-confidence/failed-validation fields route to review
  - evidence packet verifies offline

## Assumptions
- Submit to the Arize track.
- Prioritize judge-ready core over moonshot breadth.
- Do not spend implementation time on video planning.
- Keep existing Veridoc UI mostly intact; build the winning surface as `/evidence`.
- Use current repo with explicit eligibility-risk disclosure rather than pretending it was newly created.
