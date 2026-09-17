# Hanime Registration Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and display complete Hanime metadata during registration, download the cover immediately, and scope Hanime tag filtering to the hentai category.

**Architecture:** Keep translated text in the existing resource description and add source-owned fields to video metadata. The verified Hanime ledger, rather than model arguments, supplies original text, tags, cover, and URL. Extend video queries with an optional category plus tag combination and expose category-scoped tag counts to the sidebar.

**Tech Stack:** TypeScript, Electron, SQLite, Vue 3, Pinia, node-html-parser.

---

### Task 1: Persist source-owned Hanime metadata

**Files:**
- Modify: `electron/kinds/video/schema.ts`
- Modify: `electron/kinds/video/db.ts`
- Modify: `electron/kinds/video/tools.ts`
- Modify: `src/types/index.ts`
- Test: `scripts/agent-selfcheck.ts`
- Test: `scripts/verify-hentai-e2e.ts`

- [ ] Add failing tests asserting that `hanime_detail` ledger tags and introduction are stored independently from model-supplied tags and translated description.
- [ ] Run `npm run verify-hentai-e2e` and confirm the new metadata assertions fail.
- [x] Add `original_description` and `hanime_tags` to the table, view, migration, payload, row mapping, and update allowlists.
- [x] Populate these fields directly from the verified Hanime detail ledger; preserve the normal three-tag rule for non-Hanime tags.
- [x] Re-run the focused test and confirm it passes.

### Task 2: Download Hanime cover immediately after registration

**Files:**
- Modify: `electron/kinds/video/tools.ts`
- Modify: `electron/kinds/video/service.ts`
- Test: `scripts/verify-hentai-e2e.ts`

- [ ] Add a failing service-boundary assertion that a registered Hanime item is reported with an ID and queued for poster download.
- [x] Extend `onRegister` with the resource ID and remote-poster state.
- [x] After registration, call `fetchVideoPoster` for Hanime items; report failure without rolling back metadata.
- [x] Verify the registration and poster regressions pass.

### Task 3: Scope Hanime tag filtering to the hentai category

**Files:**
- Modify: `electron/kinds/video/db.ts`
- Modify: `electron/kinds/video/service.ts`
- Modify: `src/types/index.ts`
- Modify: `src/stores/video.ts`
- Modify: `src/components/video/Sidebar.vue`
- Test: `scripts/agent-selfcheck.ts`

- [ ] Add failing data tests for category-scoped Hanime tag counts and combined `category + tag` querying.
- [ ] Return Hanime tag counts only for an explicit hentai-category count request, leaving global counts free of Hanime tags.
- [x] Preserve the hentai category while selecting a Hanime tag in the store query.
- [x] Render the sidebar tag section using Hanime tags in the active hentai category.
- [x] Verify the data and store/UI type checks pass.

### Task 4: Display translation, folded original, and source link

**Files:**
- Modify: `src/pages/video/Detail.vue`
- Modify: `src/types/index.ts`
- Test: `scripts/agent-selfcheck.ts`

- [ ] Add source assertions for a native details disclosure and a visible Hanime source link.
- [x] Keep the translated description in the existing editable field.
- [x] Add a collapsed `<details>` block containing the read-only original description.
- [x] Add the Hanime source link in the detail header using the existing external-open behavior.
- [x] Run type checking and the focused self-check section.

### Task 5: Full verification

**Files:**
- Verify all modified files.

- [x] Run `npm run verify-hentai-e2e` and require zero failures.
- [x] Run `npm run typecheck` and require exit code 0.
- [x] Run `npm run build` and require exit code 0.
- [ ] Run `npm run selfcheck`; separate any pre-existing unrelated failure from Hanime regressions.
- [x] Run `git diff --check` and inspect the final diff for unrelated changes.
