# 3dViewer

Angular + Three.js viewer for a Vodafone router GLB with:

- **3D view** — orbit the model and hotspots (default after load).
- **Marker AR** — [AR.js](https://ar-js-org.github.io/AR.js/) + `getUserMedia`: tracks a **Hiro** pattern marker (`public/ar-js/patt.hiro`) so the router and labels stay locked to the marker. Works in typical WebViews **without WebXR**.
- **Room AR (WebXR)** — optional hit-test placement, transient tap hits, anchors when the platform supports them (see previous behaviour).

Hotspot labels: **CSS2D** (default) or **sprite** if your WebView mis-layers CSS (`[labelRender]="'sprite'"`).

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 19.2.15.

## Marker AR assets

Calibration and pattern files are served from the app root:

- [`public/ar-js/camera_para.dat`](public/ar-js/camera_para.dat)
- [`public/ar-js/patt.hiro`](public/ar-js/patt.hiro)

`THREEx.ArToolkitContext.baseURL` is set to `ar-js/` under the page origin so those URLs resolve correctly. Replace `patt.hiro` with a [custom pattern](https://ar-js-org.github.io/AR.js/three.js/marker-training/) if Vodafone ships their own marker image.

## Embedding (WebView)

Use **HTTPS**. **Marker AR** needs **camera** permission. **Room AR** additionally needs **WebXR `immersive-ar`** with **hit-test** (and ideally **dom-overlay** for the toolbar).

| Topic | Marker AR | Room AR |
|--------|-----------|---------|
| URL | HTTPS | HTTPS |
| Camera | Required | Required |
| WebXR | No | Yes (`immersive-ar`, hit-test) |

## Development server

```bash
ng serve
```

Open `http://localhost:4200/`. **Marker AR** and **Room AR** need a **real device** with a camera; use a printed or on-screen Hiro marker for marker mode.

## Building

```bash
ng build
```

Output in `dist/`. The AR.js dependency increases the main bundle size; adjust Angular **budgets** in `angular.json` if needed.

## Unit tests

```bash
ng test
```

## Additional resources

[Angular CLI reference](https://angular.dev/tools/cli)
