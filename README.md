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

## AI disclaimer

This project was created with the help of AI tools, including Lovable and Claude by Anthropic. AI wrote much of the code, and it has not been fully reviewed or tested. It may contain bugs, and edited or extracted plugins may not behave as expected.

- Back up your plugins before editing them.
- Test extracted or edited files in xEdit or in the game before sharing or relying on them.
- The software is provided as is, without warranty of any kind.

This is an unofficial fan tool and is not affiliated with Bethesda Softworks.

## Development

You need Node.js and npm.

```sh
git clone https://github.com/End2417/skyrim-plugin-workshop
cd
