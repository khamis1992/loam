# Loam Recorder

Loam Recorder is the screen-recording workspace. The user-facing name is Loam Recorder. The internal app id is `recordercraft`.

The editor page, when its vendor zip is installed, loads from `loamrecorder://` inside the Workspace iframe. `bridge-relay.js` defines `window.electronAPI` in that frame and forwards calls to the host. The host and the main process accept only the methods in `electron/recorder/methods.json`. Any other channel is rejected.

`record.start` needs a single-use consent token from `POST /api/recorder/consent`. The agent tool `loam_recorder` cannot issue that token. A refusal tells the user to approve the recording in the window and is not retried.

The pinned build is `khamis1992/openscreen` at `8ecc76b`. `resources/recorder/bin/win32-x64/wgc-capture.exe` records the picture, the cursor, and system audio. The Workspace record button includes system audio when that helper is present and the option stays on. `compositor_view.node` exports a 1080p MP4. `edit.apply` with `zoom.autoFromClicks` renders that zoom through the compositor scene when a recording is open. The zoom follows the cursor sidecar. Until the helper exe is present, Loam records the picture with ffmpeg. Captions call the local speech server used by `creative_subtitles` and do not download a whisper model. When that server is down, a project that already has an `.srt` returns that file. `resources/recorder/sample/desktop.loamrec` is a sample project `project.open` can read. `desktop.mp4` beside it plays in the editor, and `desktop.srt` is its Arabic caption. The Workspace page opens that sample inside the editor frame. The editor asks the host for its project list and loads the Arabic sample. When Loam is in Arabic, the editor page starts in Arabic and right-to-left. The Workspace button is the consent control. The agent cannot mint a token. A tray dot and a countdown window follow the server state line, and Ctrl+Shift+Alt+S stops the current session. A finished recording is copied to `recordings/` in the task workspace, so the chat can attach the MP4. A consent refusal from the agent remembers that task folder, and the consent button records into it without the agent minting a token. When the recording stops after the reply, the MP4 is appended to that task's chat, and opening it mounts Loam Video on that file. A cursor track is burned into `recordings/export-zoom.mp4` at 1080p before that delivery. The cursor sampler writes `recording.mp4.cursor.json` beside it, and `zoom.autoFromClicks` uses that track to choose the burned-in zoom. A `handoff.video` result opens Loam Video when its JSON names an mp4. The editor relay answers project loading and leaves the editor's other window calls quiet, so the page stays open.

Fetch an already built archive with `npm run vendor:recorder` after `manifest.json` has a sha256. Build the archive on the Windows workflow with `npm run vendor:recorder:build`.

## Device check

These items stay open until Khamis signs them on the installed app. They are not marked done from the build machine.

- [ ] Update the open Loam to 0.5.59 and confirm the about version.
- [ ] Arabic request, consent in the window, stop, and the chat shows `export-zoom.mp4`.
- [ ] That attachment opens in Loam Video.
- [ ] The editor frame shows the sample title in Arabic, right to left.
- [ ] A 30 second take has system audio and a visible cursor.
