# Deploy the site and package the app

The public website is a static product and documentation site. The desktop application runs locally on Windows; publishing the website does not expose your library to a browser.

## Preview the website

```powershell
npm ci --ignore-scripts
npm run site:build
npm run site:check
npm run site:preview
```

Open the local address printed by the preview command. The generated site is in `output/site`. It contains English and Chinese HTML pages, local assets, a sitemap and robots.txt. Reading and switching languages does not require JavaScript or a third-party font service.

## GitHub Pages

1. Prepare a public source export using the process below and inspect its manifest.
2. Publish the reviewed product source to the public repository's `main` branch through your normal review process.
3. In the repository, open **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
4. Run the **Deploy website** workflow from Actions. Subsequent website changes on public `main` trigger it automatically.
5. Check the deployment result and open both language pages. The workflow uploads only `output/site`.

The workflow obtains the site's actual base URL from GitHub Pages. Forks therefore use their own account and repository path. Builds fail if the URL is malformed. Repository source and release links are configured in `docs/site/site.json`; update them for a fork.

For a custom domain, configure DNS and the Pages domain first, then set `SITE_URL` for local builds. Example: `$env:SITE_URL='https://example.org/'`. The builder writes canonical URLs, language alternates, the sitemap and CNAME consistently. A local preview is not proof that a public deployment succeeded.

## Export public source

```powershell
npm run export:public
```

This creates a new timestamped directory under `output/public-export`, with an allowed product file set and a manifest. It never pushes Git history or changes the repository remote. Local maintenance notes, `.user`, `data`, `archive`, `reference`, build output, credentials and daily profiles are not part of the export. A short public `AGENTS.md` is generated instead of copying local instructions.

The export keeps portable unit/UI tests and an explicit set of build helpers. Local repair tools, field checks, historical package checks and their package commands are excluded. The test manifest is filtered to match the exported files.

Inspect the exported tree and run its build before importing it into the public source branch. The local maintenance `main` may contain private history; do not push it directly. Keep the existing `release/public → origin/main` relationship when publishing from the maintainer's workspace.

## Windows package wrapper

Run `pwsh -File scripts/package-windows.ps1` to see the commands and intended output without building. Add `-Build` to execute the checks and directory build. Add `-PrepareRuntimes` only when the pinned runtimes need preparing. Existing version output is refused, so previous programs cannot be overwritten accidentally.

The script does not publish a release or copy a daily library. Test the finished application with an independent profile and inspect the complete output before uploading it. Source archives and public tags must describe the same reviewed source revision. Existing distribution scripts remain available for advanced packaging.

## Search and sharing

Each language has its own stable URL and matching canonical and hreflang links. Pages contain descriptive titles, summaries, Open Graph and social cards, and structured data. The build creates a sitemap and robots.txt. These make the site discoverable; indexing and search ranking remain decisions of the search service.
