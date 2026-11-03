# Life OS motion implementation contract

Scope: the shared UI, navigation, lists, dialogs, dense Persian RTL data screens and their verification. This contract distills all 36 core SKILL bodies, read in full. Original sources remain unchanged in the project-local source installation. Their recipes disagree in places; this document resolves those differences for this product.

## Product direction and authority

Life OS is an **Operate** surface: calm, clear, quick and dependable. Preserve its existing visual identity, Persian typography, RTL behavior and light/dark themes. Improve hierarchy, precision, responsive behavior and feedback. Treat decorative video, 3D, physics rigs and launch-film skills as conditional knowledge for separate synthetic demonstrations, not required app dependencies.

The user's authorization to complete the overhaul without questions and the project engineering contract override source instructions that ask to stop, require a marketing service, overwrite AGENTS.md, introduce a library or change the framework. Installed knowledge does not establish provider authentication or runtime capability.

## Shared controls

- Extend the existing duration, easing, spacing, radius, typography and color tokens; do not import a second provider's global token system.
- Where no motion token exists, the fallback palette is: pointer micro-feedback **120 ms**; short state feedback **160 ms**; occasional surface entrance **200 ms**; large drawer entrance **240 ms**; dismissal **150 ms**; reduced-motion opacity feedback **100 ms** or an immediate static change. These are defaults, not reasons to animate an ineligible action.
- Use the existing easing token. If absent, enter/exit with `cubic-bezier(0.23, 1, 0.32, 1)` and actual within-view movement with `cubic-bezier(0.77, 0, 0.175, 1)`. Reserve linear for determinate progress or essential loading motion. No slow-start `ease-in` for routine Life OS feedback.
- Immediate native press/hover/selected/focus states are the baseline. A scale effect is optional, not a requirement on every button. Never scale disabled controls. Do not add row lift, magnetic hover, glare, blur, ripples or bouncing toggles to dense working surfaces.
- Use semantic controls and existing accessible primitives. Preserve labels, error descriptions, disabled/busy state, focus visibility, touch targets and keyboard operation. A visual redesign cannot silently change mutation behavior.
- Icons use the existing library and `currentColor`. Mirror only directional icons in RTL; never mirror checks, clocks, currency, logos or non-directional symbols. Keep financial/time numerals legible and aligned with tabular figures.
- Do not transfer Latin display-letterspacing prescriptions to joined Persian text. Keep the app's Persian font and sufficient line-height for diacritics.
- Keep structural borders on inputs, tables and selected/focus states. A transparent border or suitable system-color fallback must retain structure in forced-colors mode when shadows disappear.

## Lists, hierarchy and functional data

- Task checkboxes, keyboard menus, row navigation, search typing, fast filters, date selection and routine task edits respond immediately. No routine list stagger, replay on refresh, count-up from zero, page-entry cascade or animated currency/timesheet figures.
- Motion never hides the full value of an amount, total, time or date. Long task titles and mixed RTL/LTR identifiers must leave the action controls reachable. Use shrinking text tracks (`min-width: 0` / `minmax(0, 1fr)`), fixed action/icon tracks and field-specific wrapping instead of clipping the whole row.
- Preserve stable row identity, drafts, cursor/selection, scroll position, expanded groups and the shared settings for each view. Do not key an editable row by animation state or remount a whole table to animate it.
- Collapse/expand changes actual accessible state immediately. Keep `aria-expanded` and `aria-controls` correct; hidden descendants must not remain keyboard-focusable. If focus is inside a group being collapsed, move it predictably to its trigger. Collapsing all groups must not trigger hundreds of overlapping animations.
- A small accordion may use a short height/grid-track transition as an explicit, measured exception. It is **layout work**, not a compositor-only guarantee. Keep padding on the inner content, avoid text scaling, and keep the control usable when the animation is absent or interrupted. Instant collapse is appropriate for large trees.
- A justified, infrequent add/remove bridge may fade a small group without delaying input. Gestures require click/keyboard alternatives; a drag-only reorder is incomplete.

## Dialogs, drawers, popovers and feedback

- Reuse the existing dialog/popover lifecycle, portals, focus trapping, Escape/dismissal and focus return. Do not replace a primitive with a styled `div` or introduce animation timers as a new source of truth.
- Preserve editable content throughout open/close transitions. Closing a surface must not discard an unsaved draft or race the completion of a save. Exiting UI cannot delay domain writes or pretend a pending network change succeeded.
- A centered dialog stays centered; apply entrance motion to a separate inner layer if its positioning already uses transforms. Anchored popovers originate at their actual trigger. Drawers enter/exit the same logical edge, correctly reflected in RTL.
- Rare pointer-opened surfaces may use a small scale (`0.97` to `1`) and opacity; large drawers may translate. Avoid scale-from-zero, viewport-sized zoom or an animated full-page backdrop blur.
- Do not queue open/close keyframe sequences. State-driven CSS transitions retarget from the current value. Use a spring only when an existing direct-manipulation interaction needs velocity/continuity; keep it well damped and retain pointer capture/cancel handling.
- Feedback has a stable static label or icon for pending, confirmed, error and conflict. Motion/color cannot be the only meaning. Reuse one app-level toast host and stable update IDs; do not duplicate toasters per route or fire duplicate effects under Strict Mode.
- Tooltips wait for initial intent, then neighboring hints open promptly. Dismissal is immediate. Tooltips must also work from focus and cannot contain the only copy of essential instructions.
- Loading UI preserves layout; cached content does not flash a skeleton on return. Do not manufacture wait time for a spinner or a success animation. Errors remain readable long enough to act on them.

## Navigation and theme

- Routine application navigation is instant. Preserve existing loading boundaries, streaming behavior, history, anchor/link semantics and focus. No curtain, cinematic route wipe, artificial navigation delay or recurring entrance animation.
- Do **not** adopt the source FrozenRouter recipe or import private `next/dist/...` router contexts. Consult this project's installed Next guides before any framework-specific change. A remounting template is not a persistent exit boundary.
- Existing theme switching must not animate every color in the document simultaneously. Suppress incidental transitions during the theme swap; retain focus and the chosen theme. Do not add a full-screen color wash or asynchronous theme flash.

## Reduced motion and input capabilities

- Prefer static, visible HTML/CSS by default; opt displacement/scale/blur into `prefers-reduced-motion: no-preference`. Under reduce, remove large movement, parallax, spatial springs, decorative loops and smooth-scroll effects. Keep understandable labels, focus, layout and modest opacity feedback.
- Do not set `transform: none` indiscriminately on positioned dialogs or icons: a transform may be essential geometry rather than animation. Remove the motion component without breaking layout.
- Do not rely solely on a universal `0.01 ms !important` reset. Blanket resets can erase meaningful loading feedback or conflict with more intentional overrides; explicit component fallbacks must work. If timing callbacks exist, remove their dependency on a visible animation rather than trusting an event that may not fire.
- SSR must not read `window`, `document` or `matchMedia` unguarded during render. Keep server/client initial markup consistent. For JS-driven motion, subscribe to preference changes with cleanup and a safe SSR strategy; CSS should already protect the initial reduced-motion frame.
- Gate hover-only effects with actual capabilities (`hover: hover`, with `pointer: fine` where precision matters). Touch and mouse may coexist; do not sniff user agents. Preserve zoom, selection of content and native scrolling.
- Mobile shell/drawers use appropriate dynamic viewport and safe-area treatment; inputs remain readable without focus zoom. Do not disable pinch zoom. Apply `touch-action` only to surfaces that own the gesture, not to the whole scrolling page.
- More contrast, reduced transparency and forced-colors modes must keep readable, well-separated surfaces. Blur is optional material, never a prerequisite for contrast.

## Performance and verification

- Default animated properties are **transform and opacity**. Name them explicitly; no `transition: all`. Keep blur and shadow animation off large surfaces. Do not animate an inherited CSS variable to move a container with many descendants.
- Batch geometry reads before writes. Do not read layout per row per frame, update React state every animation frame, poll scroll continuously or leave an rAF loop running after settling/unmount.
- CSS/WAAPI can offload suitable animations, but browser acceleration is conditional. Do not claim guaranteed GPU execution from the property name. Grid/height animation and shared-layout calculations still need measurement.
- `will-change` is a narrowly measured remedy, not a global optimization. Remove stale promotion and listeners. Do not add a new motion, canvas or physics library for a fade.
- Verify actual changed interactions with synthetic long Persian and mixed-direction titles, missing fields, zero/one/many rows, large values, 320 px/narrow layout, 200% zoom, light/dark, keyboard, pointer/touch emulation and reduced motion. Test state reversal and draft preservation. Do not add broad mirrored tests for a trivial visual edit.
- Screenshots prove settled appearance, not frame pacing. A performance claim needs a trace/recording; physical touch and device-specific safe-area/keyboard behavior remain unverified without hardware. State those limits accurately.

## Reconciliation of source disagreements

| Source prescription                                                      | Life OS decision                                                                                                                 |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Always stagger every group; 400–800 ms reveals                           | Reject on working lists and navigation. Limited ceremony belongs to separate onboarding/demo content.                            |
| Exit with ease-in; fixed 350–500 ms surface timings                      | Use existing Life OS tokens and responsive ease-out; normal UI stays below 300 ms.                                               |
| Every interaction must be a physics model                                | Retain as specialized exploration. Ordinary UI uses cheaper native CSS state feedback.                                           |
| Every hover must glide/tilt/lift                                         | Dense rows remain stable. Do not replace the stack or add a shared animated hover system merely to use a skill.                  |
| Blur/motion-blur package is compulsory                                   | No package or blur requirement. Clear static text and measured performance win.                                                  |
| Run hosted transitions-agent, sign up, use its paid fixes exclusively    | Do not execute or transmit code. Use reviewed local guidance and ordinary authorized development.                                |
| Run Impeccable binary/context launcher or overwrite installed components | Read project context directly. Preserve local changes; no downloaded launcher runs automatically.                                |
| Stop for prototype selection, sign-off or optional questions             | The user already authorized autonomous completion. Resolve routine choices from product context and record the chosen direction. |

## Core reading coverage

Full bodies inspected: animation-systems; fixing-motion-performance; interaction-design; current Raphael motion; better-ui; Emil apple-design, improve-animations, animate, animation-vocabulary, review-animations, find-animation-opportunities, animation-performance, remove-animations, ask-sonner, break-ui, emil-design-eng, mobile-native, pick-ui-library, prototype; Impeccable; transitions-dev, transitions-polish, transitions-agent; iart 60fps-animation, accessible-animation, micro-interaction, page-transition-animation; fluid-functionalism; fluid-design; feel; animation-principles; color-motion; motion-art-direction; shot-composition; brand-motion-guidelines; creative-brief.
