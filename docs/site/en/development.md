# Build from source

BaoYi uses Electron, Vue 3, TypeScript, Vite and SQLite. Windows x64 is the supported desktop delivery target; the static website can be built on Windows, macOS or Linux.

## Requirements

- Node.js **22.12 or newer** and npm. CI uses Node 22.
- Git. Python **3.12** is used when preparing the bundled Windows runtimes.
- Network access for the first dependency and runtime downloads.
- Optional FFmpeg for media frame extraction and its tests.

```powershell
git clone https://github.com/LYC619/baoyi.git
cd baoyi
npm ci
npm run dev
```

`npm ci` installs the Electron runtime and checks native SQLite support. If installation scripts were disabled, run `npm run rebuild` before opening the desktop application. `better-sqlite3` uses supplied N-API binaries; a Visual Studio rebuild is not normally required.

For a separate development library, build first, then run `npx electron . --user-data-dir="<absolute path to a new folder under output>"`. Never point it at a daily library when testing imports, moves or recovery. The test runner creates its own profiles.

## Validate a change

```powershell
npm run typecheck
npm run build
npm run i18n:check
npm run docs:check
npm run selfcheck
npm run eval:archive
npm run test:unit
```

Run the affected module suite as well, for example `npm run test:settings`. The test runner uses independent profiles and a hidden Windows desktop for window tests. Set `BAOYI_TEST_FFMPEG` to a local FFmpeg executable when running FFmpeg-dependent cases. A missing external runtime is a test limitation, not a passing result.

## Create a Windows package

```powershell
npm run prepare:hermes
npm run prepare:comic
npm run check:hermes
npm run check:comic
npm run dist:dir
```

The preparation steps build independent pinned runtimes for the archive assistant and comics. They do not install packages into your system Python. Directory output is `release/<version>/win-unpacked/`; distribute the complete folder. End users do not need Node or Python.

`npm run dist` creates the configured standard distribution. `npm run dist:green` produces the explicitly portable-data ZIP. A single executable distribution does not by itself mean data is portable. See [Deployment](deployment.md) for the safe wrapper and export process.

## Interface translations

Chinese source messages are the message identifiers. English translations live in `src/i18n/en.json`. Use `$t('message', { p0: value })` in templates or `tr(...)` in script code. Keep a whole sentence together so English can reorder its variables. Do not concatenate translated fragments where sentence order matters.

Only application-owned labels and messages are translated. File paths, titles, user notes, categories, model output and stored domain values must remain intact. Keep interface language separate from resource-title preferences. Run `npm run i18n:check` to find missing entries and changed interpolation variables.

The checker also covers native dialog labels and static system errors. Use `src/i18n/core.ts` from shared or main-process code; it has no Vue dependency. Renderer notifications use `systemMessage` only at application-message display boundaries. Never pass library titles, user notes or model output through it. Unknown upstream messages retain their original wording. Native dialogs use the saved language. Third-party pages and model replies use their own language settings.


## Contribute

Use a focused branch and describe the user-visible behavior before and after your change. Add meaningful tests to the existing module suite. Do not commit profiles, credentials, downloads or personal libraries. [CONTRIBUTING.md](https://github.com/LYC619/baoyi/blob/main/CONTRIBUTING.md) describes the contribution workflow.
