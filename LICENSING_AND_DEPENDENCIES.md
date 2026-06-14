# LICENSING_AND_DEPENDENCIES.md

> **Disclaimer:** This document is engineering guidance, not legal advice. Confirm any licensing decision with qualified counsel before a public release or distribution.

## 1. Scope

This analysis applies to the **entire codebase at `d:/Repo/PDF`** — the document-extraction platform (Python 3.11, LangGraph, FastAPI, Next.js) is being enhanced *in place*. There is no carve-out, sub-package, or separate repository that isolates any one dependency. Consequently, the license terms of **every** runtime dependency in `pyproject.toml` attach to the whole repository, and a copyleft (AGPL) dependency contaminates the whole surface — not just the module that imports it.

Two facts frame everything below:

- `pyproject.toml:10` declares `license = {text = "Proprietary"}` (and classifier `License :: Other/Proprietary License` at `:18`).
- `pyproject.toml:60` declares `PyMuPDF>=1.25.0`, which ships under **AGPL-3.0** (PyMuPDF/`fitz` is dual-licensed: AGPL-3.0 OR a paid Artifex commercial license).

These two declarations are mutually inconsistent for any form of distribution. This is the central blocker.

> Note: the repository root already contains a full **Apache License 2.0** `LICENSE` file, while `pyproject.toml:10` still declares `Proprietary` — these disagree and must be reconciled (see §7, action item 4). The Apache-2.0 `LICENSE` is the intended target.

---

## 2. Recommended License: Apache-2.0

For any public release of this codebase, **adopt Apache License 2.0** and change `pyproject.toml:10` from `Proprietary` to `Apache-2.0` (with classifier `License :: OSI Approved :: Apache Software License`).

### Rationale

1. **Patent grant.** Apache-2.0 includes an explicit, irrevocable patent license from contributors (§3) and a patent-retaliation termination clause. For a platform that integrates ML/VLM pipelines, medical-code validation, and bbox/provenance algorithms, an express patent grant is materially more protective than MIT/BSD (which are silent on patents).
2. **Permissive, ecosystem-compatible.** Apache-2.0 is one-way compatible with GPLv3 and is the de-facto standard for the platform's own dependency stack (LangChain, LangGraph, FastAPI, Pydantic, OpenTelemetry, boto3 — all Apache-2.0 or MIT/BSD). No new copyleft obligations are introduced by adopting it.
3. **Contribution clarity (§5) and NOTICE handling (§4).** Apache-2.0 defines how contributions are licensed and requires preserving a `NOTICE` file — useful for an enterprise/medical product that must track attribution cleanly.
4. **Trademark hygiene (§6).** Apache-2.0 explicitly does *not* grant trademark rights, which keeps product naming under the owner's control.
5. **No AGPL viral exposure** — *provided the PyMuPDF blocker in §3 is resolved first.* Apache-2.0 cannot legally subsume an AGPL dependency; the AGPL component must be removed or replaced regardless of the chosen project license.

### License comparison

| License | Type | Patent grant | Copyleft / network clause | NOTICE/attribution req. | Fit for this repo |
|---|---|---|---|---|---|
| **Apache-2.0** | Permissive | **Yes (explicit, §3)** | None | NOTICE file required | **Recommended** — patent grant + ecosystem standard |
| MIT | Permissive | No (implicit at best) | None | Copyright + license text | Viable, but no explicit patent grant |
| BSD-2/3-Clause | Permissive | No | None | Copyright + license text; BSD-3 adds no-endorsement | Viable; equivalent to MIT, no patent grant |
| MPL-2.0 | Weak/file-level copyleft | Yes | Per-file copyleft (modified MPL files must stay MPL) | Per-file | Workable but adds file-level obligations with no benefit here |
| AGPL-3.0 | Strong copyleft | Yes | **Yes — network-use triggers source disclosure** | Full source disclosure | **Not recommended** — forces source release for any networked SaaS use |

> Bottom line: Apache-2.0 gives the strongest permissive posture (patent grant + standardized attribution) without copyleft obligations. MIT/BSD are acceptable fallbacks but weaker on patents. MPL-2.0 and AGPL-3.0 add obligations with no upside for this product.

---

## 3. BLOCKER — PyMuPDF (`fitz`) is AGPL-3.0

### 3.1 The conflict

PyMuPDF (`pip` name `PyMuPDF`, import name `fitz`) is distributed under **AGPL-3.0** unless a separate commercial license is purchased from Artifex. AGPL-3.0 is the strongest copyleft license in common use:

- **GPL-style distribution clause:** distributing software that links PyMuPDF requires offering the *entire combined work's* corresponding source under AGPL-3.0.
- **Network/SaaS clause (the AGPL §13 distinction):** even if the software is *never distributed as a binary* but merely *operated as a network service* (which is exactly how this platform runs — FastAPI on port 8000, Next.js on 3000, served to users over HTTP), AGPL-3.0 requires that all users interacting with it over the network be offered the complete corresponding source of the whole application.

### 3.2 Why it breaks both states

- **Against the current `Proprietary` declaration (`pyproject.toml:10`):** A proprietary license cannot coexist with an AGPL dependency that is linked/imported into the same process. The repo *as currently declared* is internally contradictory — it claims proprietary rights over a work that incorporates AGPL code, which the AGPL does not permit unless the whole work is released under AGPL or a commercial PyMuPDF license is held.
- **Against a public Apache-2.0 release:** Apache-2.0 is incompatible with AGPL-3.0's copyleft. Publishing the repo under Apache-2.0 *with* PyMuPDF still bundled would be a license violation. The AGPL terms would override and force the whole repo to AGPL — defeating the permissive-license goal.

Because the **entire codebase** is in scope (no carve-out), this applies repo-wide: the AGPL obligation is not confined to `pdf_processor.py` or `runner.py`; it attaches to the served application as a whole.

### 3.3 Exact `fitz` usage sites (from the codebase map)

There are **three** `fitz` call sites that must be addressed:

| # | Location | Nature | Function |
|---|---|---|---|
| 1 | `src/preprocessing/pdf_processor.py:21` | **Unconditional top-level** `import fitz` | `PDFProcessor.render_page()` / `process()` — `fitz.Matrix(zoom)`, `page.get_pixmap()`, `pixmap.tobytes("png")`, `_inspect_image_streams` (fax CCITT/JBIG2 detection) |
| 2 | `src/pipeline/runner.py:404` | Lazy `import fitz` inside `_load_and_convert_pdf()` | `fitz.open()`, `fitz.Matrix(scale)`, `page.get_pixmap()`, `pixmap.tobytes("png")`, `page.get_text("text")` |
| 3 | `src/pipeline/runner.py:533` | Lazy `import fitz` inside `_convert_pdf_bytes_to_images()` | `fitz.open(stream=, filetype="pdf")` PDF-from-bytes rasterization |

(Supporting reference: `tool.mypy.overrides` at `pyproject.toml:347-359` already lists `fitz.*` under `ignore_missing_imports`.)

### 3.4 Resolution options

**Resolution A — Exclude `fitz` from the public surface.**
Keep PyMuPDF only behind a separately-licensed, non-distributed service boundary (e.g., an internal rasterization microservice the public repo calls over a network API), and ship the public repo with PyMuPDF removed from `pyproject.toml` core deps. Practical only if the org holds an Artifex commercial PyMuPDF license for that boundary, or if the boundary is never distributed. Fragile for an open-source release because the *public* code path still expects PDF rasterization — users would hit a missing dependency. **Acceptable only as an interim/internal measure, not for a clean public release.**

**Resolution B — Swap rasterization to `pypdfium2` (RECOMMENDED).**
Replace PyMuPDF with **`pypdfium2`** (Apache-2.0 / BSD-3-Clause; wraps Google's PDFium). This removes the AGPL dependency entirely and makes the whole repo Apache-2.0-clean.
- Replace all three sites in §3.3:
  - `pdf_processor.py:21` — remove `import fitz`; use `pypdfium2.PdfDocument`.
  - `runner.py:404` and `runner.py:533` — `pdfium.PdfDocument(path)` / `PdfDocument(byte_stream)`; render via `page.render(scale=...)` → PIL image → PNG bytes.
- Mapping notes: `fitz.Matrix(zoom)` → `pypdfium2` `scale` argument; `page.get_pixmap().tobytes("png")` → `page.render(scale).to_pil()` then `Image.save(buf, "PNG")`; `page.get_text("text")` → `page.get_textpage().get_text_range()`.
- Caveat: `pypdfium2` does not expose PyMuPDF's raw image-stream metadata (`_inspect_image_streams` CCITT/JBIG2/1-bit fax detection in `pdf_processor.py`). That fax-modality signal must be re-derived from the rendered raster (the existing OpenCV path in `image_enhancer.py` already detects fax characteristics) or from `pikepdf`/`pdfminer` (both permissive) if stream-level inspection is still required.
- Update `pyproject.toml:60` (`PyMuPDF>=1.25.0` → `pypdfium2>=4.30.0`) and the `tool.mypy.overrides` block (`fitz.*` → `pypdfium2.*`).

**Resolution C — Adopt AGPL-3.0 for the whole repo (NOT RECOMMENDED).**
Keep PyMuPDF and relicense the entire codebase to AGPL-3.0. This is legally consistent but defeats the goal: AGPL's network clause would obligate the org to publish the full corresponding source of the served application to every user who interacts with the FastAPI/Next.js endpoints, and would prevent downstream proprietary or permissive reuse. Rejected.

> **Decision: Resolution B.** It is the only option that yields a clean, distributable, Apache-2.0-compatible repository with no copyleft residue and no commercial-license dependency.

---

## 4. Dependency License Posture (core runtime deps in `pyproject.toml`)

License identifications below are the commonly-published licenses for these packages; verify exact SPDX strings at the pinned versions during the audit (§7, action item 7).

| Dependency (pyproject line) | Typical License | Posture | Notes |
|---|---|---|---|
| `langchain` / `langchain-core` / `langchain-community` / `langchain-openai` (`:40-43`) | MIT | OK | Permissive |
| `langgraph` / `langgraph-checkpoint` / `langgraph-checkpoint-sqlite` (`:44-47`) | MIT | OK | Permissive |
| `mem0ai` (`:50`) | Apache-2.0 | OK | Permissive |
| `faiss-cpu` (`:51`) / `faiss-gpu` (`:129`, `gpu` extra) | MIT | OK | Permissive |
| `sentence-transformers` (`:52`) | Apache-2.0 | OK | Permissive |
| `openai` (`:55`) | Apache-2.0 | OK | SDK only |
| `tenacity` (`:56`) | Apache-2.0 | OK | |
| `httpx` (`:57`) | BSD-3-Clause | OK | |
| **`PyMuPDF` (`:60`)** | **AGPL-3.0** | **BLOCKER** | See §3 — replace with `pypdfium2` |
| `Pillow` (`:61`) | MIT-CMU (HPND) | OK | Permissive |
| **`opencv-python` (`:62`)** | Apache-2.0 (code) | **Caution** | License OK, but use `-headless` variant — see §5 |
| `numpy` (`:63`) | BSD-3-Clause | OK | |
| `scikit-learn` (`:64`) | BSD-3-Clause | OK | |
| `python-docx` (`:68`) | MIT | OK | |
| `pydicom` (`:69`) | MIT | OK | |
| `pydantic` / `pydantic-settings` (`:72-73`) | MIT | OK | |
| `fastapi` (`:76`) | MIT | OK | |
| `uvicorn[standard]` (`:77`) | BSD-3-Clause | OK | transitive `[standard]` extras are permissive |
| `python-multipart` (`:78`) | Apache-2.0 | OK | |
| `starlette` (`:79`) | BSD-3-Clause | OK | |
| `celery` (`:82`) | BSD-3-Clause | OK | |
| `kombu` (`:83`) | BSD-3-Clause | OK | |
| `redis` (`:84`) | MIT | OK | client library |
| `cryptography` (`:87`) | Apache-2.0 OR BSD-3 (dual) | OK | |
| `python-jose[cryptography]` (`:88`) | MIT | OK | |
| `passlib[bcrypt]` (`:89`) | BSD-2-Clause | OK | |
| `bcrypt` (`:90`) | Apache-2.0 | OK | |
| `openpyxl` (`:93`) | MIT | OK | |
| `pandas` (`:94`) | BSD-3-Clause | OK | |
| `xlsxwriter` (`:95`) | BSD-2-Clause | OK | |
| **`streamlit` / `streamlit-extras` (`:98-99`)** | Apache-2.0 | OK (review) | Permissive, but heavy; confirm it is still required vs. the Next.js frontend |
| `prometheus-client` (`:102`) | Apache-2.0 | OK | |
| `structlog` (`:103`) | Apache-2.0 OR MIT (dual) | OK | |
| `python-json-logger` (`:104`) | BSD-2-Clause | OK | |
| `python-dotenv` (`:107`) | BSD-3-Clause | OK | |
| `pyyaml` (`:108`) | MIT | OK | |

### Optional-extra groups

| Extra (line) | Dependency | Typical License | Posture |
|---|---|---|---|
| `dev` (`:112-126`) | pytest, black, ruff, mypy, isort, bandit, safety, etc. | MIT / BSD / Apache-2.0 | OK (not shipped at runtime) |
| `phi` (`:135-138`) | `transformers` (Apache-2.0), `torch` (BSD-3-Clause) | Permissive | OK; **note model weights are licensed separately** from the libraries |
| `observability` (`:142-149`) | `arize-phoenix` (Elastic-2.0 — review), `openinference-instrumentation-*` (Apache-2.0), `opentelemetry-api/sdk` (Apache-2.0), `posthog` (MIT) | Mixed | **Caution:** Arize Phoenix is **Elastic License 2.0** (source-available, not OSI-approved). Restricts offering Phoenix itself as a managed service. Confirm acceptable; it is an opt-in dev/observability extra, not core runtime. |
| `fhir` (`:152-154`) | `fhir.resources` | MIT | OK; opt-in |
| `vlm-server` (`:160-163`) | `vllm` (Apache-2.0), `xgrammar` (Apache-2.0) | Permissive | OK; opt-in, GPU-host only. Note: the Bedrock enhancement removes the runtime need for local vLLM, so this extra may be deprecated. |

> **Net:** With PyMuPDF resolved (§3), every **core** runtime dependency is permissive (MIT/BSD/Apache-2.0/HPND) and compatible with an Apache-2.0 release. The only remaining items to review are the `observability` extra (Arize Phoenix is Elastic-2.0, source-available) and the model **weights** pulled by the `phi` extra (licensed independently of the Python packages).

---

## 5. `opencv-python` → `opencv-python-headless`

`pyproject.toml:62` declares `opencv-python>=4.10.0`. The OpenCV *code* is Apache-2.0 (no license problem), but the `opencv-python` wheel bundles GUI runtime dependencies (GTK/Qt/X11 highgui). On headless servers and in containers — which is the platform's actual deployment target (FastAPI/Celery workers, no display) — those GUI libs are dead weight and a frequent source of missing-`.so` runtime failures.

**Action:** swap `opencv-python>=4.10.0` → `opencv-python-headless>=4.10.0`. The two are drop-in API-compatible for the operations used in `src/preprocessing/image_enhancer.py` and `src/pipeline/runner.py` (deskew, denoise, CLAHE, binarization, morphology, connected components, `cv2.Laplacian`). Do **not** install both — they conflict.

---

## 6. AWS Bedrock Models — Service, Not a Redistributed Dependency

The Bedrock enhancement pillar replaces local backends (LM Studio / vLLM / Gemma) with the **Amazon Bedrock Converse API** (Qwen3-VL-235B as Pass-1 primary; Amazon Nova Pro as Pass-2/critic/reconciler/RCA). This has **no effect on the repository's source-code license**:

- The models (`qwen.qwen3-vl-235b-a22b`, `amazon.nova-pro-v1:0`) are accessed **as a managed network service** via the AWS SDK. **No model weights are vendored, redistributed, fine-tuned, or embedded** in this repo. Model use is governed by the **AWS Customer Agreement / AWS Service Terms** and the per-model EULAs surfaced in the Bedrock console (e.g., Amazon's service terms for Nova; the Qwen model provider's Bedrock terms) — these are *usage* terms between the operator and AWS, not *distribution* terms on this codebase.
- The only code-level addition is `boto3` (Apache-2.0) plus a new `BedrockVLMBackend` implementing the existing `VLMBackend` protocol. **`boto3` must be added** to `pyproject.toml` (and a `bedrock`/`aws` extra is the natural home). It is permissive and Apache-2.0-clean.
- Generated outputs (extracted fields) are owned/used per the AWS Service Terms; that is an operational/contractual matter, independent of the repo's OSS license.

> Summary: Bedrock keeps the repo's distribution-license story clean — there is nothing copyleft, nothing redistributed. The obligations are AWS *account-level service terms*, not source obligations.

---

## 7. Action Items

1. **Resolve the PyMuPDF blocker (Resolution B).** Replace `fitz` with `pypdfium2` at all three sites: `src/preprocessing/pdf_processor.py:21`, `src/pipeline/runner.py:404`, `src/pipeline/runner.py:533`. Re-derive the fax-modality stream signal (CCITT/JBIG2/1-bit) from the rendered raster or via permissive `pikepdf`/`pdfminer`.
2. **Update `pyproject.toml` deps:** `PyMuPDF>=1.25.0` → `pypdfium2>=4.30.0` (`:60`); `opencv-python>=4.10.0` → `opencv-python-headless>=4.10.0` (`:62`); update `tool.mypy.overrides` (`fitz.*` → `pypdfium2.*`, `:347-359`).
3. **Add `boto3`** (Apache-2.0) to dependencies for the Bedrock backend — recommend a dedicated `bedrock`/`aws` optional-extra plus `botocore`.
4. **Reconcile the project license** at `pyproject.toml:10` from `{text = "Proprietary"}` to `{text = "Apache-2.0"}` and update the classifier at `:18` to `License :: OSI Approved :: Apache Software License` (the root `LICENSE` is already Apache-2.0) — **only after step 1 lands**.
5. **Confirm license artifacts at the repo root:** `LICENSE` (full Apache-2.0 text — already present) and a `NOTICE` file (Apache-2.0 §4 attribution; list third-party notices, including PDFium/pypdfium2 and any required attributions).
6. **Review the `observability` extra:** confirm Arize Phoenix's Elastic License 2.0 (source-available, not OSI) is acceptable as an opt-in extra; document that it is not part of the core permissive surface. The OTel/OpenInference/PostHog members are permissive and fine.
7. **Run an automated license audit** in CI (e.g., `pip-licenses` / the existing `safety` dev dep) over the *full resolved transitive tree* — not just direct deps — and fail the build on any GPL/AGPL/LGPL/SSPL/Elastic/BSL hit. Pin the SPDX identifiers per dependency at the locked versions.
8. **Verify model weights vs. libraries:** for the `phi` extra (`transformers`/`torch`), document that any HuggingFace model weights downloaded at runtime (e.g., the redactor model) carry **their own licenses**, independent of the Apache-2.0 library code, and must be vetted separately before bundling or air-gapped distribution.
9. **Confirm Streamlit necessity:** if the Next.js frontend is the product UI, evaluate dropping `streamlit`/`streamlit-extras` (`:98-99`) to shrink the dependency and attribution surface.

---

**Output paths referenced:** `d:/Repo/PDF/pyproject.toml`, `d:/Repo/PDF/src/preprocessing/pdf_processor.py`, `d:/Repo/PDF/src/pipeline/runner.py`, `d:/Repo/PDF/src/preprocessing/image_enhancer.py`.
