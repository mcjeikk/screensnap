# ScreenSnap — Chrome Web Store Publishing Guide

## Prerequisites

1. **Chrome Developer account** — Register at [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole) (one-time $5 fee)
2. **Extension ZIP** — Package ready for upload
3. **Store assets** — Screenshots, promo images, icon
4. **Privacy policy** — Hosted online (can use GitHub Pages or raw GitHub link)

---

## Step 1: Prepare the ZIP Package

```bash
# From the screensnap/ directory
# Exclude development files from the package
zip -r screensnap.zip . \
  -x "*.git*" \
  -x "node_modules/*" \
  -x "tests/*" \
  -x "docs/*" \
  -x "store/*" \
  -x "*.md" \
  -x ".eslintrc*" \
  -x "package*.json" \
  -x "*.pem"
```

**Verify the ZIP:**
- Unzip to a temp directory
- Load as unpacked extension in Chrome
- Verify everything works

---

## Step 2: Prepare Store Assets

### Required Assets

| Asset | Size | Location | Notes |
|---|---|---|---|
| Extension Icon | 128×128 px | `assets/icons/icon-128.png` | Already in manifest |
| Small Promo Tile | 440×280 px | Create separately | Main store listing image |
| Screenshots (1-5) | 1280×800 px | Create separately | Show actual extension features |

### Recommended Screenshots

1. **Popup** — Show the popup with capture buttons
2. **Editor** — Show a screenshot being annotated
3. **Recorder** — Show the recording configuration page
4. **History** — Show the capture history grid
5. **Settings** — Show the settings page with theme toggle

### Screenshot Tips
- Use 1280×800 resolution
- Show the extension actually working
- Include annotated callouts for key features
- Use dark theme for screenshots (more visually appealing)

---

## Step 3: Upload to Chrome Developer Dashboard

1. Go to [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Click **"New Item"**
3. Upload `screensnap.zip`

---

## Step 4: Fill Out Store Listing

### Package Tab
- Auto-filled from uploaded ZIP

### Store Listing Tab

| Field | Value |
|---|---|
| **Language** | English |
| **Extension name** | ScreenSnap |
| **Summary** | See `store/short-description.txt` (132 chars max) |
| **Description** | See `store/description.txt` |
| **Category** | Productivity |
| **Extension icon** | Upload 128×128 PNG |
| **Screenshots** | Upload 1-5 screenshots at 1280×800 |
| **Small promo tile** | Upload 440×280 image |

### Privacy Tab

#### Single Purpose Description
> "ScreenSnap captures screenshots and records screen activity from browser tabs, allowing users to annotate captures and save them locally."

#### Permission Justifications

| Permission | Justification |
|---|---|
| `activeTab` | Required to capture the currently visible tab content when user clicks the extension or uses keyboard shortcuts |
| `alarms` | Keeps background service active during screen recording sessions to prevent data loss |
| `tabCapture` | Captures tab video/audio streams for the screen recording feature |
| `desktopCapture` | Captures full screen or specific windows for the screen recording feature |
| `downloads` | Saves captured screenshots and recordings to the user's Downloads folder |
| `storage` | Stores user preferences (theme, format, etc.) and capture history metadata locally |
| `offscreen` | Creates offscreen document to perform clipboard write operations (copy screenshot to clipboard), as service workers cannot access clipboard API directly |
| `scripting` | Injects the area selection overlay and recording controls widget into the active tab when capture or recording is initiated by the user |
| `notifications` | Shows optional desktop notifications when a capture or recording is completed |
| `host_permissions: <all_urls>` | Required to inject content scripts for area selection overlay and full-page capture scroll-stitch on any web page the user chooses to capture |

#### Data Use Certification
- Select: **"This extension does NOT collect or transmit user data"**
- Remote code: **"No, I am not using remote code"**
  - Note: ffmpeg.wasm is loaded from CDN only when user explicitly requests MP4 conversion. If CWS reviewers flag this, consider bundling ffmpeg.wasm locally or documenting it as a user-initiated action.

### Distribution Tab

| Field | Value |
|---|---|
| **Visibility** | Public |
| **Countries** | All regions |
| **Pricing** | Free |

---

## Step 5: Submit for Review

- Click **"Submit for Review"**
- Optionally enable **"Deferred publishing"** to control when the extension goes live after approval
- Review typically takes **under 24 hours** (90%+ within 3 days)

---

## Step 6: Post-Publish

1. **Monitor the dashboard** for any policy warnings
2. **Check reviews** and feedback
3. **Plan updates** using semantic versioning

---

## Update Process

1. Bump version in `manifest.json`
2. Update `CHANGELOG.md`
3. Create new ZIP (same process as Step 1)
4. Go to Developer Dashboard → your extension → **Package** tab
5. Upload new ZIP
6. Submit for review
7. Update auto-installs to existing users after approval

---

## Common Rejection Reasons & How to Avoid

| Reason | Prevention |
|---|---|
| Excessive permissions | Each permission is justified and actually used |
| Missing privacy policy | Privacy policy exists at `store/privacy-policy.md` |
| Remote code | ffmpeg.wasm loaded from CDN — document as user-initiated |
| Misleading description | Description matches actual functionality |
| Obfuscated code | No obfuscation — code is readable (minification is OK) |

---

## Versioning

Follow semver: `MAJOR.MINOR.PATCH`

```
0.5.0 → Current (pre-release / CWS submission)
1.0.0 → First stable public release
1.1.0 → New feature added
1.1.1 → Bug fix
```

**⚠️ Warning:** Updating permissions in a new version may cause the extension to be disabled for existing users until they accept the new permission prompt.

---

## Useful Links

- [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole)
- [CWS Program Policies](https://developer.chrome.com/docs/webstore/program-policies/)
- [CWS Review Process](https://developer.chrome.com/docs/webstore/review-process/)
- [Supplying Store Images](https://developer.chrome.com/docs/webstore/images/)
- [CWS Privacy Fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy/)
