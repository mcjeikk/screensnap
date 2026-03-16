# ScreenSnap — Privacy Policy

**Last Updated:** March 16, 2026

## Summary

ScreenSnap does not collect, transmit, or share any user data. All processing happens locally in your browser. Period.

---

## Data Collection

**ScreenSnap does NOT collect:**
- Personal information
- Usage analytics or telemetry
- Browsing history
- Screenshots or recordings
- IP addresses
- Device identifiers
- Any form of user data

## Data Storage

All data created by ScreenSnap is stored **locally on your device** using Chrome's built-in storage APIs:

- **Settings** are stored in `chrome.storage.sync` (synced across your Chrome devices via your Google account, if sync is enabled)
- **Capture history metadata** (thumbnails, timestamps, filenames) is stored in `chrome.storage.local`
- **Screenshots and recordings** are saved to your local Downloads folder via Chrome's downloads API

No data is ever sent to external servers.

## Data Processing

- All screenshot capture and stitching happens in your browser
- All image annotation and editing happens in your browser
- All video recording and compositing happens in your browser
- MP4 conversion (when requested) uses ffmpeg.wasm, which runs entirely within your browser's WebAssembly sandbox
- Clipboard operations use Chrome's offscreen document API within the extension sandbox

## Third-Party Services

ScreenSnap does not use any third-party analytics, tracking, advertising, or data processing services.

The only external resource optionally loaded is **ffmpeg.wasm** from a CDN (jsdelivr.net) when you choose to convert a recording to MP4 format. This is a client-side WebAssembly library — no user data is sent to the CDN; only the library code is downloaded.

## Permissions

ScreenSnap requests the following Chrome permissions, each with a specific purpose:

| Permission | Purpose |
|---|---|
| `activeTab` | Access the current tab to capture its visible content |
| `tabCapture` | Capture tab video/audio stream for screen recording |
| `desktopCapture` | Capture full screen or window for screen recording |
| `downloads` | Save captures and recordings to your Downloads folder |
| `storage` | Store preferences and history metadata locally |
| `offscreen` | Create offscreen document for clipboard copy operations |
| `scripting` | Inject selection overlay UI when capturing a selected area |
| `notifications` | Show optional notifications after capture completion |
| `alarms` | Maintain background service during active recording sessions |

## Host Permissions

ScreenSnap requests `<all_urls>` host permission to enable:
- Content script injection for area selection overlay on any web page
- Full-page screenshot stitching on any web page
- Recording controls widget injection during screen recording

This permission is used **only** when you actively initiate a capture or recording. No content is accessed, read, or transmitted from any page.

## Children's Privacy

ScreenSnap does not knowingly collect any data from anyone, including children under 13.

## Changes to This Policy

If this privacy policy is updated, the changes will be reflected in the "Last Updated" date above and included in the extension's changelog.

## Contact

For questions about this privacy policy, please open an issue on the project's GitHub repository.

---

**In short:** ScreenSnap is a local tool. Nothing leaves your browser. Your captures are yours.
