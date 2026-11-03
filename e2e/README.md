# CI and browser regression tests

The Windows-only **Chrome 103 Windows compatibility** workflow additionally runs
`node e2e/chrome-103.mjs` against a production build. It requires
`CHROME_103_PATH` pointing to real Chromium 103 and also launches current Chromium.
The suite checks the original unbounded-height failure, wheel scrolling, the
composer, window resizing, sidebar layouts, file viewing, all six settings
sections, themes, short-window settings scrolling, draft retention and reload.
Artifacts are saved in `test-results/chrome-103/`. See
`compat/chrome-103/README.md` for limitations and upstream upgrade instructions.

Full-site coverage uses `E2E_SUITE=core|settings|content|platform|navigation`.
Every suite runs on Windows in both browsers and both `start`/`dev` modes.
The manifest `chrome-103-cases.json` is the reviewable case inventory; the final
coverage job fails unless all 20 reports and all advertised case IDs pass.
Each report includes actual action evidence and service/platform boundaries.
The platform suite enables an isolated synthetic web password for real login
and logout routes. Content runs headed, with native PDF observation enabled by
`CHROME_103_NATIVE_PDF=1`; media fixture coverage is PCM WAV and VP8 WebM.
Platform checks also drive the real composer with controlled native SSE deltas,
Send/Stop, compaction and cancellation, file selection/upload, image bytes and
synthetic rich-text paste. The standalone offline document is checked separately
because it does not load the application's CSS or compatibility startup script.

Adapted from @Nuctori's CI/E2E proposal in #617 and #599. The performance
scanner, reverse reader, sidebar changes, and timing benchmarks are not included.

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The script starts and stops its own Turbopack dev server on an available
loopback port. Run it in a checkout without an active dev server; Next.js
shares `.next/dev/lock` within a checkout. All fixtures are created before
startup in a temporary `PI_CODING_AGENT_DIR` and removed on completion.
No model credentials or existing Pi sessions are needed. Git is required for
the linked-worktree fixture.

CI runs lint, type checking, and unit tests in one job. A separate job builds
the application in a clean checkout and runs the same browser tests with
`E2E_SERVER_MODE=start` against `next start`. Do not build in a checkout used
for development.

Coverage:

- A 5,000-message session opens with exactly the last 50 entries, bounded
  detail/context responses, and no browser errors.
- Desktop and mobile scrolling load two consecutive older pages. Each response
  has the expected IDs, no gaps or duplicates, and the messages appear once in
  the chat. A small session checks pagination through the root.
- Branch context follows the selected leaf and excludes the other branch.
- Markdown, code blocks, and real tool-call/tool-result blocks render.
- Chat width and font size persist, existing drafts resize, and short settings
  panels keep every language option reachable on desktop and mobile.
- Interface/chat and monospace font lists and weights apply live, survive
  refresh, sync between tabs and reset independently without changing width or
  font size. Headings and Markdown emphasis retain their weights.
- On a desktop the sidebar shows the files below the sessions; Settings ›
  General › File browser brings back the Sessions | Files tabs and returns,
  without remounting the file tree (its file search keeps its query).
- Unknown sessions and paths outside the fixture project are rejected.
- Sidebar sessions open in browser tabs (`session-navigation.mjs`, desktop
  Chromium, one context so tabs share storage): a plain click and Enter
  select in place without a page load; Ctrl+click, middle-click and the row
  menu's Open in new tab (right-click, ⋯, T; just before Delete) open the clicked row's session in
  a new tab while the original keeps its own; both tabs keep their session
  through reloads; pinned and archived rows link the same way; nothing
  creates, copies or prompts a session; a missing session's link selects none
  in a fresh profile; a keyboard Fork puts focus on the copy row's link.
- Project groups offer Open in new tab (`project-navigation.mjs`, desktop
  and mobile Chromium): the current linked worktree, another project's root,
  and a pinned project without sessions open as fresh composers. Reload keeps
  that destination, not a remembered session. The original tab keeps its
  session, directory, draft, files and group expansion; + still opens in the
  same tab, and no session is created, copied, prompted or stopped. An
  unavailable directory shows the validation error instead of another session.
- The model picker, with a synthetic catalog: on a phone, a simulated keyboard
  (visual viewport shrink, pan, a late height with no event) keeps the same
  filter focused and the list in the visible viewport. Native phone keyboards
  still need real-device verification.
- A local extension checks dialog keyboard navigation, Esc cancellation,
  collapse/expand draft preservation, countdown display, and server-side expiry.

Model prompts, live model streaming, and agent execution are outside this suite.
Failures save a screenshot, Playwright trace, and server log under
`test-results/e2e/`; CI uploads that directory. Open a trace with
`npx playwright show-trace test-results/e2e/trace.zip`.
