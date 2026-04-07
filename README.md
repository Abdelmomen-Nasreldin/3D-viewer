# 3dViewer

Angular + Three.js **AR-only** experience for a Vodafone router GLB (no separate 3D orbit viewer). The model appears only inside an AR session:

- **Marker AR** — [AR.js](https://ar-js-org.github.io/AR.js/) + camera: tracks a **Hiro** pattern (`public/ar-js/patt.hiro`). Works in many WebViews **without WebXR**.
- **Room AR (WebXR)** — hit-test placement, transient taps, anchors when the device supports them.

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 19.2.15.

## Marker AR assets

- [`public/ar-js/camera_para.dat`](public/ar-js/camera_para.dat)
- [`public/ar-js/patt.hiro`](public/ar-js/patt.hiro)

`THREEx.ArToolkitContext.baseURL` is set to `ar-js/` under the page origin. Replace `patt.hiro` with a [custom pattern](https://ar-js-org.github.io/AR.js/three.js/marker-training/) if you ship your own marker.

## Embedding (WebView)

Use **HTTPS**. **Marker AR** needs **camera** permission. **Room AR** additionally needs **WebXR `immersive-ar`** with **hit-test** (and ideally **dom-overlay** for the toolbar).

| Topic | Marker AR | Room AR |
|--------|-----------|---------|
| URL | HTTPS | HTTPS |
| Camera | Required | Required |
| WebXR | No | Yes |

## Development server

```bash
ng serve
```

Test on a **real device** with a camera; use a Hiro marker for marker AR.

## Building

```bash
ng build
```

Adjust Angular **budgets** in `angular.json` if the AR.js bundle exceeds your limits.

## Unit tests

```bash
ng test
```

## Additional resources

[Angular CLI reference](https://angular.dev/tools/cli)
