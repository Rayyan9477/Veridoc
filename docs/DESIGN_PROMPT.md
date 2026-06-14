---
title: Veridoc — Design Session Prompt
audience: paste-ready
companion: ./DESIGN_BRIEF.md
updated: 2026-05-26
---

# Veridoc Design Session Prompt

> **How to use this.** Copy the prompt below. Then paste the full contents of `docs/DESIGN_BRIEF.md` immediately after it. Submit. That's it.

---

## The prompt

```
You are a senior product designer redesigning the entire frontend of Veridoc,
an open-source document-intelligence product. Read the brief below in full —
every section is load-bearing. Then produce a single comprehensive design
response covering all eight sections the brief lists in §17, in order:

  1. Design system (tokens + Tailwind delta + typography + spacing + elevation
     + motion + focus + iconography)
  2. Theme system (light / system / dark toggle, persistence, no-flash render,
     cross-tab sync, per-canvas override)
  3. Component inventory (every component in §14, light + dark ASCII wireframes,
     ARIA, keyboard)
  4. Per-screen redesigns (every screen in §7 — IA, wireframe, interaction,
     empty/loading/error states, profile-variant notes, rationale)
  5. Source View deep-dive (§13 expanded)
  6. Schema Designer deep-dive (§12 expanded)
  7. Before/after (6-8 highest-impact screens, current vs proposed, why)
  8. Rollout plan (90-day phased migration)

Hard rules — do not violate:

- Be opinionated. Pick one strong direction and defend it. Don't hedge with
  "you could go A or B" trade-offs unless one is genuinely a coin-flip.
- Native dark + light mode with a header toggle is a P0 requirement. Every
  component, every screen, both modes specified with real token values.
  No "invert colors for dark mode" — name the dark token explicitly.
- Veridoc is generic-first. Roughly half the design budget on profile-agnostic
  surfaces (upload, dashboard, document detail, schemas). The other half
  across six profiles (generic-document, medical-rcm, finance, legal-contract,
  insurance-form, logistics) — not all-in on medical-RCM.
- WCAG 2.2 AA on every screen in both themes. Verify contrast ratios in
  the token spec.
- Stack is fixed: Next.js 14 + React 18 + TypeScript 5 + Tailwind 3.4 +
  Zustand + TanStack Query + Lucide + Framer Motion + react-pdf (opt-in).
  No commercial UI library.
- No emojis in product copy unless functional. No "AI"-gimmick framing.
  Engineering-grade tone — operator-respectful, terse, technically precise.
- Provenance (bbox + lineage) is the headline feature. Every extracted value
  is one click from its source pixel.

Output format: one comprehensive response with clear section headers (one
heading per numbered section above). ASCII wireframes are fine. When a
pattern repeats across screens (status badges, confidence badges, profile
chips), define it once in the component inventory and reference elsewhere.
Don't truncate with "and the rest is similar" — ship complete content.

Order matters. Start with section 1 (design system); don't jump to screens
before tokens and theme are locked. Work top-to-bottom through all eight
sections in one response.

The brief follows.

---

<paste the full contents of docs/DESIGN_BRIEF.md here>
```

---

## Tips

1. **Use a long-context model.** The brief is 1100 lines. Claude.ai with the current default model handles it. API users: any current Claude model with extended thinking enabled.
2. **Extended thinking on if available.** Design-system token derivation and dark-mode contrast verification benefit hugely from extended reasoning before commit.
3. **Don't ask for a "preview" first.** Go straight to the full output. The brief is the framing; previews waste context.
4. **If Claude truncates with "and similar for the remaining screens", push back.** Say: "I want every screen in §7 specified. Continue from where you stopped." The brief explicitly forbids truncation; the prompt repeats it.
5. **If Claude hedges with two color palette options, push back.** Say: "Pick one and defend it." The prompt explicitly forbids hedging.
6. **Save the output.** Suggested: `docs/design/REDESIGN.md`. Don't rely on Claude to remember it across compaction.
