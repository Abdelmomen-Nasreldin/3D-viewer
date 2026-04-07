import {
  Component,
  ElementRef,
  AfterViewInit,
  OnDestroy,
  ViewChild,
  NgZone,
  ChangeDetectorRef,
  inject,
  input,
  signal,
} from '@angular/core';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  CSS2DRenderer,
  CSS2DObject,
} from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Annotation } from '../services/annotation.model';

/** WebXR hit-test batch (not always in TS DOM lib). */
interface TransientHitTestBatch {
  readonly results: ReadonlyArray<XRHitTestResult>;
}

/**
 * Hotspot labels: `css2d` (default) or `sprite` if CSS2D misbehaves in a WebView.
 */
export type ViewerLabelRender = 'css2d' | 'sprite';

/**
 * Hardcoded annotations for the Vodafone router.
 * Fine-tune positions against your GLB (e.g. temporary logging from a desktop Three.js scene).
 */
const ROUTER_ANNOTATIONS: Annotation[] = [
  { id: 'power-led', position: [-0.9, 0.25, 0.75], text: 'Power LED — Solid green = powered on' },
  { id: 'internet-led', position: [-0.55, 0.25, 0.75], text: 'Internet LED — Green = connected, Red = no signal' },
  { id: 'wifi-led', position: [-0.2, 0.25, 0.75], text: 'Wi-Fi LED — Blinking = active traffic' },
  { id: 'phone-led', position: [0.15, 0.25, 0.75], text: 'Phone LED — Green = VoIP registered' },
  { id: 'vodafone-logo', position: [0.7, 0.25, 0.75], text: 'Vodafone Branding' },
  { id: 'power-port', position: [-1.1, 0.15, -0.75], text: 'DC Power Input — 12V adapter' },
  { id: 'power-switch', position: [-0.85, 0.15, -0.75], text: 'Power On/Off Switch' },
  { id: 'dsl-port', position: [-0.5, 0.1, -0.75], text: 'DSL/Fibre WAN Port — Connect to wall socket' },
  { id: 'eth-1', position: [-0.1, 0.1, -0.75], text: 'LAN Port 1 (Gigabit Ethernet)' },
  { id: 'eth-2', position: [0.2, 0.1, -0.75], text: 'LAN Port 2 (Gigabit Ethernet)' },
  { id: 'eth-3', position: [0.5, 0.1, -0.75], text: 'LAN Port 3 (Gigabit Ethernet)' },
  { id: 'eth-4', position: [0.8, 0.1, -0.75], text: 'LAN Port 4 (Gigabit Ethernet)' },
  { id: 'phone-port', position: [1.05, 0.1, -0.75], text: 'Phone Port (RJ11) — Analogue handset' },
  { id: 'usb-port', position: [1.3, 0.15, -0.75], text: 'USB Port — Storage / printer sharing' },
  { id: 'wps-button', position: [1.4, 0.25, 0], text: 'WPS Button — Quick pairing button' },
  { id: 'reset-button', position: [-1.4, 0.1, -0.2], text: 'Reset Pinhole — Hold 10s to factory reset' },
  { id: 'ventilation', position: [0, 0.5, 0], text: 'Ventilation — Keep clear for airflow' },
];

@Component({
  selector: 'app-viewer',
  standalone: true,
  templateUrl: './viewer.component.html',
  styleUrl: './viewer.component.scss',
  host: {
    class: 'viewer-host',
  },
})
export class ViewerComponent implements AfterViewInit, OnDestroy {
  /** Set to `sprite` if CSS2D labels fail inside your WebView. */
  readonly labelRender = input<ViewerLabelRender>('css2d');

  @ViewChild('rendererContainer', { static: true })
  containerRef!: ElementRef<HTMLDivElement>;

  @ViewChild('domOverlayRoot', { static: true })
  domOverlayRef!: ElementRef<HTMLDivElement>;

  readonly arSupported = signal(false);
  readonly arChecked = signal(false);
  readonly arSessionActive = signal(false);
  readonly modelLoaded = signal(false);

  private renderer!: THREE.WebGLRenderer;
  private css2DRenderer!: CSS2DRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private resizeObserver!: ResizeObserver;
  private model: THREE.Group | null = null;
  private readonly placedGroup = new THREE.Group();
  private reticle!: THREE.Mesh;
  private arHemisphere: THREE.HemisphereLight | null = null;

  private hitTestSource: XRHitTestSource | null = null;
  /** True while `requestHitTestSource` is in flight (avoids stacking requests). */
  private hitTestSourceInFlight = false;
  /** After a failed/empty acquire, retry when `debugArFrame` reaches this value (bounded cadence for WebView). */
  private hitTestRetryAfterFrame = 0;
  private transientHitTestSource: XRTransientInputHitTestSource | null = null;
  private sessionSelectHandler: ((e: Event) => void) | null = null;
  private xrSessionRef: XRSession | null = null;
  /** Latest continuous viewer hit used for reticle-based placement on tap. */
  private lastViewerHitResult: XRHitTestResult | null = null;
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpScale = new THREE.Vector3();

  private spriteMaterials: THREE.SpriteMaterial[] = [];
  private spriteNodes: THREE.Sprite[] = [];

  private readonly zone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Throttle for debug ingest (session 05b9d9). */
  private debugArFrame = 0;

  // #region agent log
  private dbgLog(
    hypothesisId: string,
    location: string,
    message: string,
    data: Record<string, unknown>,
    runId = 'post-fix-v2'
  ): void {
    fetch('http://127.0.0.1:7913/ingest/77e9c71a-58dc-48e1-991b-949e089be7ff', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': '05b9d9',
      },
      body: JSON.stringify({
        sessionId: '05b9d9',
        runId,
        hypothesisId,
        location,
        message,
        data,
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    console.debug('[ARDBG]', { hypothesisId, location, message, data, runId, t: Date.now() });
  }
  // #endregion

  /** Prefer `local-floor` in required features so hit poses match Three’s floor reference space (immersive-web hit-test pattern). */
  private async requestImmersiveArSession(overlayRoot: HTMLElement): Promise<XRSession | null> {
    if (!navigator.xr) return null;
    const attempts: { label: string; init: XRSessionInit }[] = [
      {
        label: 'floor_dom_overlay',
        init: {
          requiredFeatures: ['hit-test', 'local-floor'],
          optionalFeatures: ['dom-overlay', 'local'],
          domOverlay: { root: overlayRoot },
        },
      },
      {
        label: 'floor_minimal',
        init: {
          requiredFeatures: ['hit-test', 'local-floor'],
          optionalFeatures: ['local'],
        },
      },
      {
        label: 'legacy_dom_overlay',
        init: {
          requiredFeatures: ['hit-test'],
          optionalFeatures: ['dom-overlay', 'local', 'local-floor'],
          domOverlay: { root: overlayRoot },
        },
      },
      {
        label: 'legacy_minimal',
        init: {
          requiredFeatures: ['hit-test'],
          optionalFeatures: ['local', 'local-floor'],
        },
      },
    ];
    for (const { label, init } of attempts) {
      try {
        const session = await navigator.xr.requestSession('immersive-ar', init);
        // #region agent log
        this.dbgLog('A', 'viewer.component.ts:requestImmersiveArSession', 'session acquired', {
          label,
          enabledFeatures: [...(session.enabledFeatures ?? [])],
        });
        // #endregion
        return session;
      } catch {
        continue;
      }
    }
    // #region agent log
    this.dbgLog('A', 'viewer.component.ts:requestImmersiveArSession', 'all session attempts failed', {});
    // #endregion
    return null;
  }

  ngAfterViewInit(): void {
    this.initScene();
    this.initRenderers();
    this.initLights();
    this.initReticle();
    this.initXrControllers();
    this.placedGroup.visible = false;
    this.scene.add(this.placedGroup);
    this.loadModel();
    this.renderer.setAnimationLoop((t, frame) => this.onAnimationFrame(t, frame));
    this.checkArSupport();
  }

  ngOnDestroy(): void {
    this.renderer?.setAnimationLoop(null);
    const session = this.renderer?.xr.getSession();
    if (session) {
      session.end();
    }
    this.resizeObserver?.disconnect();
    this.clearSpriteLabels();
    this.renderer?.dispose();
    this.css2DRenderer?.domElement.remove();
  }

  async startArSession(): Promise<void> {
    if (!navigator.xr || !this.arSupported() || !this.modelLoaded()) return;

    const overlayRoot = this.domOverlayRef.nativeElement;

    try {
      const session = await this.requestImmersiveArSession(overlayRoot);
      if (!session) {
        console.warn('WebXR AR: could not start session with any feature set');
        return;
      }
      const floorGranted = session.enabledFeatures?.includes('local-floor') ?? false;
      this.renderer.xr.setReferenceSpaceType(floorGranted ? 'local-floor' : 'local');
      // #region agent log
      this.dbgLog('B', 'viewer.component.ts:startArSession', 'placement mode', {
        refSpace: floorGranted ? 'local-floor' : 'local',
      });
      // #endregion
      await this.renderer.xr.setSession(session);

      this.xrSessionRef = session;
      session.addEventListener('end', () => this.onArSessionEnded());
      this.sessionSelectHandler = (e: Event) => {
        void this.onArSelect(e);
      };
      session.addEventListener('select', this.sessionSelectHandler);

      void this.requestTransientHitTestSource(session);

      this.applyArPresentationStyle();
      this.placedGroup.visible = false;
      this.arSessionActive.set(true);
      this.zone.run(() => this.cdr.markForCheck());
    } catch (err) {
      console.warn('WebXR AR session failed:', err);
    }
  }

  endArSession(): void {
    this.renderer?.xr.getSession()?.end();
  }

  private onArSessionEnded(): void {
    if (this.xrSessionRef && this.sessionSelectHandler) {
      this.xrSessionRef.removeEventListener('select', this.sessionSelectHandler);
      this.sessionSelectHandler = null;
    }
    this.xrSessionRef = null;

    this.hitTestSourceInFlight = false;
    this.hitTestRetryAfterFrame = 0;
    if (this.hitTestSource) {
      this.hitTestSource.cancel();
      this.hitTestSource = null;
    }
    if (this.transientHitTestSource) {
      this.transientHitTestSource.cancel();
      this.transientHitTestSource = null;
    }

    this.lastViewerHitResult = null;

    this.applyIdlePresentationStyle();
    this.placedGroup.visible = false;
    this.reticle.visible = false;
    this.arSessionActive.set(false);
    this.zone.run(() => this.cdr.markForCheck());
  }

  private checkArSupport(): void {
    if (!('xr' in navigator) || !navigator.xr) {
      this.arChecked.set(true);
      return;
    }
    navigator.xr
      .isSessionSupported('immersive-ar')
      .then((supported) => {
        this.zone.run(() => {
          this.arSupported.set(supported);
          this.arChecked.set(true);
          this.cdr.markForCheck();
        });
      })
      .catch(() => {
        this.zone.run(() => {
          this.arSupported.set(false);
          this.arChecked.set(true);
          this.cdr.markForCheck();
        });
      });
  }

  private initScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);

    const container = this.containerRef.nativeElement;
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 1000);
    this.camera.position.set(0, 1.6, 0);
  }

  private initRenderers(): void {
    const container = this.containerRef.nativeElement;
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.xr.enabled = true;
    container.appendChild(this.renderer.domElement);

    this.css2DRenderer = new CSS2DRenderer();
    this.css2DRenderer.setSize(w, h);
    this.css2DRenderer.domElement.style.position = 'absolute';
    this.css2DRenderer.domElement.style.top = '0';
    this.css2DRenderer.domElement.style.left = '0';
    this.css2DRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(this.css2DRenderer.domElement);

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(container);
  }

  private initLights(): void {
    this.arHemisphere = new THREE.HemisphereLight(0xffffff, 0x444466, 2.2);
    this.arHemisphere.position.set(0.5, 1, 0.25);
    this.arHemisphere.visible = false;
    this.scene.add(this.arHemisphere);
  }

  private initReticle(): void {
    const geom = new THREE.RingGeometry(0.18, 0.28, 48).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00d4ff,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    this.reticle = new THREE.Mesh(geom, mat);
    this.reticle.matrixAutoUpdate = false;
    this.reticle.renderOrder = 999;
    this.reticle.visible = false;
    this.scene.add(this.reticle);
  }

  private initXrControllers(): void {
    for (let i = 0; i < 2; i++) {
      this.scene.add(this.renderer.xr.getController(i));
    }
  }

  private async requestTransientHitTestSource(session: XRSession): Promise<void> {
    type SessionWithTransient = XRSession & {
      requestHitTestSourceForTransientInput?: (opts: {
        profile: string;
      }) => Promise<XRTransientInputHitTestSource>;
    };
    const s = session as SessionWithTransient;
    if (typeof s.requestHitTestSourceForTransientInput !== 'function') {
      console.debug('Room AR: requestHitTestSourceForTransientInput not supported');
      return;
    }
    const profiles = ['touch', 'generic-touchscreen'];
    for (const profile of profiles) {
      try {
        const source = await s.requestHitTestSourceForTransientInput({ profile });
        if (source) {
          this.transientHitTestSource = source;
          return;
        }
      } catch {
        continue;
      }
    }
    console.debug('Room AR: could not create transient hit-test source for profiles', profiles);
  }

  private async onArSelect(ev?: Event): Promise<void> {
    const referenceSpace = this.renderer.xr.getReferenceSpace();
    if (!referenceSpace) return;

    if (this.reticle.visible) {
      if (this.lastViewerHitResult) {
        const hit = this.lastViewerHitResult;
        const pose = hit.getPose(referenceSpace);
        if (pose) {
          this.tmpMatrix.fromArray(pose.transform.matrix);
          this.applyPlacedGroupFromMatrix(this.tmpMatrix);
        }
        // #region agent log
        this.dbgLog('C', 'viewer.component.ts:onArSelect', 'placement path', {
          path: 'reticle_lastViewerHit',
          poseOk: !!pose,
        });
        // #endregion
      } else {
        this.applyPlacedGroupFromMatrix(this.reticle.matrix);
        // #region agent log
        this.dbgLog('C', 'viewer.component.ts:onArSelect', 'placement path', {
          path: 'reticle_matrix_only',
        });
        // #endregion
      }
      this.placedGroup.visible = true;
      return;
    }

    const xrEvent = ev as XRInputSourceEvent | undefined;
    if (this.transientHitTestSource && xrEvent?.frame) {
      const hit = this.firstTransientHitResult(xrEvent.frame, xrEvent);
      if (hit) {
        const pose = hit.getPose(referenceSpace);
        if (pose) {
          this.tmpMatrix.fromArray(pose.transform.matrix);
          this.applyPlacedGroupFromMatrix(this.tmpMatrix);
          this.placedGroup.visible = true;
        }
        // #region agent log
        this.dbgLog('C', 'viewer.component.ts:onArSelect', 'placement path', {
          path: 'transient_hit',
          poseOk: !!pose,
        });
        // #endregion
        return;
      }
      console.debug('Room AR: transient hit test returned no results');
    }

    if (!this.placedGroup.visible) {
      this.applyFallbackPlacement();
      // #region agent log
      this.dbgLog('C', 'viewer.component.ts:onArSelect', 'placement path', {
        path: 'fallback_local_space',
      });
      // #endregion
    }
  }

  private firstTransientHitResult(
    frame: XRFrame,
    event: XRInputSourceEvent
  ): XRHitTestResult | null {
    if (!this.transientHitTestSource) return null;
    const fn = (frame as XRFrame & { getHitTestResultsForTransientInput?: unknown })
      .getHitTestResultsForTransientInput;
    if (typeof fn !== 'function') return null;
    const batches = (
      fn as (
        src: XRTransientInputHitTestSource,
        ev: XRInputSourceEvent
      ) => ReadonlyArray<TransientHitTestBatch>
    ).call(frame, this.transientHitTestSource, event);
    for (const batch of batches) {
      for (const result of batch.results) {
        return result;
      }
    }
    return null;
  }

  /** Sets `placedGroup` from a 4×4 pose in the XR reference space (`local-floor` or `local`), not viewer/camera space. */
  private applyPlacedGroupFromMatrix(matrix: THREE.Matrix4): void {
    matrix.decompose(
      this.placedGroup.position,
      this.placedGroup.quaternion,
      this.tmpScale
    );
    this.placedGroup.scale.set(1, 1, 1);
  }

  /** Last resort in local space when continuous reticle and transient hits both miss (first placement only). */
  private applyFallbackPlacement(): void {
    this.placedGroup.position.set(0, -0.45, -1.1);
    this.placedGroup.quaternion.identity();
    this.placedGroup.scale.set(1, 1, 1);
    this.placedGroup.visible = true;
  }

  private resolveModelUrl(): string {
    try {
      return new URL('router.glb', document.baseURI).href;
    } catch {
      return 'router.glb';
    }
  }

  private loadModel(): void {
    const loader = new GLTFLoader();
    loader.load(
      this.resolveModelUrl(),
      (gltf) => {
        this.model = gltf.scene;

        const box = new THREE.Box3().setFromObject(this.model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 3 / maxDim;

        this.model.scale.setScalar(scale);
        this.model.position.sub(center.multiplyScalar(scale));

        this.placedGroup.add(this.model);
        this.placeAnnotations();
        this.modelLoaded.set(true);
        this.zone.run(() => this.cdr.markForCheck());
      },
      undefined,
      (error) => console.error('Error loading router.glb:', error)
    );
  }

  private placeAnnotations(): void {
    const mode = this.labelRender();
    if (mode === 'sprite') {
      this.placeSpriteAnnotations();
    } else {
      this.placeCss2dAnnotations();
    }

    for (const ann of ROUTER_ANNOTATIONS) {
      const [x, y, z] = ann.position;
      if (x === 0 && y === 0 && z === 0) continue;

      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.03, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0x00d4ff })
      );
      dot.position.set(x, y, z);
      this.placedGroup.add(dot);
    }
  }

  private placeCss2dAnnotations(): void {
    for (const ann of ROUTER_ANNOTATIONS) {
      const [x, y, z] = ann.position;
      if (x === 0 && y === 0 && z === 0) continue;

      const wrapper = document.createElement('div');
      wrapper.className = 'annotation-label';
      wrapper.innerHTML = `
        <span class="annotation-dot-connector"></span>
        <span class="annotation-text">${ann.text}</span>
      `;

      const label = new CSS2DObject(wrapper);
      label.position.set(x, y, z);
      this.placedGroup.add(label);
    }
  }

  private placeSpriteAnnotations(): void {
    this.clearSpriteLabels();
    const worldScale = 0.008;

    for (const ann of ROUTER_ANNOTATIONS) {
      const [x, y, z] = ann.position;
      if (x === 0 && y === 0 && z === 0) continue;

      const sprite = this.createTextSprite(ann.text);
      sprite.position.set(x, y + 0.12, z);
      const sw = sprite.userData['width'] as number;
      const sh = sprite.userData['height'] as number;
      sprite.scale.set(sw * worldScale, sh * worldScale, 1);
      this.placedGroup.add(sprite);
      this.spriteNodes.push(sprite);
    }
  }

  private createTextSprite(text: string): THREE.Sprite {
    const pad = 16;
    const fontSize = 28;
    const maxW = 640;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;

    const words = text.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);

    const lineH = Math.round(fontSize * 1.35);
    const textW = Math.max(...lines.map((l) => ctx.measureText(l).width), 40);
    canvas.width = Math.ceil(Math.min(textW + pad * 2, maxW + pad * 2));
    canvas.height = lines.length * lineH + pad * 2;

    ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(10, 25, 47, 0.94)';
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.35)';
    ctx.lineWidth = 2;
    const W = canvas.width;
    const H = canvas.height;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeRect(1, 1, W - 2, H - 2);

    ctx.fillStyle = '#ccd6f6';
    lines.forEach((l, i) => {
      ctx.fillText(l, pad, pad + fontSize + i * lineH);
    });

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
    this.spriteMaterials.push(mat);
    const sprite = new THREE.Sprite(mat);
    sprite.userData['width'] = W;
    sprite.userData['height'] = H;
    sprite.center.set(0.5, 0);
    return sprite;
  }

  private clearSpriteLabels(): void {
    for (const s of this.spriteNodes) {
      this.placedGroup.remove(s);
    }
    this.spriteNodes = [];
    for (const m of this.spriteMaterials) {
      m.map?.dispose();
      m.dispose();
    }
    this.spriteMaterials = [];
  }

  private applyArPresentationStyle(): void {
    this.scene.background = null;
    this.renderer.setClearColor(0x000000, 0);
    if (this.arHemisphere) {
      this.arHemisphere.visible = true;
    }
    this.scene.environment = null;
    this.reticle.visible = false;
  }

  private applyIdlePresentationStyle(): void {
    this.scene.background = new THREE.Color(0x1a1a2e);
    this.renderer.setClearColor(0x000000, 1);
    if (this.arHemisphere) {
      this.arHemisphere.visible = false;
    }
    this.scene.environment = null;
  }

  private onResize(): void {
    const container = this.containerRef.nativeElement;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.css2DRenderer.setSize(w, h);
  }

  private onAnimationFrame(_time: number, frame: XRFrame | null): void {
    const presenting = this.renderer.xr.isPresenting;

    if (presenting && frame) {
      const referenceSpace = this.renderer.xr.getReferenceSpace();
      const session = this.renderer.xr.getSession();
      if (referenceSpace && session) {
        this.debugArFrame += 1;

        const scheduleHitTestRetry = (framesFromNow: number): void => {
          this.hitTestRetryAfterFrame = this.debugArFrame + framesFromNow;
        };

        if (!this.hitTestSource && !this.hitTestSourceInFlight) {
          if (this.debugArFrame >= this.hitTestRetryAfterFrame) {
            this.hitTestSourceInFlight = true;
            void session
              .requestReferenceSpace('viewer')
              .then((viewerSpace) => {
                if (typeof session.requestHitTestSource !== 'function') return undefined;
                return session.requestHitTestSource({ space: viewerSpace });
              })
              .then((source) => {
                this.hitTestSourceInFlight = false;
                if (source) {
                  this.hitTestSource = source;
                } else {
                  console.warn('Room AR: continuous hit-test source returned empty');
                  scheduleHitTestRetry(30);
                }
                // #region agent log
                this.dbgLog('A', 'viewer.component.ts:onAnimationFrame', 'hitTestSource resolved', {
                  hasSource: !!source,
                });
                // #endregion
              })
              .catch((err) => {
                this.hitTestSourceInFlight = false;
                scheduleHitTestRetry(30);
                console.warn('Room AR: continuous hit-test source failed', err);
                // #region agent log
                this.dbgLog('A', 'viewer.component.ts:onAnimationFrame', 'hitTestSource rejected', {
                  err: String(err),
                });
                // #endregion
              });
          }
        }

        if (this.hitTestSource) {
          let dbgHitLen = -2;
          let dbgHitPoseOk = false;
          const viewerPose = frame.getViewerPose(referenceSpace);
          if (!viewerPose) {
            this.lastViewerHitResult = null;
            this.reticle.visible = false;
            dbgHitLen = -3;
          } else {
            const results = frame.getHitTestResults(this.hitTestSource);
            dbgHitLen = results.length;
            if (results.length > 0) {
              const pose = results[0].getPose(referenceSpace);
              dbgHitPoseOk = !!pose;
              if (pose) {
                this.lastViewerHitResult = results[0];
                this.reticle.visible = true;
                this.tmpMatrix.fromArray(pose.transform.matrix);
                this.reticle.matrix.copy(this.tmpMatrix);
              } else {
                this.lastViewerHitResult = null;
                this.reticle.visible = false;
              }
            } else {
              this.lastViewerHitResult = null;
              this.reticle.visible = false;
            }
          }
          // #region agent log
          if (this.debugArFrame % 30 === 0) {
            const p = this.placedGroup.position;
            this.dbgLog('A', 'viewer.component.ts:onAnimationFrame', 'xr frame sample', {
              resultsLen: dbgHitLen,
              reticleVisible: this.reticle.visible,
              poseOk: dbgHitPoseOk,
              viewerPoseOk: !!viewerPose,
              placedVisible: this.placedGroup.visible,
              pgX: Math.round(p.x * 1000) / 1000,
              pgY: Math.round(p.y * 1000) / 1000,
              pgZ: Math.round(p.z * 1000) / 1000,
            });
          }
          // #endregion
        } else if (this.debugArFrame % 30 === 0) {
          // #region agent log
          this.dbgLog('A', 'viewer.component.ts:onAnimationFrame', 'xr frame sample', {
            resultsLen: -1,
            reticleVisible: this.reticle.visible,
            hitSourceReady: false,
            placedVisible: this.placedGroup.visible,
          });
          // #endregion
        }
      }
    }

    this.renderer.render(this.scene, this.camera);
    this.css2DRenderer.render(this.scene, this.camera);
  }
}
