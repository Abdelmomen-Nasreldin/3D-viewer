# 3dViewer

Angular + Three.js **WebXR room AR** for a Vodafone router GLB: hit-test placement in the real world with **CSS2D or sprite** hotspot labels in the same scene.

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 19.2.15.

## Room AR only

There is **no** separate 3D orbit viewer and **no** `getUserMedia` camera overlay. The page loads **router.glb** first; **Start room AR** stays disabled until the model is ready. Placement uses **continuous hit-test** (cyan ring), **transient hit-test** on each tap (works even when the ring is missing), and a **fixed fallback** in front of the user on the first tap if both miss.

All hit poses are expressed in the session **reference space** (`local-floor` when granted, otherwise `local`), not relative to the camera.

The **cyan ring** needs a working continuous hit-test source and a real surface in view; on some **Android WebViews** the source can fail on the first attempt—the app **retries on a short cadence** so the ring can appear after a brief warm-up. Aim at the floor or a table.

**World lock:** when the session grants the **`anchors`** feature and `createAnchor` succeeds on your placement hit, the router pose is updated each frame with **`XRFrame.getPose(anchor, referenceSpace)`**. If the anchor never resolves or poses stay null for too long, tracking **falls back** to the last stable transform for that placement. The session prefers **`local-floor`** reference space for more stable vertical alignment.

### Manual AR checks (device / WebView)

1. Start room AR and point at a real surface; confirm the **cyan ring** appears (may take a second on slow WebViews).
2. Tap to place; **walk around** the router—the model should stay fixed in the room (strongest when **anchors** is granted).
3. If the ring never appears, try **tap placement** (transient hit-test); first tap may use the **fallback** position in front of you.
4. End AR and start again; confirm placement and reticle work on a **second** session.

## Embedding (WebView)

Ship over **HTTPS**. The WebView must expose **WebXR `immersive-ar`** with **hit-test** (and ideally **dom-overlay** for the toolbar). Requirements vary by Android WebView version and iOS/WKWebView.

| Topic | Android | iOS |
|--------|---------|-----|
| URL | HTTPS | HTTPS |
| WebXR | Recent System WebView / Chrome where `immersive-ar` is available | WKWebView + OS support for WebXR AR where applicable |
| Permissions | Camera / XR as prompted by the browser | Same; `Info.plist` usage strings as required |

### Sprite labels in difficult WebViews

If CSS2D labels mis-layer in AR:

```html
<app-viewer [labelRender]="'sprite'" />
```

## Development server

```bash
ng serve
```

Open `http://localhost:4200/`. **Room AR** must be tested on a **real device** with WebXR AR support; desktop browsers often report AR as unsupported.

## Building

```bash
ng build
```

Output in `dist/`.

## Unit tests

```bash
ng test
```

## Additional resources

[Angular CLI reference](https://angular.dev/tools/cli)
