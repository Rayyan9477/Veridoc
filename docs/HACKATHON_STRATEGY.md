# 🏆 Veridoc: Winning Strategy for Google Cloud Rapid Agent Hackathon

**The pitch:** Healthcare runs on messy unstructured PDFs. Veridoc uses **Gemini 3's** multimodal prowess and **Google Cloud Agent Builder** to extract structured JSON with pinpoint bounding boxes. But the *winning edge* is our **Arize Phoenix MCP** integration, elevating Veridoc from a standard wrapper to an autonomous, self-improving AI worker. 

---

## 🚀 The "Mic Drop" Architecture

Instead of just "showing traces in a UI," our architecture actively *uses* observability data to heal itself and improve over time. 

### 1. "Zero-Shot to Prod" Autonomous Eval Loops
*   **The Problem:** Writing few-shot examples for messy medical docs is tedious.
*   **The Hackathon Solution:** 
    *   Start with a pure Zero-Shot prompt in **Agent Builder**.
    *   **Arize Phoenix** continuously evaluates extractions (e.g., checking for PHI redaction, valid CMS modifiers, or JSON schema adherence).
    *   When an extraction scores highly, it is automatically routed back into the Agent's context as a dynamic few-shot example for future runs.
    *   **Impact:** The agent writes its own training data. Zero-shot evolves into a highly-tuned production prompt completely autonomously.

### 2. Self-Healing Extraction via Phoenix MCP
*   **The Problem:** What happens when the model hallucinates a bounding box or misses a diagnosis code on a blurry fax? 
*   **The Hackathon Solution:**
    *   We don't just log the error; we *act* on it.
    *   If a validation step fails, the Agent uses the **Phoenix MCP** to query its own trace (`"Why did I fail?"`). 
    *   Retrieving the trace context, the Agent realizes: *"I missed the secondary diagnosis code because of a low-resolution scan artifact."*
    *   The Agent automatically initiates a retry, specifically targeting the failed spatial region with alternative extraction techniques.
    *   **Impact:** True autonomous resilience. The agent debugs its own extractions in real-time.

---

## 🎬 The Killer 3-Minute Video Demo Script

**[0:00 - 0:30] The Hook & The Headache**
*   *Visual:* A montage of heavily redacted, messy, handwritten, and faxed medical PDFs flashing on screen. 
*   *Voiceover:* "This is the $100 Billion healthcare administration nightmare. Unstructured, messy documents. Current OCR tools fail. Humans burn out. We built Veridoc to fix this using Google Cloud Agent Builder and Gemini 3."

**[0:30 - 1:15] The Magic (Standard Extraction)**
*   *Visual:* Veridoc UI. User drags and drops a complex invoice/medical record. INSTANTLY, clean JSON populates on the right, with precise bounding boxes overlaying the PDF on the left.
*   *Voiceover:* "With Gemini 3's native multimodal capabilities, Veridoc extracts complex nested JSON and exact spatial bounding boxes in seconds. No fragile OCR pipelines. Just pure intelligence."

**[1:15 - 2:00] The "Mic Drop" Moment (Self-Healing via MCP)**
*   *Visual:* We upload a purposefully degraded PDF. A red error flashes: `"Validation Failed: Missing CMS Modifier"`. 
*   *Voiceover:* "But in the real world, documents are terrible. Here, an extraction fails. But watch."
*   *Visual:* Terminal/UI speeds up. We see the Agent invoke the **Arize Phoenix MCP**. The Agent reads the trace, isolates the error, and automatically re-processes the specific cropped region. The red error turns green. 
*   *Voiceover:* "Using the Arize Phoenix MCP, Veridoc is *self-healing*. The agent queries its own execution trace, identifies the hallucination, and surgically re-extracts the missing data without human intervention."

**[2:00 - 2:40] The "Zero-Shot to Prod" Engine**
*   *Visual:* Split-screen showing the Agent Builder console and the Arize Phoenix dashboard. We see "Eval Scores" trending upward.
*   *Voiceover:* "It gets better. Every successful extraction graded by Phoenix is piped directly back into Agent Builder. Veridoc runs an autonomous 'Zero-Shot to Prod' loop, building its own few-shot examples and automatically tuning its performance over time."

**[2:40 - 3:00] The Close**
*   *Visual:* Veridoc logo, GitHub repo link, Google Cloud + Arize Phoenix logos.
*   *Voiceover:* "Open-source. Built on Google Cloud. Self-healing with Phoenix MCP. Veridoc isn't just extracting data; it's curing the healthcare document headache. Thank you."