import {
  Component,
  ElementRef,
  AfterViewInit,
  OnDestroy,
  ViewChild,
  NgZone,
  ChangeDetectorRef,
  inject,
  signal,
} from '@angular/core';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { THREEx } from '@ar-js-org/ar.js-threejs';

/** WebXR hit-test batch (not always in TS DOM lib). */
interface TransientHitTestBatch {
  readonly results: ReadonlyArray<XRHitTestResult>;
}

/** When the `anchors` feature is granted, hit results can create world-locked anchors. */
type HitResultWithAnchor = XRHitTestResult & {
  createAnchor?: () => Promise<XRAnchor>;
};

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
  @ViewChild('rendererContainer', { static: true })
  containerRef!: ElementRef<HTMLDivElement>;

  @ViewChild('domOverlayRoot', { static: true })
  domOverlayRef!: ElementRef<HTMLDivElement>;

  readonly arSupported = signal(false);
  readonly arChecked = signal(false);
  readonly arSessionActive = signal(false);
  readonly markerArActive = signal(false);
  readonly markerArBusy = signal(false);
  readonly modelLoaded = signal(false);

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private resizeObserver!: ResizeObserver;
  private model: THREE.Group | null = null;
  private readonly placedGroup = new THREE.Group();
  private reticle!: THREE.Mesh;
  private arHemisphere: THREE.HemisphereLight | null = null;

  private arToolkitSource: InstanceType<typeof THREEx.ArToolkitSource> | null = null;
  private arToolkitContext: InstanceType<typeof THREEx.ArToolkitContext> | null = null;
  private arMarkerControls: InstanceType<typeof THREEx.ArMarkerControls> | null = null;
  private markerRoot: THREE.Group | null = null;

  private hitTestSource: XRHitTestSource | null = null;
  private hitTestSourceRequested = false;
  private transientHitTestSource: XRTransientInputHitTestSource | null = null;
  private sessionSelectHandler: ((e: Event) => void) | null = null;
  private xrSessionRef: XRSession | null = null;
  /** Latest continuous viewer hit; used with reticle for `createAnchor` on tap. */
  private lastViewerHitResult: XRHitTestResult | null = null;
  /** Drives `placedGroup` pose every frame so the model stays fixed in the real world. */
  private placementAnchor: XRAnchor | null = null;
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpScale = new THREE.Vector3();

  /**
   * `loadModel` normalizes the GLB so its largest axis ≈ 3 units; in WebXR that reads like meters and feels huge.
   * Scale the whole placed group only while room AR is presenting.
   */
  private readonly roomArPlacedScale = 0.14;

  private readonly zone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);

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
    this.stopMarkerArSession();
    this.clearPlacementAnchor();
    this.resizeObserver?.disconnect();
    this.renderer?.dispose();
  }

  async startMarkerArSession(): Promise<void> {
    if (!this.modelLoaded() || this.markerArActive() || this.markerArBusy()) return;

    this.markerArBusy.set(true);
    this.zone.run(() => this.cdr.markForCheck());

    if (this.renderer.xr.isPresenting) {
      this.endArSession();
    }

    this.stopMarkerArSession();

    try {
      this.applyArPresentationStyle();
      THREEx.ArToolkitContext.baseURL = this.arJsAssetBaseUrl();

      const wide = window.innerWidth > window.innerHeight;
      this.arToolkitSource = new THREEx.ArToolkitSource({
        sourceType: 'webcam',
        sourceWidth: wide ? 640 : 480,
        sourceHeight: wide ? 480 : 640,
      });

      this.markerArActive.set(true);

      this.arToolkitSource.init(
        () => {
          const el = this.arToolkitSource!.domElement as HTMLElement;
          el.remove();
          const container = this.containerRef.nativeElement;
          container.insertBefore(el, this.renderer.domElement);

          const video = el as HTMLVideoElement;
          const bootContext = () => {
            if (!this.arToolkitContext) {
              this.initMarkerArContext();
            }
          };
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            bootContext();
          } else {
            video.addEventListener('canplay', bootContext, { once: true });
          }

          setTimeout(() => this.resizeMarkerArToContainer(), 400);
          this.markerArBusy.set(false);
          this.zone.run(() => this.cdr.markForCheck());
        },
        () => {
          console.error('AR.js: webcam init failed');
          this.stopMarkerArSession();
          this.markerArBusy.set(false);
          this.zone.run(() => this.cdr.markForCheck());
        }
      );
    } catch (e) {
      console.error('AR.js: start failed', e);
      this.stopMarkerArSession();
      this.markerArBusy.set(false);
      this.zone.run(() => this.cdr.markForCheck());
    }
  }

  stopMarkerArSession(): void {
    if (
      !this.markerArActive() &&
      !this.arToolkitSource &&
      !this.arToolkitContext &&
      !this.arMarkerControls &&
      !this.markerRoot
    ) {
      return;
    }

    if (this.arMarkerControls) {
      try {
        this.arMarkerControls.dispose();
      } catch {
        /* ignore */
      }
      this.arMarkerControls = null;
    }

    this.arToolkitContext = null;

    if (this.arToolkitSource?.domElement) {
      const video = this.arToolkitSource.domElement as HTMLVideoElement;
      const stream = video.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      video.remove();
    }
    this.arToolkitSource = null;

    this.placedGroup.removeFromParent();
    this.scene.add(this.placedGroup);
    this.resetPlacedGroupTransform();
    this.placedGroup.visible = false;

    if (this.markerRoot) {
      this.markerRoot.removeFromParent();
      this.markerRoot = null;
    }

    this.markerArActive.set(false);
    this.markerArBusy.set(false);
    this.applyIdlePresentationStyle();
    this.zone.run(() => this.cdr.markForCheck());
  }

  async startArSession(): Promise<void> {
    if (!navigator.xr || !this.arSupported() || !this.modelLoaded()) return;

    this.stopMarkerArSession();

    const overlayRoot = this.domOverlayRef.nativeElement;
    const withOverlay: XRSessionInit = {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'local', 'local-floor', 'anchors'],
      domOverlay: { root: overlayRoot },
    };
    const minimal: XRSessionInit = {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['local', 'local-floor', 'anchors'],
    };

    try {
      let session: XRSession;
      try {
        session = await navigator.xr.requestSession('immersive-ar', withOverlay);
      } catch {
        session = await navigator.xr.requestSession('immersive-ar', minimal);
      }
      this.renderer.xr.setReferenceSpaceType('local-floor');
      await this.renderer.xr.setSession(session);

      this.xrSessionRef = session;
      session.addEventListener('end', () => this.onArSessionEnded());
      this.sessionSelectHandler = (e: Event) => {
        void this.onArSelect(e);
      };
      session.addEventListener('select', this.sessionSelectHandler);

      void this.requestTransientHitTestSource(session);

      this.applyArPresentationStyle();
      this.ensurePlacedGroupOnSceneForWebXr();
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

    this.hitTestSourceRequested = false;
    if (this.hitTestSource) {
      this.hitTestSource.cancel();
      this.hitTestSource = null;
    }
    if (this.transientHitTestSource) {
      this.transientHitTestSource.cancel();
      this.transientHitTestSource = null;
    }

    this.clearPlacementAnchor();
    this.lastViewerHitResult = null;

    this.applyIdlePresentationStyle();
    this.ensurePlacedGroupOnSceneForWebXr();
    this.resetPlacedGroupTransform();
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

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(container);
  }

  private initLights(): void {
    this.arHemisphere = new THREE.HemisphereLight(0xffffff, 0x444466, 2.2);
    this.arHemisphere.position.set(0.5, 1, 0.25);
    this.arHemisphere.visible = false;
    this.scene.add(this.arHemisphere);
  }

  private arJsAssetBaseUrl(): string {
    return new URL('ar-js/', document.baseURI).href;
  }

  private getArSourceOrientation(): string {
    const el = this.arToolkitSource?.domElement as HTMLVideoElement | undefined;
    if (!el || !el.videoWidth || !el.videoHeight) {
      return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
    }
    return el.videoWidth > el.videoHeight ? 'landscape' : 'portrait';
  }

  private initMarkerArContext(): void {
    if (!this.arToolkitSource || this.arToolkitContext) return;

    this.markerRoot = new THREE.Group();
    this.markerRoot.matrixAutoUpdate = false;
    this.scene.add(this.markerRoot);

    this.placedGroup.removeFromParent();
    this.markerRoot.add(this.placedGroup);
    this.placedGroup.visible = true;
    this.placedGroup.position.set(0, 0.08, 0);
    this.placedGroup.quaternion.identity();
    this.placedGroup.scale.set(1, 1, 1);

    const base = this.arJsAssetBaseUrl();
    this.arToolkitContext = new THREEx.ArToolkitContext({
      cameraParametersUrl: `${base}camera_para.dat`,
      detectionMode: 'mono',
    });

    this.arToolkitContext.init(() => {
      if (!this.arToolkitContext) return;
      this.camera.projectionMatrix.copy(this.arToolkitContext.getProjectionMatrix());
      const ac = this.arToolkitContext.arController as {
        orientation?: string;
        options?: { orientation?: string };
      } | null;
      if (ac) {
        const ori = this.getArSourceOrientation();
        ac.orientation = ori;
        if (ac.options) ac.options.orientation = ori;
      }

      this.arMarkerControls = new THREEx.ArMarkerControls(this.arToolkitContext, this.markerRoot!, {
        type: 'pattern',
        patternUrl: `${base}patt.hiro`,
        changeMatrixMode: 'modelViewMatrix',
      });

      this.zone.run(() => this.cdr.markForCheck());
      setTimeout(() => this.resizeMarkerArToContainer(), 100);
    });
  }

  private resizeMarkerArToContainer(): void {
    if (!this.markerArActive() || !this.arToolkitSource?.ready) return;
    this.arToolkitSource.onResizeElement();
    this.arToolkitSource.copyElementSizeTo(this.renderer.domElement);
    const canvas = this.arToolkitContext?.arController?.canvas as HTMLElement | undefined;
    if (canvas) {
      this.arToolkitSource.copyElementSizeTo(canvas);
    }
  }

  private resetPlacedGroupTransform(): void {
    this.placedGroup.position.set(0, 0, 0);
    this.placedGroup.quaternion.identity();
    this.placedGroup.scale.set(1, 1, 1);
  }

  /** WebXR expects `placedGroup` attached to the scene, not under the AR.js marker root. */
  private ensurePlacedGroupOnSceneForWebXr(): void {
    if (this.placedGroup.parent !== this.scene) {
      this.placedGroup.removeFromParent();
      this.scene.add(this.placedGroup);
    }
  }

  private initReticle(): void {
    // Larger ring (~0.6 m outer dia.) so it’s visible; depthTest off so real-world depth doesn’t hide it in AR.
    const geom = new THREE.RingGeometry(0.22, 0.34, 48).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00e8ff,
      transparent: true,
      opacity: 0.92,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.reticle = new THREE.Mesh(geom, mat);
    this.reticle.matrixAutoUpdate = false;
    this.reticle.renderOrder = 10000;
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
    const profiles = ['touch', 'generic-touchscreen', 'generic-trigger'];
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

  private clearPlacementAnchor(): void {
    if (this.placementAnchor) {
      this.placementAnchor.delete();
      this.placementAnchor = null;
    }
  }

  private async tryBindAnchorFromHit(hit: HitResultWithAnchor): Promise<void> {
    const create = hit.createAnchor;
    if (typeof create !== 'function') return;
    try {
      const anchor = await create.call(hit);
      if (anchor) {
        this.clearPlacementAnchor();
        this.placementAnchor = anchor;
      }
    } catch {
      console.debug('Room AR: createAnchor failed or unsupported');
    }
  }

  private async onArSelect(ev?: Event): Promise<void> {
    const referenceSpace = this.renderer.xr.getReferenceSpace();
    if (!referenceSpace) return;

    if (this.reticle.visible) {
      if (this.lastViewerHitResult) {
        const hit = this.lastViewerHitResult as HitResultWithAnchor;
        const pose = hit.getPose(referenceSpace);
        if (pose) {
          this.tmpMatrix.fromArray(pose.transform.matrix);
          this.applyPlacedGroupFromMatrix(this.tmpMatrix);
          await this.tryBindAnchorFromHit(hit);
        }
      } else {
        this.applyPlacedGroupFromMatrix(this.reticle.matrix);
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
          await this.tryBindAnchorFromHit(hit as HitResultWithAnchor);
          this.placedGroup.visible = true;
        }
        return;
      }
      console.debug('Room AR: transient hit test returned no results');
    }

    if (!this.placedGroup.visible) {
      this.clearPlacementAnchor();
      this.applyFallbackPlacement();
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

  private applyPlacedGroupFromMatrix(matrix: THREE.Matrix4): void {
    matrix.decompose(
      this.placedGroup.position,
      this.placedGroup.quaternion,
      this.tmpScale
    );
    this.placedGroup.scale.setScalar(
      this.renderer.xr.isPresenting ? this.roomArPlacedScale : 1
    );
  }

  private updatePlacedGroupFromAnchor(frame: XRFrame): void {
    if (!this.placementAnchor) return;
    const referenceSpace = this.renderer.xr.getReferenceSpace();
    if (!referenceSpace) return;
    const pose = frame.getPose(
      this.placementAnchor as unknown as XRSpace,
      referenceSpace
    );
    if (!pose) return;
    this.tmpMatrix.fromArray(pose.transform.matrix);
    this.applyPlacedGroupFromMatrix(this.tmpMatrix);
  }

  /**
   * When the cyan ring never appears, continuous hit-test often fails; taps may land here.
   * Place farther than before so the model does not fill the screen like a “huge” close object.
   */
  private applyFallbackPlacement(): void {
    this.placedGroup.position.set(0, -0.85, -2.85);
    this.placedGroup.quaternion.identity();
    this.placedGroup.scale.setScalar(this.roomArPlacedScale);
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
        this.placedGroup.visible = false;
        this.modelLoaded.set(true);
        this.zone.run(() => this.cdr.markForCheck());
      },
      undefined,
      (error) => console.error('Error loading router.glb:', error)
    );
  }

  private applyArPresentationStyle(): void {
    this.scene.background = null;
    this.renderer.setClearColor(0x000000, 0);
    if (this.arHemisphere) {
      this.arHemisphere.visible = true;
    }
    this.scene.environment = null;
  }

  /** Idle launcher: no 3D preview—router is only shown inside an AR session. */
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
    this.resizeMarkerArToContainer();
  }

  private onAnimationFrame(_time: number, frame: XRFrame | null): void {
    const presenting = this.renderer.xr.isPresenting;

    if (this.markerArActive() && this.arToolkitSource?.ready && this.arToolkitContext) {
      this.arToolkitContext.update(this.arToolkitSource.domElement);
    }

    if (presenting && frame) {
      const referenceSpace = this.renderer.xr.getReferenceSpace();
      const session = this.renderer.xr.getSession();
      if (referenceSpace && session) {
        if (!this.hitTestSourceRequested) {
          session.requestReferenceSpace('viewer').then((viewerSpace) => {
            const requestHitTestSource = session.requestHitTestSource;
            if (typeof requestHitTestSource !== 'function') return;
            const hitPromise = requestHitTestSource({ space: viewerSpace });
            if (!hitPromise) return;
            void hitPromise.then((source) => {
              this.hitTestSource = source;
            });
          });
          this.hitTestSourceRequested = true;
        }

        if (this.hitTestSource) {
          const results = frame.getHitTestResults(this.hitTestSource);
          if (results.length > 0) {
            const pose = results[0].getPose(referenceSpace);
            if (pose) {
              this.lastViewerHitResult = results[0];
              this.reticle.visible = true;
              this.tmpMatrix.fromArray(pose.transform.matrix);
              this.reticle.matrix.copy(this.tmpMatrix);
            }
          } else {
            this.lastViewerHitResult = null;
            this.reticle.visible = false;
          }
        }

        if (this.placedGroup.visible && this.placementAnchor) {
          this.updatePlacedGroupFromAnchor(frame);
        }
      }
    }

    this.renderer.render(this.scene, this.camera);
  }
}
