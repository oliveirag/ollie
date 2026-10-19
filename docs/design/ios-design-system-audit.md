# iOS UI audit against the design system

2026-10-19. Audited every screen of the iOS app (owner and subscriber, 13 screens) on the iPhone 17 Pro
simulator against Gui's design system v1 (`~/Developer/design-system`: `PRINCIPLES.md`, `COMPONENTS.md`,
`tokens/tokens.json`), then rebuilt the UI on it. This file records what was wrong, what changed, and
where the design system itself has gaps.

## Bugs found while screenshotting

1. **The mode rail hid the navigation bar on pushed screens.** On a signal's detail, the back button and
   the title sat under the paper/live rail. Cause: the rail was a `safeAreaInset` on the `TabView`, which
   iOS 26 does not pass down to a pushed `NavigationStack` bar. Fixed by stacking the rail above the
   `TabView`. Same fix on the subscriber's disclaimer rail.
2. **Evidence rows printed `Optional(14)`.** `OpenAPIValueContainer` boxes optionals in `Any`, and
   `String(describing:)` printed the box. Fixed in a shared `IndicatorReader` that unwraps first.
3. **Execution mode always showed a closed lock**, even with live trading unlocked. Now `lock.open` when
   unlocked.
4. **The subscriber's disclaimer rail clipped at both edges** (uppercase, one line, 10pt). Now sentence
   case, wraps, 12pt minimum.

## Where the old UI broke the design system

| Rule | Before |
| --- | --- |
| One typeface, JetBrains Mono | SF Pro everywhere, SF Mono in a few spots |
| Achromatic; red means error or destructive only | Teal gain, red-orange loss, amber paper mode and warnings, red for the final minute and for live mode, iOS blue on the subscriber side |
| No success or warning colour; status is icon plus words | "Running" in green, broker alerts and the handoff warning in amber |
| Primary action is the inverse of the page | Approve was amber (mode tint), Subscribe was iOS blue |
| Min text 12px, never lower opacity | 10pt rail text, `caption2` (11pt) chips, 70% opacity sub-cent digits, `.tertiary` system text |
| Sentence case | `PAPER · SIMULATED FILLS`, `NOT ADVICE · …` |
| Cards: `surface.default`, 1px border, radius lg (12) | iOS inset-grouped lists, about 26pt corners, no border |
| Fields use a 3:1 control edge | Borderless system text fields |
| Press feedback `scale(0.97)` | None on custom controls |
| Toggle: label leads, mono accent when on | System green/amber toggle |

## What changed

- `Ollie/DesignSystem/`: `Tokens.swift` mirrors the `mapped`, `responsive` (mobile) and `motion` tiers;
  `Typography.swift` maps the type scale to JetBrains Mono through `UIFontMetrics`, so every style
  scales with Dynamic Type, with programming ligatures off outside code; `Components.swift` has Page,
  Section, Card, Rows, Button (primary, secondary, ghost, destructive), Badge, Notice, Toggle, Text
  field, Code block and Empty state.
- Fonts: JetBrains Mono Regular and Bold, OFL, bundled in `Resources/Fonts`. There is no Medium file
  yet, so captions render at Regular.
- Every screen rebuilt on those components. Behaviour, accessibility identifiers and copy that tests
  read are unchanged, except the paper confirm label: "Approve — paper buy" is now "Approve paper buy"
  and the UI test matches it.
- Colour decisions:
  - Gain and loss are the primary text colour with a sign and a triangle. Buy and sell are `plus.circle`
    and `minus.circle`, so a losing buy never shows two arrows pointing opposite ways.
  - Paper mode is a striped neutral rail; live is solid red. Live is the one place red is about state,
    because every approval there spends real money irreversibly.
  - The only red buttons: Halt, Revoke, and Place real order.
  - The countdown turns red only in its final minute.
- Launch screen and accent colour come from an asset catalog, so launch no longer flashes white.

## Gaps in the design system

The design system targets web and React Native. Building a native SwiftUI app on it exposed these gaps.
Each one is a decision the app made on its own that should move into the system.

### Platform and tokens

- **No SwiftUI or iOS export.** Status says CSS and React Native exports are not done, and there is no
  Swift target. `Tokens.swift` is a hand copy. A generator from `tokens.json` would stop drift.
- **No Dynamic Type mapping.** Sizes are fixed px with a "scale with font scale" rule. iOS needs each
  style tied to a text style (`relativeTo`). The app's mapping is in `Typography.swift`.
- **The font files.** Only Regular and Bold were available locally. Captions are specified at Medium (500).
- **Field edge contradiction.** `PRINCIPLES.md` says fields use `border.strong` at rest; `COMPONENTS.md`
  says `border.control` (3:1). The app uses `border.control`, since `border.strong` fails 3:1.
- **Grouped lists in light mode.** `surface.page` white with `surface.default` `#FAFAFA` cards is nearly
  invisible without the border. Cards need the border in light mode, so the border is not optional.

### Domain gaps

- **No financial data semantics.** Gain and loss, signed values, sub-cent digits, P&L direction. The app
  uses sign plus glyph in primary text; the system should say so, or define a sanctioned pair.
- **No data-viz guidance.** Chart line colour, gridlines, axis labels, zero rule. The app uses
  `text.primary` for the series, `border.default` for grids, `border.control` dashed for zero.
- **No environment or mode indicator.** Paper/live is the most important state in the owner app and the
  system has no persistent banner or rail component.
- **Missing components the app needed:** list rows and grouped sections, navigation and tab bars, a
  countdown or timer badge, empty states, notices or banners, code blocks, a sheet layout.
- **Icons.** The system ships a 12-icon custom 16px set. On iOS, SF Symbols are the right source (and
  the Apple guidance says so). The system needs a rule for symbol weight and size against JetBrains Mono.

### Coverage of the Apple design skill

Covered: springs (critically damped default, bounce only after momentum), interruptibility, press on
touch-down, glass only on chrome, reduced motion as crossfade, reduced transparency and increased
contrast, simplicity over minimalism, common path first.

Not covered:

- **Haptics and sound.** Nothing on multimodal feedback (causality, harmony, utility). The app already
  uses success, error and warning haptics on decisions and the kill switch.
- **Velocity handoff and momentum projection** (the projection function, release velocity into the
  spring). Rubber-banding is named but not specified.
- **Size-specific tracking.** The system has negative tracking at 32px and up but zero at small sizes;
  Apple adds slight positive tracking at small sizes.
- **System font default.** Apple says override the system font only with a reason. JetBrains Mono is a
  deliberate identity choice; the system should state the reason and the cost (wider lines, about 35
  characters per line on a phone, no optical sizing).
- **Liquid Glass.** The glass token is a web blur value. iOS 26 tab bars, toolbars and scroll edge
  effects are system materials; the system should defer to them on iOS.
- **Native sheet motion.** Drawer is a 350ms cubic-bezier; iOS sheets are springs (damping 0.8,
  response 0.3) and should not be restyled.
- **Wayfinding and the four feedback kinds** (status, completion, warning, error) as a checklist.

### Coverage of the Emil Kowalski skill

Covered: the four easing curves, durations by element, under 300ms, never ease-in, never from scale 0,
origin-aware popovers with centred modals, first tooltip waits, transform and opacity only, reduced
motion, springs for touch.

Not covered:

- **Asymmetric timing.** Exit faster than enter; slow where the user decides, fast where the system answers.
- **Stagger** (30 to 80ms between items, never blocking input).
- **Blur to mask crossfades.** The `blur-transition` 2px token exists with no rule for using it.
- **Hover gating** on touch devices (`(hover: hover) and (pointer: fine)`).
- **Gesture details.** Momentum dismissal by velocity (about 0.11), multi-touch protection, pointer capture.
- **Implementation rules.** No `transition: all`; CSS transitions over keyframes for interruptible UI;
  CSS or WAAPI over main-thread JS under load.
- **Review practice.** Slow motion and next-day review.

## Not done here

- Tab bar and toolbar button titles stay in SF Pro: iOS 26's glass bars ignore the appearance proxies.
- No app icon yet (the asset catalog holds colours only).
- `docs/design/owner-app-design.html` still describes the old amber and teal palette.
- `ios/scripts/e2e.sh` fails in a worktree on this Mac: the Postgres socket path exceeds 103 bytes, and
  Postgres needs `LC_ALL` set. The tests here ran from a copy with a short data path and `LC_ALL`.
