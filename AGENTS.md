# Contributor guidance

Use Node.js 22.12 or newer. Install with npm ci. Run npm run build and checks appropriate to the change.

Use isolated profiles and synthetic data for tests. Preserve user files and prior builds. Never commit account credentials, databases, downloaded media, personal notes, or test profiles.

Prepare the pinned Hermes and comic runtimes before packaging; see README.md. Keep package.json and both root version entries in package-lock.json aligned.
