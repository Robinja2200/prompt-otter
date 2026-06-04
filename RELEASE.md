# Release and Store Publishing

Prompt Otter uses GitHub version tags as the source of truth for Chrome Web Store, Firefox Add-ons, and Greasy Fork releases.

## Local validation

Install Node.js 20 or newer, then run:

```sh
npm install
npm run validate:release
npm run build
npm run lint:firefox
```

If a future agent cannot continue because Node or npm is missing, install Node.js 20 LTS or newer, then run these exact commands from the repository root:

```sh
node --version
npm --version
npm install
npm run build
npm run lint:firefox
```

Generated files are written to `dist/` and `artifacts/`. The Chrome package is `artifacts/prompt-otter-chrome-vX.Y.Z.zip`; the Firefox package is built from `dist/firefox`; the userscript artifact is copied from `prompt-otter.user.js`.

The build validates that these versions all match:

- `package.json`
- `chrome-extension/manifest.json`
- `chrome-extension/content.js`
- `prompt-otter.user.js`

## Firefox Add-ons first publish

The Firefox build adds the AMO MV3 signing fields required for new Firefox extensions:

- `browser_specific_settings.gecko.id`: `prompt-otter@robinja2200.github.io`
- `browser_specific_settings.gecko.strict_min_version`: `142.0`
- `browser_specific_settings.gecko.data_collection_permissions.required`: `["none"]`

If an old local `web-ext` reports `DATA_COLLECTION_PERMISSIONS_PROP_RESERVED`, update dependencies and rebuild:

```sh
npm install
npm run build
npm run lint:firefox
```

The repository pins `web-ext` to a version that accepts AMO's required data collection field.

First-time AMO setup:

1. Create or sign in to a Firefox Add-ons developer account.
2. Generate AMO API credentials from the AMO developer credentials page.
3. Add GitHub repository secrets named `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`.
4. Run the local validation commands above.
5. Complete any AMO listing fields that need manual entry the first time, such as screenshots, summary, support link, privacy policy, and review notes.
6. Push a `vX.Y.Z` tag and monitor the GitHub Actions release workflow.

AMO metadata for listed submissions lives in `amo-metadata.json`. Prompt Otter declares no data collection because it runs locally, uses no analytics or tracking, and sends no prompts or chat content to any server. The privacy policy is in `PRIVACY.md`.

## Chrome Web Store setup

Prompt Otter keeps the existing Chrome extension ID:

```text
bpnjpbkbmnjfcpiencjcinegcjfeiplc
```

Add these GitHub repository secrets for Chrome Web Store API publishing:

- `CHROME_CLIENT_ID`
- `CHROME_CLIENT_SECRET`
- `CHROME_REFRESH_TOKEN`
- `CHROME_PUBLISHER_ID`

The release workflow builds the Chrome zip, uploads it to the Chrome Web Store API, and submits it for publishing.

## Greasy Fork setup

Greasy Fork does not provide a normal update API for publishing new script versions. Configure Greasy Fork script sync from the raw GitHub userscript URL:

```text
https://raw.githubusercontent.com/Robinja2200/prompt-otter/main/prompt-otter.user.js
```

Enable GitHub webhook or release/push sync notifications in Greasy Fork if desired. After a release tag is pushed, confirm Greasy Fork imported the matching `@version`.

## Release routine

1. Update code.
2. Bump the version once in `package.json`, `chrome-extension/manifest.json`, `chrome-extension/content.js`, and `prompt-otter.user.js`.
3. Run `npm run validate:release`, `npm run build`, and `npm run lint:firefox`.
4. Commit the changes.
5. Tag the commit as `vX.Y.Z`.
6. Push the branch and tag.
7. Watch the GitHub Actions release workflow.
8. Verify Firefox Add-ons, Chrome Web Store, and Greasy Fork show the new version after review or sync completes.

## References

- Firefox manifest `browser_specific_settings`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings
- `web-ext sign` and `--amo-metadata`: https://extensionworkshop.com/documentation/develop/web-ext-command-reference/
- Firefox Add-ons data collection permissions: https://blog.mozilla.org/addons/2025/10/23/data-collection-consent-changes-for-new-firefox-extensions/
- Chrome Web Store API: https://developer.chrome.com/docs/webstore/using_webstore_api
- Greasy Fork sync and API docs: https://greasyfork.org/en/help/api
