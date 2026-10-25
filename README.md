# wallp

A Tauri v2 + React desktop UI that runs *inside* the Windows desktop. It
sits in the wallpaper layer, so Win+D doesn't hide it, Alt+Tab doesn't list
it, and other windows never push it around.

```sh
pnpm install
pnpm tauri dev      # or: pnpm tauri build
```

It runs from the tray icon: **Show desktop icons**, **Reload**, **Quit**.

## Desktop layout

- Left: **This PC** and **Downloads** (uses the Windows Downloads location,
  including redirected folders).
- Right: a dedicated launchpad for **Microsoft Edge**, **Steam**, **Riot Games**,
  and your pinned apps. Click **+** to find an app in the command menu, then click
  its pin button (or select it and press **Ctrl+Enter**) to add it to Home.
  Pins save across restarts and launch with one click. Unpin from the command
  menu or hover/focus a homescreen app and click its remove button.
- Top right: **Quick settings**, beside **System tray**, opens wallp's custom
  panel with Wi-Fi and Bluetooth switches, volume, mute, and brightness.
  The panel reads current hardware state while open and reports unsupported
  devices or Windows permission restrictions. Brightness controls the first
  active built-in display exposed by Windows WMI; external monitors may require
  their own buttons. **Manage networks** and **Manage devices** open Windows
  Settings for choosing networks and pairing devices. Sound, display, network,
  and power settings are also linked. These controls require the desktop app.
  Under **Settings → Quick settings**, turn off **Show Quick settings** to hide
  the button, or turn on **Use Windows panel** to open the native Win+A panel
  instead. Both preferences save independently of the clock settings.
  **System tray** opens a large centered dialog listing running
  apps with visible or overflow tray icons, using their installed application icons.
  **End task** force terminates the owning process in one
  click; unsaved work may be lost. The list refreshes every ten seconds and can
  be refreshed manually while the dialog is open. Escape, the close button, or
  clicking outside closes it. Multiple icons from one process share one card. Windows
  shell icons and wallp cannot be ended from this panel. Windows may deny access
  to elevated or protected apps; errors appear in the panel.
- Bottom: a **T3 Code** dock, using the installed Nightly version when available.
- Center: a custom analog and digital clock with seconds, date, and local timezone.

Shortcuts open with a single click or keyboard activation. App icons are bundled
locally in `public/icons`, extracted from the installed apps. The six built-in
shortcuts use install paths in `launch_shortcut` in `lib.rs`; update those paths
if you move an app. Custom pins use registered Windows application IDs from
the command menu's app index and cache their icons locally. Browser previews display the layout, but
launching apps requires the native Tauri window.

## Game Mode

From Home, hold **View + Menu** (**Back + Start**) on an Xbox-compatible
controller for one second, press **Ctrl+Alt+G**, or click **Game Mode**.
The hold shows progress and triggers once until the buttons are released.

Use the D-pad, left stick, or arrow keys to move; **A / Enter** selects.
**B / Escape** closes an open dialog first, then exits Game Mode. The games
view includes Steam, Riot Games, and your existing Home pins. **Pin a game**
opens the command menu; select an installed game and pin it to Home.
**Home widgets** keeps controller navigation enabled on your normal layout.

Change the controller binding to a Menu-only hold or choose another
Ctrl+Alt+letter shortcut under **Shortcuts** in Game Mode or **Settings →
Game Mode**. D, W, and N remain reserved for wallp's existing shortcuts.
Bindings save on this device. Input pauses when another app takes focus;
return to Home to resume. Native controller support requires the desktop app.

## Workspace

Open **Workspace** from the home screen for edge-to-edge panels. Todos support
adding, editing, completing, filtering, and deleting. Reminders include a date
and time, an in-app alert, dismiss, and a five-minute snooze. Alerts work on both
screens while wallp runs; missed reminders appear when it is reopened. Todos
also includes reminders, with the same editing, completion, and filtering controls.

Press **Ctrl+Alt+W** from any app while wallp is running to reveal the workspace.
Like the dock's Workspace button, this minimizes open application windows and
focuses wallp. The shortcut works independently of the Ctrl+Space setting.

Press **Ctrl+Alt+D** from any app while wallp is running to reveal the main
desktop. It minimizes open application windows, switches back from Workspace
to Home, and focuses wallp. It also works independently of the Ctrl+Space setting.

**Notes** is a tabbed plain-text notepad. Use **+** for a new note, **Rename** (or
double-click a tab) to name it, and **×** to close it. **Reopen closed tab** restores
closed notes, including after restarting. Each tab saves its own text and name;
your original single note is kept as the first tab. Arrow keys, Home, and End
switch tabs when a tab is focused. Notes includes automatic saving on this device, a word-wrap
toggle, a character count, and **Export .txt** to download a copy. Ctrl+S retries
the local save. Open it from the workspace toolbar; existing layouts keep their
visible apps, while new and reset layouts include Notes after Todos.

The workspace toolbar also opens **Agenda**, **Files & Links**, **AI**, and
**Clipboard**. Agenda shows local reminders and optional todo deadlines by date,
with overdue and upcoming sections. It does not sync an external calendar.
AI uses the same Agnes tools and saved chat history as the command menu.
Clipboard shows searchable, paginated text/image history; Copy keeps you in
Workspace, and Pin saves an item in Files & Links.

In **Files & Links**, add absolute file/folder paths or http(s) links, search
pins, and add tags. In the command menu, search with `f filename` or open
clipboard history with `paste`, then click a result's pin button or press
**Ctrl+Enter**. Choose the destination workspace above the results. Files,
folders, and clipboard text/images appear together in Files & Links. Clipboard
pins retain the complete text or original image in a separate SQLite table and
survive clearing clipboard history. Unpin removes that saved copy. File pins
point to the original path; they do not copy the file.

Use the workspace selector and **Manage** to create or rename spaces. Each
space saves its own panel layout, note tabs, and pinned resources. Existing
layouts and notes migrate into **Personal**. Todos, reminders, Gmail, clipboard
history, and AI chat history are shared. New panels stay closed in existing
layouts until opened from the toolbar. The maximize button on a panel expands
it temporarily; its restore button or **Escape** returns to the saved layout.

**Search** (**Ctrl+K** in Workspace) searches tasks, notes in every space, pins,
and locally cached Gmail subjects, senders, snippets, and cached conversation
bodies. Email results open the original Gmail thread. Search reads only the
connected account's cache and does not fetch mail or change read status.

**Capture**, or the global **Ctrl+Alt+N** shortcut, saves a note, todo, reminder,
or link. The global shortcut opens the command-menu window over the current app
without switching to Workspace. Choose a space for notes and links; **Ctrl+Enter**
saves, and **Escape** or Cancel closes the capture window. Global shortcut
conflicts are reported in the native log.

An open email has **Add todo** and **Remind me** actions that attach its Gmail
link. In Notes, select text and choose **Remind me** to attach the source note;
without a selection, it uses the note text. Task/reminder **Source** buttons
open the linked email or note. A closed source note can be reopened from Notes.

**OTP notifications** check the connected Gmail account every 10 seconds while
wallp runs, including while the desktop or email panel is hidden. New verification
emails show a custom card at the top right of the active monitor, above other
apps without taking keyboard focus. Use **Copy code** or dismiss it; cards close
automatically after 25 seconds. Detection runs locally on plain-text and HTML
emails, without marking them read. Old codes are skipped on startup, repeated
checks are deduplicated, and disconnecting clears pending notifications. Network
errors retry with backoff up to one minute. This uses polling, so delivery may
take around 10 seconds plus Gmail indexing/network time.

**Emails** connects one Gmail account. Choose **Sign in with Google**, finish
consent in your browser, and the panel shows your inbox grouped by
conversation (**Load more** fetches older mail). The inbox and conversations
are cached in `%LOCALAPPDATA%\com.anupa.wallp\mail-cache.sqlite3`, so the panel
paints saved mail instantly and then syncs in the background every minute
(paused while wallp is hidden) or when you press refresh. New mail fades in
at the top without moving what you're reading; the newest conversations are
prefetched so they open instantly. If Gmail can't be reached, saved mail stays
visible. Open a message to read the whole conversation; opening it marks it
read. Disconnecting deletes the cache. HTML mail
renders in a sandboxed frame with scripts disabled and remote images blocked
until you choose **Load images**; **Text** switches to the plain-text version.
Links open in your default browser. Reply at the bottom of a conversation
(Ctrl+Enter sends); replies are plain text, stay in the Gmail thread, and go
to the last message's Reply-To or sender. Wide panels show the list and the
conversation side by side; drag the divider between them (or focus it and use
the arrow keys, Shift for bigger steps) to set the list width, which is saved.
Double-click the divider to reset it. The sign-out button disconnects the account.
OAuth tokens are stored in Windows Credential Manager and all Gmail requests
run in the native backend. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
(a Google Cloud "Desktop app" OAuth client with the Gmail API enabled) in the
root `.env` and rebuild; like the Agnes key, they are compiled into the app.

Home includes an **Inbox brief** below the clocks. The initial brief summarizes
the latest ten received messages, including archived mail, using Agnes. Later
checks run every minute while the desktop is visible and send only previously
unprocessed received mail. Categories show email counts; choose a category or
**View all** to read summaries. Highlights prioritize action items, then other
relevant mail when nothing needs urgent attention. Subjects open the originals
in Gmail. Summarization does not mark mail read.

The initial last-closed timestamp is the current time. Graceful app exit records
the actual closure time. A separate successful-processing checkpoint and saved
message IDs prevent repeated AI submissions and retain failed batches for retry.
The brief persists in `%LOCALAPPDATA%\com.anupa.wallp\email-digest.sqlite3`;
disconnecting Gmail clears it. Received sender, subject, date, snippet, and up to
14,000 characters of each email body are sent to Agnes; attachments are excluded.
Category counts are computed from validated per-message classifications.

Workspace panels use a cell grid, with the original two-by-two arrangement by default.
The grid can extend horizontally beyond the desktop. **Alt+Left** and **Alt+Right**
visit panels by their right edge and snap an off-screen target's right edge to the
right side of the desktop. Panels arranged vertically remain separate targets,
including panels with different widths. **Alt+Up** and **Alt+Down** move vertically.
There is no current-panel highlight. Shortcuts stay inactive on Home and while
a dialog is open. Toolbar arrows and horizontal trackpad scrolling also navigate.

Choose **Customize** to shrink the desktop into a preview beside a themed sidebar.
Drag a panel's grip or resize its corner to snap to whole grid cells. Arrow keys
on a focused grip or resize handle adjust one cell. Escape cancels a drag.
The sidebar provides column, row, width, and height fields, plus columns per screen
and rows. Panels make room without overlapping when a move or resize occupies their
cells. Auto arrange restores the two-by-two pattern, extending horizontally for
additional apps. Done or Escape leaves customization. Each workspace saves its grid.
Layout, todos, and reminders save locally on the device.

## Desktop integration

### Floating dock

The native app shows a compact, transparent dock centered above the bottom of
the primary monitor and hides the Windows taskbar. It overlays the desktop;
it never registers an AppBar or reserves work area, so it does not resize or
reposition other windows. Its width follows the number of running windows.

The dock stays hidden until the pointer reaches the primary screen?s bottom
edge. It stays visible while hovered and hides 350 ms after leaving. It holds
only Desktop, Workspace, and running window icons extracted from installed
executables, with a generic icon fallback. App icons retain their order when
focus changes; newly opened windows append and closed windows disappear.
Hover for window titles; click to restore and focus a window. An indicator marks
the active window. Fullscreen apps can cover the dock.

Settings → Desktop and the tray menu restore the Windows taskbar.
Choose **Use wallp dock** to enable it again. This toggle applies to the current
session. Quit and the separate crash recovery process restore the original
Windows taskbar state. Explorer continues running. Secondary monitors retain
the Windows taskbar. Restore it to access Windows notification icons or Start;
Home's **Quick settings** button provides access to network and volume controls
while the taskbar is hidden. The dock requires the native app.

### Command menu and clipboard

Press **Ctrl+Space** to toggle the command menu, or use the dock's search button or
**Open command menu** in the tray. It opens over your current app, searches installed
applications, and excludes documents, help files, website shortcuts, and recent files.
The app index is cached locally, loaded immediately at startup, and refreshed in the
background. **Refresh apps** picks up installations and removals during a session.
Arrow keys select a result; Enter opens it. Escape or clicking another app dismisses
the menu. Installed application icons are cached with the app index, with initials
as a fallback. Windows shortcuts are left to Windows.

Use `g search terms` for Google, `y` for YouTube, `d` for DuckDuckGo, `w` for
Wikipedia, `gh` for GitHub, and `r` for Reddit. A leading bang also works (`!g terms`).
Queries are URL encoded and open in the default browser. Plain text searches apps
first and offers Google as a final result.

Use `f filename` (or `!f filename`) to search files and folders across Sigma File
Manager's indexed drives. Results update as you type; use the arrow keys and Enter
to open one. This searches filenames, with word prefixes and typo tolerance, and
returns up to 50 results. It does not search file contents. Sigma must be installed
and have a completed global search index; open Sigma to build or refresh it.
Wallp reads `%APPDATA%\com.sigma-file-manager.app\global-search\index` using
Tantivy 0.25, without copying Sigma's search code or changing index contents.
It uses Tantivy's metadata lock during reads. Index format changes in future Sigma
versions may require updating Wallp's reader.

Use `ai question` or `!ai question` and press Enter to get an answer directly in
the command menu using **agnes-3.0-flash**. After an answer, type a reply directly
and press Enter to continue with the full conversation as context. The conversation
scrolls and renders Markdown headings, lists, tables, quotes, links, and fenced code.
Code blocks include syntax highlighting and a **Copy code** button; conversation,
code, and history panes use dark custom scrollbars.

Agnes can create, list, edit, complete, and delete the app's actual reminders and
todos through tools. Try `ai remind me tomorrow at 9 AM to call home` or
`ai add a todo to buy milk`. Changes save to the same local lists used by Workspace
and appear there immediately. Relative reminder dates use your local timezone;
if a time is missing or ambiguous, Agnes asks for clarification. Saved actions
remain visible in chat even if a later AI request fails or is cancelled.

Agnes can also search and fetch mail from the Gmail account connected in Emails.
Try `ai find my flight bookings from last month` or `ai summarize my unread emails`.
Search supports Gmail filters, includes archived mail, and can load more pages.
Fetching messages leaves their read status unchanged. Up to 14,000 characters of
each fetched body are sent to Agnes; attachments are excluded and truncation is
reported to the AI. Connect Gmail in the Emails panel before using these tools.

**Copy last answer** copies the original Markdown. Completed turns automatically save
locally in `%LOCALAPPDATA%\com.anupa.wallp\ai-chats.sqlite3`. Open **ai ? History**
to resume or delete a saved conversation, including after restarting wallp. **New chat**
starts a separate conversation; Cancel stops a pending response. Closing the menu
with Escape, Ctrl+Space, or by clicking away keeps AI work running while wallp is
open. Reopening returns to the same AI conversation, including its pending or
completed response and any reply draft. Back to apps and clipboard navigation also
keep the conversation; type `ai` to return. Completed responses save to History.

In AI mode, **Ctrl+H** opens history (or returns to the chat), **Ctrl+N** starts
a new chat, and **Ctrl+L** focuses the reply field. History has its own search:
type to filter, use **Up/Down** to choose a chat and **Enter** to open it;
**Escape** returns to your current chat without losing a reply draft. Tab also
reaches every history action, including Delete. **Ctrl+J** focuses the conversation
for scrolling with arrows/Page Up/Page Down. **Ctrl+Shift+C** copies the last
answer, and **Ctrl+Shift+X** stops a pending response. History and New chat remain
unavailable while AI is working; stop it first if you want to switch chats.
**Ctrl+Shift+F** toggles a larger, centered chat window (up to 1120 × 860, fitted
to the monitor). The chosen size is kept when the menu is reopened. All shortcuts
appear below the chat and work with either command-menu style.

While AI uses tools, the chat shows an Activity list with readable steps such as
Searching emails, Reading an email, and Setting a reminder. Each step shows whether
it is running, done, failed, or stopped; email searches show result counts and
message reads show subjects. Tool arguments, raw responses, and message bodies
are not displayed in activity. The list collapses after the answer and can be
reopened with a click or keyboard. Current activity survives closing/reopening
the menu; saved chat history contains the conversation rather than the activity log.
Raw HTML is disabled; links open in your default browser and remote images are not fetched.
Set `AGNES_API_KEY` in the root `.env` (see `.env.example`) and restart/rebuild
the app after changing it. The key is compiled into the native app rather than
the frontend bundle; AI requests run through the native backend. Only submitted
questions, the current conversation, local time/timezone, and results of requested
reminder/todo and email tools are sent to Agnes by command-menu chat. The Home email brief
also sends received email content as described above. A distributed desktop
binary contains its configured key.

**Ctrl+Space** opens the command menu. Search for **paste** or
**clipboard** and press Enter to open clipboard history. Copy text or images while
wallp runs. Distinct items are saved across restarts in
`%LOCALAPPDATA%\com.anupa.wallp\clipboard-history.sqlite3`, with no item-count or age
limit (available disk space is the practical limit). Text items support up to 100,000
UTF-16 code units each. Images are stored losslessly as PNG and shown with thumbnails
and dimensions. File copies are excluded. Search covers saved history; **Load older
items** retrieves another 50 results, and pressing Down at the end also loads more.
Items marked by their source to be excluded from Windows clipboard history are skipped.
Selecting an item copies it, returns focus to the original app, and sends Ctrl+V.
If Windows blocks focus or input, the item remains on the clipboard for manual paste.
Settings → Command menu includes a Ctrl+Space toggle, can pause text/image
capture, and clear wallp's saved history from disk. Clearing history leaves the current
Windows clipboard unchanged. History is stored locally without encryption; it doesn't
import Windows' history.

`src-tauri/src/desktop.rs` uses the "WorkerW trick": it sends `Progman`
the undocumented message `0x052C`, then reparents the webview window into
the desktop:

- **Windows 11 24H2+**: becomes a child of `Progman`, just below
  `SHELLDLL_DefView` (the icons), with `WS_EX_LAYERED` set. Without that
  style the window isn't drawn. Layered *child* windows need the
  Windows 10 `supportedOS` entry in `src-tauri/windows-app-manifest.xml`.
- **Older builds**: becomes a child of the `WorkerW` that follows the
  window hosting the icons.

The native icons are hidden by default, so the UI gets mouse and keyboard
input directly. A watchdog in `lib.rs` polls every 2 s and does three
things:
- re-attaches the window after Explorer restarts;
- resizes it when the monitor layout changes;
- emits `desktop://paused` while a fullscreen app is running, which the UI
  uses to pause its animations.

## Gotchas

- **Icons stay hidden if the app is killed** instead of quit from the tray.
  This includes `tauri dev` restarting after a Rust change. Fix it by
  quitting from the tray, or by toggling **Show desktop icons**, or by
  restarting Explorer.
- Don't call `set_focus` on the desktop window at startup.
- Tauri's `show()` resets the window's z-order and extended style. That's
  why `attach_desktop` calls `Attachment::place()` again after showing.
