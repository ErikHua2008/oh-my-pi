# OMP C++ Windows Shell

Native Windows host for the existing `omp --mode core` service. The shell owns
the Win32 window, native transcript, WebView2 control surface, project
selection, tray icon, and Core process lifetime. Agent execution, providers,
authentication, context compaction, and JSONL session persistence remain in
OMP Core.

The current milestone focuses on keeping long conversations fast without
forking OMP's agent or storage layers.

## Transcript architecture

The default conversation view is a native child window rendered with
DirectWrite and Direct2D:

- `NativeTranscriptModel` stores lightweight rows and uses a Fenwick tree for
  dynamic heights. Row-height updates, streaming-tail upserts, and visible
  range lookup are O(log n).
- `NativeTranscriptView` creates text layouts only around the viewport. Its
  layout cache is bounded to 256 rows.
- A session initially replicates only its newest 200 entries. Reaching the top
  requests older pages while preserving stable row IDs and viewport position.
- Streaming updates upsert one stable tail row instead of retransmitting the
  complete transcript for every token.
- Selection, cross-row drag selection, double-click row selection, copy,
  Select All, mouse-wheel and keyboard navigation use native Win32 behavior.
- The standard Win32 scrollbar is not used. A 3-DIP overlay thumb appears only
  while scrolling or hovering at the right edge, expands on hover, and supports
  direct track positioning and drag scrolling.
- Scrolling away from the live tail reveals a centered floating down-arrow,
  matching the familiar Codex one-click return-to-bottom interaction.

The Web transcript remains available from **View > Native high-speed chat
view**. Disable that menu item for full Markdown, complex tool cards, browser
content, and compatibility fallback. Project/session controls and the composer
continue to run in WebView2; the long scrolling message surface does not.

The default window keeps the 288-DIP project/session sidebar docked beside the
808-DIP conversation area (a 760-DIP composer with 24-DIP outer gutters),
without reserving space for optional panels. Opening the docked Agent rail
grows the native window by the 288-DIP rail width (within the monitor work
area); closing it restores the exact two-column bounds without changing the
sidebar or conversation widths.

## Images and local files

Replicated transcript rows contain content-addressed image IDs, never inline
base64 pixels. When an image row approaches the native viewport, the shell
requests the existing OMP thumbnail, decodes it with WIC, and paints it with
Direct2D.

Native media memory is bounded:

- 4 MiB maximum encoded thumbnail size
- 32 MiB maximum encoded-media cache
- 64 MiB maximum decoded-bitmap cache; oversized sources are downsampled to a
  maximum 1024-pixel edge before entering Direct2D; malformed or unusually
  large sources above 40 megapixels / 16,384 pixels on one edge are rejected
- 32 cached media entries with LRU eviction

The shell does not create another copy of an original image or attachment.
Files selected from the desktop composer remain references to their original
absolute paths; moving or deleting the source makes that reference
unavailable.

## Measured development results

These numbers are machine-specific regression measurements, not product
guarantees:

- Debug model test: 100,000 rows plus 100,000 visible-range queries in about
  0.83 seconds.
- Imported real session: 577 projected rows and about 240,462 DIP total native
  height.
- Release smoke test after full history load: posting 1,600 Page Down events in
  about 95 ms; shell working set remained about 38.9-39.0 MiB and private
  memory about 17.1-17.4 MiB while the process stayed responsive.

## Requirements

- Windows 10 or 11, x64
- Visual Studio 2022 Build Tools with the **Desktop development with C++**
  workload
- CMake 3.25+
- WebView2 Evergreen Runtime
- Bun 1.3.14+ for source-mode development

The WebView2 SDK is fetched at a pinned version during CMake configuration.
The CMake build also rebuilds `packages/collab-web/dist` with Bun before linking
the shell. This keeps the frameless native window and its Web title bar on the
same revision after a fresh clone, pull, or branch switch. Set
`OMP_CPP_SHELL_BUILD_WEB_ASSETS=OFF` only when an external build step already
provides matching assets.

## Build and test

```powershell
cd packages/cpp-shell
cmake --preset windows-msvc
cmake --build --preset windows-msvc-debug
ctest --preset windows-msvc-debug --output-on-failure

cmake --build --preset windows-msvc-release
ctest --test-dir out/build/windows-msvc -C Release --output-on-failure
```

Executables are written to:

- `out/build/windows-msvc/Debug/omp-cpp-shell.exe`
- `out/build/windows-msvc/Release/omp-cpp-shell.exe`

Closing the main window hides it to the notification area by default. Use the
tray menu or **File > Exit** to stop both the shell and its owned Core process.
The executable, main window, shortcuts, and notification-area entry all use
the same embedded OMP icon resource.

## Development Core resolution

The shell resolves OMP in this order:

1. `OMP_CPP_SHELL_DEV_REPO` - explicit source mode; starts Bun against that
   repository's `packages/coding-agent/src/cli.ts`.
2. A valid persisted development repository, preferring its single-file
   `packages/coding-agent/dist/cli.js` bundle and falling back to source when
   the bundle is absent.
3. A source repository discovered by walking upward from the built executable,
   with the same bundle-first behavior.
4. `OMP_CPP_SHELL_OMP_BIN` - explicit installed `omp` executable.
5. `omp` from `PATH`.

The default CMake build keeps the bundle current through the
`OMP_CPP_SHELL_BUILD_CORE_BUNDLE` target. Set
`-DOMP_CPP_SHELL_BUILD_CORE_BUNDLE=OFF` only when another build or installed
OMP binary owns that artifact. The automatic repository lookup makes a freshly
cloned and compiled shell portable across PCs without copying a
machine-specific `devRepo` path. WebView2 and Core initialize in parallel; if
Core has not emitted its local links after ten seconds, the startup page
reports that it is still waiting instead of appearing frozen. The existing
timeout and stderr diagnostics remain authoritative.

`OMP_CPP_SHELL_INITIAL_PROJECT` selects a project on startup and is useful for
repeatable integration tests. The persisted last project is used when the
override is absent.

The selected project is always passed as `--cwd`. The shell uses the existing
OMP/Codex authentication path and never stores API keys or provider tokens.
