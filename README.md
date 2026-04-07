# 3dViewer

Angular + Three.js viewer for a Vodafone router GLB, with **3D orbit view**, **Over camera** (live camera + model + labels via `getUserMedia`—no WebXR), and optional **Room AR** (WebXR hit-test when the WebView supports it).

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 19.2.15.

## Frontend-first embedding (no native app release)

The recommended path for Vodafone’s existing WebView is **Over camera**: deploy a new build of this web app only. Users get a rear-camera feed with the router and hotspot labels composited in Three.js. That uses standard **`navigator.mediaDevices.getUserMedia`**; many WebViews already allow camera for HTTPS origins without any change to the native wrapper.

**Room AR** (WebXR) is an extra when the WebView exposes `immersive-ar`; it is not required for “see the router on the camera”.

## Embedding in the Vodafone native app (WebView)

Ship this UI over **HTTPS**.

| Topic | Android | iOS |
|--------|---------|-----|
| URL | HTTPS | HTTPS |
| **Over camera** | WebView allows **camera** for this origin (often already true) | Same; standard camera permission flow for web content |
| **Room AR (WebXR)** | Recent **Android System WebView** (WebXR support varies) | **WKWebView** on an iOS version that exposes WebXR AR where supported |
| Settings | Hardware acceleration on; avoid mixed HTTP content | `allowsInlineMediaPlayback` if you use inline media |

If WebXR is missing, **Over camera** and **3D view** still work; the UI explains that room AR is unavailable in that WebView.

### Sprite labels in difficult WebViews

If CSS2D labels mis-layer or disappear in AR on a specific WebView build, use sprite labels:

```html
<app-viewer [labelRender]="'sprite'" />
```

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Karma](https://karma-runner.github.io) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
