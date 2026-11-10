# Skyrim Plugin Workshop

Open, edit and extract Skyrim Legendary Edition `.esp` / `.esm` plugin files on your phone or in your browser. Change a record, such as a sword's damage, then save just that change as its own small `.esp` mod.

**[Download the Android app](https://github.com/End2417/skyrim-plugin-workshop/releases/latest)** · **[Project website](https://end2417.github.io/skyrim-plugin-workshop/)** · **[Use in your browser](https://skyrim-plugin-workshop.lovable.app)**

## Features

- Browse every record in a plugin and search by FormID or Editor ID.
- Edit values in readable fields instead of raw bytes. Records you don't touch save byte-for-byte identical.
- **Extract** only the records you changed into a new `.esp` that overrides the originals and lists the source plugin as its master.
- Works offline. Files stay on your device.

## Install on Android

1. Download `ESP-Editor.apk` from the [latest release](https://github.com/End2417/skyrim-plugin-workshop/releases/latest).
2. Open it and allow installs from your browser or Files app if Android asks.
3. Saved plugins go to `Documents/ESP Editor`.

Always back up your plugins before editing, and test extracted files in xEdit or in the game before sharing them.

This is an unofficial fan tool, not affiliated with Bethesda Softworks.

## Build with Lovable

Continue developing this project in the Lovable editor. Every change made in Lovable is committed to this repository, and changes pushed to `main` sync back into Lovable.

## Development

You need Node.js and npm.

```sh
git clone https://github.com/End2417/skyrim-plugin-workshop
cd skyrim-plugin-workshop
npm i
npm run dev
```

The Android app is built by the **Build Android** workflow in the Actions tab. It needs the secrets `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD` and `KEY_ALIAS`.
