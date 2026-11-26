# Get started with BaoYi

BaoYi is a Windows desktop workspace for local files, projects and personal records. Start with a small folder and add more when the workflow feels right.

## Install and open

1. Open [GitHub Releases](https://github.com/LYC619/baoyi/releases) and read the notes for the version you download. Source code can be ahead of available downloads.
2. Extract the complete archive to a folder you can write to. Keep the executable, libraries and resources together. Do not move only `抱一.exe`.
3. Open the executable. Choose **English**, **简体中文**, or **Follow system** on the welcome screen. You can change this later in **Settings → Appearance → Interface language**.
4. Choose a software folder to scan. Scanning reads icons and metadata without moving your files. AI setup is optional; you can skip it and configure it later.

Existing libraries are opened from their normal data location. Switching interface language does not rename files, notes, tags or categories. The card-title preference is a separate setting.

## Find your way around

Use the top bar to switch between Personal, Projects, Software, Games, Video, Images and Documents. Each module remembers its last location. Settings includes the current module's options and common options.

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+K` | Open global search |
| `Ctrl+K` or `/` | Focus search on the current page; use global search where no page search is available |
| `Ctrl+,` | Open settings |
| `Ctrl+J` | Open or close the archive assistant |
| `Alt+←` / `Alt+→` | Go back / forward |

## Add and use your collection

**Software and games.** Add scan folders in Settings. Review detected entries before accepting them. Open an entry to set its default launcher, attach guides or other files, and manage available save backups. A folder scan and a file-moving operation are separate actions.

**Documents.** Import a file or folder through the Documents entry point, or drag supported files into the window. Review the import before confirming. Read PDF, Markdown and text, add bookmarks and excerpts, and link material to a project or personal record. Office and EPUB documents open in an external application; PDF reading does not include OCR.

**Images and comics.** Import an album or a comic folder/archive. Use the reader for zooming, bookmarks and reading progress. Photo details can display available EXIF metadata. Online sources require their own access and network configuration.

**Video and audio.** Scan local media or use supported online sources. Check the destination and preview before starting a download. Audio has its own library views and a bottom playback bar. Metadata services and frame extraction may require a configured API key or FFmpeg.

**Projects.** Register a project directory and add the files, editor, terminal and commands you use. Keep the current situation and next step in the project note. Review commands before running them; they execute locally with your account's permissions.

**Personal.** Record skills and practice, recurring costs and expiry dates, metrics, experiences and small tasks. Link evidence and projects where useful.

## Optional AI features

In **Settings → AI configuration**, enter a compatible model endpoint, key and model. Use the connection test before saving. The archive assistant can search your collection, read selected material and propose or perform supported changes. Review file-organization previews before execution and use the action history for supported undo operations.

The selected AI provider receives the context required by the feature you use. Read [Privacy](privacy.md) before attaching sensitive material. Core local browsing does not require an AI subscription. Third-party service costs and permissions are your responsibility.

## Back up and recover

Open **Settings → Data management** to inspect the data directory and backup/recovery options. The standard build normally uses `%APPDATA%\抱一`; builds explicitly marked for portable data use `data` beside the executable. The path shown by the application is authoritative.

Back up before moving computers or trying an older release. Keep separate copies of original source files: a library backup does not replace a backup of every linked file. Close all instances before restoring. Upgrade snapshots support recovery, but an older program may not understand a newer library.

When removing an item, read the dialog: removing its library record and deleting or recycling the local file are different choices. Preview file moves, confirm their scope, and keep the recovery information until you have checked the result.
