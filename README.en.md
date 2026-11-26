# BaoYi · 抱一

[简体中文](README.md) · **English**

A local Windows workspace for the files, projects and personal records you want to keep.

BaoYi connects a collection with its context: a document can belong to a project, a project can support a skill, and your notes stay alongside the work. The library lives on your computer. Optional AI and online-source features connect to the services you configure.

## Start here

- **Download:** [GitHub Releases](https://github.com/LYC619/baoyi/releases). Check each release's notes; source code and documentation may be newer than available binaries.
- **Use it:** [Getting started](docs/site/en/guide.md), [common questions](docs/site/en/faq.md), [privacy](docs/site/en/privacy.md).
- **Build it:** [Development guide](docs/site/en/development.md).
- **Publish the site or package the app:** [Deployment guide](docs/site/en/deployment.md).

Extract the complete Windows package and open `抱一.exe`. Keep all included libraries and resources. Choose English or Simplified Chinese on the welcome screen or in Settings → Appearance. You can skip AI setup.

## What it does

| Area | Everyday use |
| --- | --- |
| Documents | Read PDF, Markdown and text; save bookmarks and excerpts; link evidence to projects |
| Projects | Keep current notes, related files, editor and terminal entries, and local launch commands together |
| Personal | Record skills and practice, costs and expiry dates, metrics and small tasks |
| Software and games | Scan folders, review entries, launch programs, attach guides and manage supported save backups |
| Media | Organize video and audio, browse photos and comics, and use supported online sources |
| Archive assistant | Search and read your collection; maintain supported records and preview file organization |

Core browsing uses local storage. AI identification needs a compatible model service; online sources have their own permissions and availability. Desktop delivery targets Windows x64. This repository does not provide a hosted web version of your library.

## Develop locally

Use Node.js 22.12 or newer. Windows is required for the supported desktop package.

```powershell
npm ci
npm run dev
npm run typecheck
npm run build
npm run i18n:check
```

For full validation, run the affected module tests, `npm run selfcheck`, `npm run eval:archive` and `npm run docs:check`. Bundled assistant/comic runtimes and FFmpeg are needed for the corresponding tests and packages; see the development guide.

The static website is independently buildable:

```powershell
npm ci --ignore-scripts
npm run site:build
npm run site:check
npm run site:preview
```

Its source is under `docs/site`; generated files stay under `output/site`. GitHub Pages deployment is provided by `.github/workflows/pages.yml`. The site is ready to deploy, but its presence in this repository does not imply that a public site has been enabled.

## Your data

Use Settings → Data management to see the real data directory. Standard builds normally use `%APPDATA%\抱一`; explicitly portable-data builds use `data` beside the executable. Keep backups of both the library and linked source files. Removing a library record and deleting its source file are distinct actions.

Do not share a daily profile in an issue. Redact keys, account tokens, personal paths and document contents. Read the [privacy guide](docs/site/en/privacy.md) before using remote AI with sensitive material.

## Contribute and license

[Contributing](CONTRIBUTING.md) · [Security reports](SECURITY.md) · [Architecture](docs/architecture-and-ipc.md)

BaoYi's code is licensed under [MIT](LICENSE). Bundled third-party components retain their own licenses and notices in [docs/third-party](docs/third-party).
