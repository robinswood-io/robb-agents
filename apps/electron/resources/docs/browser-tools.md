# Browser Tools

Use `browser_tool` to control built-in browser windows (Chromium) inside Craft Agents.

> **Quick start:** Run `browser_tool --help` to see all available commands and usage examples.

## Browser usage paths

1. **Primary and only in-session tool surface:** `browser_tool`
2. **Secondary helper CLI:** `bun run browser-tool --help` for command discovery/templates, and `bun run browser-tool parse-url <url>` for safe URL diagnostics outside agent turns

---

## Browser as an Alternative to Source Setup

Use browser workflows when creating a source would add unnecessary overhead for the current task.

**Good fit for browser-first:**
- One-off tasks that don’t need reusable integration
- UI-only workflows where API/MCP coverage is poor
- Fragile source setup/auth cases where user needs results now

**Still prefer sources when:**
- Work is repeatable and automation/reporting is needed
- Team-wide reuse and stable tooling matter

---

## Core workflow

If you're unsure which window to use, run:

```text
browser_tool({ command: "windows" })
```

Recommended flow:
1. `open` — ensure browser window exists (background by default)
2. `navigate <url>` — load a URL
3. `snapshot` — inspect accessible elements and get refs (`@e1`, `@e2`, ...)
4. `find <query>` — quickly narrow to matching refs by keyword
5. `click` / `fill` / `select` — interact using refs
6. `screenshot --annotated` (or `screenshot-region`) — visual verification when needed

---

## `browser_tool` command examples

```text
browser_tool({ command: "--help" })
browser_tool({ command: "open" })
browser_tool({ command: "open --foreground" })
browser_tool({ command: "navigate https://example.com" })
browser_tool({ command: "snapshot" })
browser_tool({ command: "find login button" })
browser_tool({ command: "click @e12" })
browser_tool({ command: "click-at 350 200" })
browser_tool({ command: "drag 100 200 300 400" })
browser_tool({ command: "fill @e5 user@example.com" })
browser_tool({ command: "type Hello World" })
browser_tool({ command: "select @e3 optionValue" })
browser_tool({ command: "select @e75 CNAME --assert-text Target --timeout 3000" })
browser_tool({ command: "upload @e3 /absolute/path/to/file.pdf" })
browser_tool({ command: "set-clipboard Name\tAge\nAlice\t30" })
browser_tool({ command: "get-clipboard" })
browser_tool({ command: "paste Name\tAge\nAlice\t30" })
browser_tool({ command: "scroll down 800" })
browser_tool({ command: "evaluate document.title" })
browser_tool({ command: "console 50 warn" })
browser_tool({ command: "screenshot" })
browser_tool({ command: "screenshot --annotated" })
browser_tool({ command: "screenshot-region --ref @e12 --padding 8" })
browser_tool({ command: "window-resize 1280 720" })
browser_tool({ command: "network 50 failed" })
browser_tool({ command: "wait network-idle 8000" })
browser_tool({ command: "key Enter" })
browser_tool({ command: "downloads wait 15000" })
browser_tool({ command: "focus" })
browser_tool({ command: "windows" })
browser_tool({ command: "release" })
browser_tool({ command: "hide" })
browser_tool({ command: "close" })
```

The wrapper validates commands and returns actionable errors when arguments are missing or invalid.

It also returns rich execution feedback for most commands, including before/after state where available (scroll positions, active element, URL/title transitions, resize clamping, request/error summaries, and window ownership/visibility details).

You can batch commands with semicolons, for example:
`fill @e1 user@example.com; fill @e2 password123; click @e3`

Batches run left-to-right and stop automatically after navigation commands (`navigate`, `click`, `back`, `forward`) so refs don’t go stale silently.

### Quoting and escaping

`browser_tool` supports quoted arguments:
- Double quotes: `fill @e5 "Hello world"`
- Single quotes: `wait text 'welcome back' 5000`

Semicolons inside quotes are treated as literal text (not batch separators):
- `fill @e1 "a;b;c"; click @e2`
- `screenshot-region --selector "div[data-x='a;b']" --padding 8`

Use backslash escaping when needed:
- `\;` for a literal semicolon outside quotes
- `\"` for a literal `"` inside double-quoted text

---

## Key commands

### `open [--foreground|-f]`
Create or reuse the session browser window.
- Default: opens in background
- `--foreground` / `-f`: focuses in foreground

### `snapshot`
Returns an accessibility tree with refs and element metadata.

### `find <query>`
Performs keyword search over the snapshot accessibility nodes (`role`, `name`, `value`, `description`) and returns matching refs.

### `click <ref> [waitFor] [timeoutMs]`
Click an element ref from `snapshot`. Optional wait modes: `none`, `navigation`, `network-idle`.

Navigation listeners are armed before the click, so fast redirects are not missed. When a page re-renders a referenced element, `click`, `fill`, `select`, and `upload` attempt one semantic ref recovery (role/name/value) before asking for a fresh `snapshot`.

### `click-at <x> <y>`
Click at raw pixel coordinates. Use this for **canvas-based UIs** (e.g., Google Sheets cells, map elements, chart data points) where `snapshot` can't produce element refs. Get coordinates from `screenshot` or `screenshot-region`.

### `drag <x1> <y1> <x2> <y2>`
Drag from pixel coordinates (x1, y1) to (x2, y2). Performs mousedown, interpolated mousemove events, and mouseup. Use this for:
- Moving charts or objects in canvas-based UIs (e.g., Google Sheets charts)
- Reordering items via drag-and-drop
- Resizing elements by dragging handles
- Drawing or selecting regions

Get coordinates from `screenshot` or `screenshot --annotated`.

### `fill <ref> <value>` / `select <ref> <value> [--assert-text <text>] [--assert-value <value>] [--timeout <ms>]`
Fill text inputs or select dropdown values. Requires an element ref from `snapshot`.

For modern React/portal combobox UIs, `select` now performs additional verification and may return a warning when interaction succeeds but form state does not appear to mutate.

Useful flags:
- `--assert-text <text>`: verify downstream UI mutation (for example field label changes to `Target`)
- `--assert-value <value>`: verify selected control reflects expected value
- `--timeout <ms>`: verification timeout (default 2000ms)

### `upload <ref> <path> [path2...]`
Attach local file(s) to a file input (`<input type="file">`) using a ref from `snapshot`.

Notes:
- Use absolute file paths.
- Multiple files are supported: `upload @e3 /path/a.pdf /path/b.jpg`
- Files must exist and pass safety validation (sensitive paths are blocked).

### `type <text>`
Request text insertion into the currently focused DOM editor without replacing its value. `fill` instead focuses a ref and replaces its value. This uses CDP text insertion, which does not generate the keyboard events required by a canvas/RDP receiver. An observed non-editor (such as BODY or canvas) fails explicitly. Same-origin frame and shadow-root editors are resolved; an inaccessible frame retains the existing CDP insertion path, without claiming its application state is verified.

### `type-keys <text>`
Explicit keyboard text for a focused canvas/remote-desktop receiver in the main document or a shadow root. Prefer array input, e.g. `["type-keys", "AZERTY éèàçù € @[]"]`, to preserve punctuation and spaces. It dispatches trusted character keyDown/keyUp events in a single bounded operation (1–256 printable BMP characters; no line breaks or control characters). It does not use the system clipboard, shortcut modifiers, or Enter, and does not grant permissions. A receiver inside an unresolved iframe is refused.

Focus the intended receiver first. `focus browser-1` only focuses the window; its toolbar may still hold focus. Click the intended page receiver using `click` or `click-at`, then inspect `document.hasFocus()` and `document.activeElement` without reading field contents before `type-keys`. No hidden focus transfer is performed. Inspect its received text once before issuing a separate submit key. Dispatch is not proof that the remote server applied anything. A focus, navigation, ownership or transport change stops delivery, which may be partial: do not replay or submit blindly. If the receiver does not accept the text, select a different already-authorized route instead of looping through typing and screenshots.

### `set-clipboard <text>` / `get-clipboard`
Request page clipboard access under the existing browser permission policy. Clipboard access may be denied, including in Execute mode. A denial is an error, not an empty clipboard or a successful write; never bypass or broaden permissions to make these commands work.
- `set-clipboard` interprets `\t`, `\n`, `\r` and `\\`; unknown escapes remain literal.
- `get-clipboard` returns text only when the browser confirms the read.

### `paste <text>`
Request a clipboard write, then dispatch Ctrl+V (Cmd+V on Mac) only if the write is confirmed. A rejected write prevents the shortcut, so it cannot paste an old clipboard value. A successful shortcut is not proof of page/remote receipt. On denial, do not repeat this path: use a DOM editor or explicit `type-keys` for a supported remote receiver, then verify the actual text.

### `screenshot` / `screenshot --annotated` / `screenshot-region ...`
Capture full-window or targeted screenshots. `--annotated` overlays `@eN` labels on interactive elements for easier ref debugging.

### `console`, `network`, `wait`, `downloads`
Debug runtime issues, requests, synchronization points, and download progress.

`downloads` output includes the resolved local `savePath` when available so you can reference the downloaded file directly.

### `focus [windowId]` / `windows`
Manage and inspect browser window ownership and visibility.

### `resume [timeoutMs]`
After a genuine security verification is detected, the browser releases the interaction overlay so the user can complete it. `resume` waits (120 seconds by default, maximum 300 seconds) without re-blocking user input, then tells the agent to refresh refs with `snapshot`.

Sparse normal pages are not considered challenges on their own. Detection requires a concrete title, URL, text, or provider DOM signal and recognizes Cloudflare, hCaptcha, reCAPTCHA, DataDome, and Arkose.

### Lifecycle commands
- `release` — dismiss agent overlay, keep window visible for user
- `hide` — hide window but preserve session state
- `close` — close and destroy window

---

## Common validation errors

- `Missing command...` → pass a command string (try `--help`)
- `Unknown browser_tool command ...` → typo/unsupported verb; check help
- `...requires ...` → required argument is missing for that command
- `...must be numbers` → numeric argument parse failed

---

## Secondary helper: `browser-tool parse-url`

Use this for safe URL debugging in Explore mode without running a generic interpreter snippet:

```bash
bun run browser-tool parse-url https://example.com/path?q=1#hash
bun run browser-tool parse-url file:///Users/me/Desktop/report.html
```

Output is deterministic JSON (`href`, `protocol`, `host`, `hostname`, `pathname`, `search`, `hash`, `origin`, plus `basename` for `file://` URLs).

---

## Behavior notes

- Browser tools are allowed in **Explore/Safe mode** by default.
- Before first browser tool usage, the agent must read this guide (`~/.craft-agent/docs/browser-tools.md`).
- Closing browser UI via OS controls may hide the window; use `browser_tool close` for explicit teardown.

---

## Recipe: Canvas-based UIs (Google Sheets, etc.)

Canvas-based web apps (Google Sheets, Google Docs, some map/chart UIs) render content as pixels on `<canvas>` — individual cells or elements are not DOM nodes and won't appear in `snapshot`. Use these patterns instead:

### Google Sheets workflow

```text
# 1. Navigate and wait for load
navigate https://docs.google.com/spreadsheets/d/{id}/edit
wait selector [aria-label="Name Box"] 10000

# 2. Navigate to a cell via Name Box (a DOM element — snapshot finds it)
snapshot
click @nameBoxRef
type A1
key Enter

# 3. Edit a cell
key F2
type Hello World
key Enter

# 4. Optional TSV paste only where existing browser policy permits it; stop on denial
snapshot
click @nameBoxRef
type A1
key Enter
paste Name\tAge\tCity\nAlice\t30\tNYC\nBob\t25\tLA

# 5. Optional clipboard read; denial is an error, not empty data
key a meta           # Select all (Cmd+A)
key c meta           # Copy (Cmd+C)
get-clipboard        # Returns TSV string

# 6. Click a canvas cell by coordinates (from screenshot)
click-at 350 200

# 7. Move a chart by dragging (coordinates from screenshot)
drag 400 300 100 50

# 8. Read data via export URL (no editing needed)
navigate https://docs.google.com/spreadsheets/d/{id}/export?format=csv&gid=0
```

### Key principles for canvas UIs
- **Name Box and formula bar are DOM elements** — `snapshot` can find them
- **Cells are canvas pixels** — use `click-at` or keyboard navigation, not `click`
- **Charts and objects are moveable** — use `drag` to reposition elements on the canvas
- **Keyboard shortcuts are more reliable than clicking** — use `key` for navigation
- **Clipboard is policy-controlled** — stop on denial; use a DOM editor or an already-authorized connector instead of repeating paste attempts
- **Export URLs work with session cookies** — no API key needed for reads

---

## Troubleshooting

### "Browser window controls are not available"
The desktop browser manager isn’t wired for this runtime/session. Ensure you’re in the Electron desktop app and session is initialized.

### "Element @eX not found"
Refs are stale. Re-run `snapshot` and use fresh refs.

### Interaction feels flaky
Wait for page readiness and retry using:
`open` → `snapshot` → interaction
