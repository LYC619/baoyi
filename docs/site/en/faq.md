# Common questions

Check the installed release notes first: source code, documentation and downloadable binaries can be at different stages.

## Does it work on macOS or Linux?

Desktop delivery is currently for Windows x64. The website builds on other systems, but that does not establish desktop support there. No hosted web version of your personal library is provided.

## Do I need an account or an AI key?

There is no BaoYi cloud account required for the local library. AI features require a compatible configured model. Online sources may require their own accounts, keys, permissions or network access.

## Why do some titles remain Chinese after choosing English?

Interface language does not translate collection content. File names, user categories, notes, imported metadata and model responses retain their original language. The card-title option can prefer an available English resource name; it does not invent a translation of the content.

## The app will not open

Extract the complete package and keep its libraries and resources together. Close previous instances and check that the folder is writable. Use the startup error screen's retry and data-directory information. Preserve the library while investigating; do not delete it to fix a missing runtime. For a source checkout, run `npm ci` and then `npm run rebuild` if Electron was not installed.

## A scan, download or AI request failed

Read the displayed reason. Check the source path, permissions, available disk space, selected model and credentials. For online requests, check Settings → Network proxy and the source's availability. Download speeds depend on the source and network. Review task details before retrying. Do not post credentials in a public issue.

## Can I return to an older version?

Keep the previous program and a matching backup. Exit the current app first. An older release may not read a library upgraded by a newer one; restore a compatible backup into an independent location rather than opening the daily library with several versions at once.

## Where can I report a problem?

Open a [GitHub issue](https://github.com/LYC619/baoyi/issues) with your version, Windows version, selected language, steps and a redacted error message. Indicate whether the problem happens with a small synthetic library. Suggestions and translations are welcome through the same repository.
