# Privacy and your data

BaoYi stores its library locally. Some optional features contact services you choose or online sources you open; local storage does not mean every feature works offline.

## What stays on your computer

The SQLite library, notes, reading state, local settings and operation records are stored in the application's data directory. Linked source files remain at their original paths unless you explicitly import, move, download or remove files through the relevant workflow. Check the application's data-directory entry for the exact location.

API keys supported by the settings vault use operating-system encryption. A copied profile may not decrypt those credentials on another computer or Windows account. Re-enter the keys there. Do not share a complete profile as a bug report or sample library.

## When information leaves the computer

| Feature | Destination and information |
| --- | --- |
| AI identification and archive assistant | The configured model service receives the prompt and context needed for the task, which may include file metadata or selected file text |
| Online search and metadata | The selected search or metadata provider receives the query and request information |
| Online media sources | The source receives requests, account information where configured, and normal network metadata |
| External links | The website you open receives a normal browser request |

Review the provider's own privacy terms before use. Do not attach confidential documents to a remote model unless you are allowed to share them. A locally hosted compatible model can be configured where the feature and model support it. Model-generated answers and classifications can be wrong; review changes that matter to you.

## Website

The product site contains no application analytics script, advertising script or account system. Fonts and assets are served with the site. GitHub Pages or another chosen host can still process connection logs under its own policies. Following a GitHub link takes you to GitHub.

## Reports and removal

When filing an issue, remove API keys, account tokens, personal paths and document contents from screenshots and logs. Use synthetic sample files where possible. For a security concern, follow [SECURITY.md](https://github.com/LYC619/baoyi/blob/main/SECURITY.md).

To remove local information, use the app's clearly labeled library/file operations and data-management tools. Removing a library entry does not necessarily delete its source file, and uninstalling or deleting an executable does not necessarily remove its data directory.
