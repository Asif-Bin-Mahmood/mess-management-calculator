# Releasing the Android app

Maintainer notes for building, signing and publishing the APK. Accounting rules and architecture are in
[SPEC.md](SPEC.md).

## Versioning

- `package.json` `version` is the single source of truth.
- Android `versionName` = that version; `versionCode` = major·10000 + minor·100 + patch
  (computed in `android/app/build.gradle`).
- The application ID `com.asifbinmahmood.messledger` and the release signing key must never change,
  or installed apps can no longer be updated.

## Publishing a release

1. Update `version` in `package.json` (`npm version X.Y.Z --no-git-tag-version`), commit and push `main`.
2. Wait for the **Android APK** workflow to pass.
3. Tag and push: `git tag -a vX.Y.Z -m "Mess Ledger X.Y.Z"` then `git push origin vX.Y.Z`.

On a `v*` tag, `.github/workflows/android.yml`:

- fails if the tag does not match `package.json`;
- builds a signed release APK and checks its certificate against `RELEASE_CERT_SHA256` in the workflow;
- refuses to publish a debug or unsigned APK;
- creates a stable GitHub Release with the asset `mess-ledger-vX.Y.Z.apk`;
- refuses to run if a release for that tag already exists, so published releases and their APKs are
  never modified.

Pushes to `main` and pull requests run the checks and an unsigned debug build only; they never use the
signing secrets or upload an APK. Third-party actions are pinned to commit SHAs.

## In-app update requirements

Version 1.1.1 and later find updates through GitHub's public "latest release" API, so the repository
must be public. A release is offered only when:

- it is published and not a draft or prerelease;
- its tag is `vX.Y.Z` and newer than the installed version;
- it has exactly one asset named `mess-ledger-vX.Y.Z.apk` with GitHub's SHA-256 `digest`.

The app verifies the download against that digest and checks the package name, version code and
signing certificate before handing it to Android's installer. Do not rename the asset or publish
updates as prereleases.

## Signing

The release keystore is never committed. CI reads it from repository secrets
(`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`).
For a local signed build, provide the same values as environment variables (`ANDROID_KEYSTORE_PATH`
instead of the Base64 value) or in a gitignored `android/keystore.properties`. Keep an offline backup
of the keystore.

## Local Android build

Requires JDK 21 (Android Studio's bundled JBR works) and the Android SDK (platform 36).

```bash
npm run android:sync
cd android && ./gradlew assembleDebug
```

If Gradle on Windows fails with "Unable to establish loopback connection", set
`JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=<a short directory path without spaces>`.
