---
version: "1.0"
name: "Life OS — Quiet Control"
description: "A Persian-first personal operations workspace; evolve its violet identity through clear hierarchy and useful motion."
colors:
  background: "#111318"
  surface: "#191C24"
  raised: "#222632"
  text: "#F2F0F8"
  muted: "#A5ADBD"
  border: "#343B4C"
  accent: "#B5A5FF"
  success: "#94D8B7"
  warning: "#EDC38C"
  danger: "#FFADAD"
typography:
  body:
    fontFamily: "Vazirmatn, Tahoma, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.75
  heading:
    fontFamily: "Vazirmatn, Tahoma, Segoe UI, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.45
  label:
    fontFamily: "Vazirmatn, Tahoma, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.6
rounded:
  control: "9px"
  panel: "16px"
spacing:
  unit: "4px"
  section: "28px"
components:
  primaryButton:
    backgroundColor: "{colors.accent}"
    textColor: "#211A35"
    rounded: "{rounded.control}"
    minHeight: "38px"
    padding: "10px 16px"
---

## Overview

Life OS is a working tool, not a marketing page. Preserve its violet identity,
all real data semantics, and fast repeated interactions. The visual signature is
excellent Persian typography, a calm graphite/ivory canvas, restrained violet,
clear section rhythm, and compact readable operational surfaces.

## Colors

Dark uses the canonical values above. Light uses ivory `#F6F5F2`, white surface,
`#F0EFF5` raised, `#252330` text, `#625D71` muted and `#6F4BC3` accent.
Separate decorative dividers from control boundaries where contrast demands it.
Semantic colors always accompany a label/icon; green never implies a write was
acknowledged before the server confirms it. Unknown, estimated, pending, stale,
conflicted and confirmed remain distinct.

## Typography

Self-host the official unmodified Vazirmatn variable WOFF2 with its OFL notice.
Use native digit shaping; preserve exact financial values and tabular numerals.
Body 14px, metadata 12px, heading 24–28px. At most 11px for secondary grid
annotations; do not let dense views make primary titles or inputs tiny.
Large-text and density preferences remain functional. Persian line height is
1.7–1.8; English headings may use modest negative tracking, Persian never does.

## Layout

Desktop: persistent clear navigation, restrained topbar, useful main content.
Mobile: existing menu/bottom navigation, safe-area padding, no hidden actions.
Use logical CSS properties and start/end alignment. Do not reverse actual clock
axes or numerical data merely because the surrounding interface is RTL.
Sections align to a 4px rhythm, typically 16/24/28px spacing. Differentiate
working rows, panels and top-level sections instead of wrapping everything in
the same card. Working row settings apply to the whole current view.

## Elevation & Depth

Matte surfaces and subtle borders carry structure. Reserve stronger shadow for
popover/dialog/drag states. No decorative glass walls, background blobs,
perpetual gradients or repeated blurred panels.

## Shapes

Controls 9px, panels 16px, small tags 6px. Status pills can be rounded; do not
turn every control into a capsule. Use existing Lucide icon family consistently.

## Components

Buttons have distinct primary/secondary/danger/disabled/pending states and visible
keyboard focus. Desktop controls are at least 36px; touch controls at least 44px.
Fields retain labels, drafts, validation and focus across autosave. Radix owns
dialog focus trapping/restoration; animation must not remount focused content.
Tables expose readable headers and intentional local scrolling on small screens.
Empty states explain the next useful action; loading/error states stay honest.
Finance opens with actual line items visible, calendar retains source freshness
details, work limits retain contract versus personal-cap meaning.

## Motion

One motion language: quick 120ms, normal 180ms, panel 220ms, ease-out
`cubic-bezier(.22,1,.36,1)`. Exits are shorter. Use CSS for simple feedback and
Motion for React only for retargetable spatial relationships that earn its cost.
Animate opacity/transform; no blanket transition:all or permanent will-change.
No animated totals, typing, working-row stagger, route curtains or page remounts.
Never transform a calendar/work-grid coordinate ancestor. Cached views stay
instant. Respect both OS reduced-motion and the saved application preference;
disable displacement, layout and decorative motion while preserving state text.

## Do's and Don'ts

- Preserve task graph, completion gating, revision/conflict and audit semantics.
- Preserve calendar/read-only restrictions and work-time calculation semantics.
- Use current installed Next.js guides; never adopt private-router recipes.
- Review all ten primary screens, auth/public surfaces, two themes, RTL/LTR,
  compact/large-text/high-contrast and narrow touch layouts.
- Keep real screenshots/HTML, account identifiers and credentials outside Git.
- Installed media/3D/provider skills are conditional knowledge. Do not add heavy
  engines, external accounts or paid assets merely to demonstrate an installation.
- A screenshot comparison proves appearance; functional tests and live readback
  prove behavior. Neither a self-score nor a successful build proves completion.
