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
  computed,
} from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  CSS2DRenderer,
  CSS2DObject,
} from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Annotation } from '../services/annotation.model';

/**
 * Hotspot labels: `css2d` (default) or `sprite` if CSS2D misbehaves in a WebView.
 */
export type ViewerLabelRender = 'css2d' | 'sprite';

/**
 * Hardcoded annotations for the Vodafone router.
 *
 * Positions are estimated for a typical router shape. Fine-tune them:
 *   1. Place your router.glb in the public/ folder and run `ng serve`
 *   2. Click anywhere on the model -- the 3D point is logged to the browser console
 *   3. Copy the logged [x, y, z] values into the position tuples below
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
  { id: 'wps-button', position: [1.4, 0.25, 0], text: 'WPS Button — Press to pair devices' },
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
  /** Live camera + model overlay — works in typical WebViews via getUserMedia (no WebXR). */
  readonly cameraSessionActive = signal(false);
  readonly immersiveActive = computed(
    () => this.arSessionActive() || this.cameraSessionActive()
  );

  private renderer!: THREE.WebGLRenderer;
  private css2DRenderer!: CSS2DRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private resizeObserver!: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly mouse = new THREE.Vector2();
  private model: THREE.Group | null = null;
  private readonly placedGroup = new THREE.Group();
  private reticle!: THREE.Mesh;
  private arHemisphere: THREE.HemisphereLight | null = null;
  private readonly orbitLights: THREE.Object3D[] = [];

  private hitTestSource: XRHitTestSource | null = null;
  private hitTestSourceRequested = false;
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();

  private spriteMaterials: THREE.SpriteMaterial[] = [];
  private spriteNodes: THREE.Sprite[] = [];

  private mediaStream: MediaStream | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private videoTexture: THREE.VideoTexture | null = null;
  private videoMesh: THREE.Mesh | null = null;
  private readonly savedOrbitCameraPos = new THREE.Vector3();
  private readonly savedOrbitCameraQuat = new THREE.Quaternion();
  private readonly savedOrbitTarget = new THREE.Vector3();
  private readonly camPointers = new Map<number, { x: number; y: number }>();
  private pinchRef: { dist: number; scale: number } | null = null;
  private readonly camDragSens = 0.0028;

  private readonly zone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);

  ngAfterViewInit(): void {
    this.initScene();
    this.initRenderers();
    this.initLights();
    this.initControls();
    this.initReticle();
    this.initXrControllers();
    this.initDevClickLogger();
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
    this.stopCameraSession();
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.clearSpriteLabels();
    this.renderer?.dispose();
    this.css2DRenderer?.domElement.remove();
  }

  focus3DView(): void {
    this.exitImmersive();
  }

  exitImmersive(): void {
    if (this.renderer?.xr.isPresenting) {
      this.renderer.xr.getSession()?.end();
    }
    this.stopCameraSession();
  }

  async startCameraSession(): Promise<void> {
    if (this.cameraSessionActive()) return;
    if (this.renderer?.xr.isPresenting) {
      this.renderer.xr.getSession()?.end();
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn('getUserMedia is not available in this context.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      this.mediaStream = stream;

      const video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.setAttribute('playsinline', 'true');
      video.srcObject = stream;
      await video.play();
      this.videoEl = video;

      const tex = new THREE.VideoTexture(video);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.videoTexture = tex;

      const geom = new THREE.PlaneGeometry(1, 1);
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = -2000;
      this.videoMesh = mesh;
      this.camera.add(mesh);
      this.updateVideoBackdropScale();
      video.addEventListener('loadedmetadata', () => this.updateVideoBackdropScale());

      this.scene.remove(this.placedGroup);
      this.camera.add(this.placedGroup);
      this.placedGroup.position.set(0, -0.06, -1.15);
      this.placedGroup.quaternion.identity();
      this.placedGroup.scale.set(1, 1, 1);

      this.savedOrbitCameraPos.copy(this.camera.position);
      this.savedOrbitCameraQuat.copy(this.camera.quaternion);
      this.savedOrbitTarget.copy(this.controls.target);
      this.camera.position.set(0, 0, 0);
      this.camera.quaternion.identity();
      this.controls.target.set(0, 0, -1);
      this.controls.update();
      this.controls.enabled = false;

      this.applyArPresentationStyle();
      this.renderer.domElement.style.touchAction = 'none';
      this.setupCameraPointerHandlers();

      this.cameraSessionActive.set(true);
      this.zone.run(() => this.cdr.markForCheck());
    } catch (err) {
      console.warn('Camera overlay session failed:', err);
      this.mediaStream?.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
      this.zone.run(() => this.cdr.markForCheck());
    }
  }

  async startArSession(): Promise<void> {
    this.stopCameraSession();
    if (!navigator.xr || !this.arSupported()) return;

    const overlayRoot = this.domOverlayRef.nativeElement;
    const withOverlay: XRSessionInit = {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'local'],
      domOverlay: { root: overlayRoot },
    };
    const minimal: XRSessionInit = {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['local'],
    };

    try {
      let session: XRSession;
      try {
        session = await navigator.xr.requestSession('immersive-ar', withOverlay);
      } catch {
        session = await navigator.xr.requestSession('immersive-ar', minimal);
      }
      session.addEventListener('end', () => this.onArSessionEnded());

      this.renderer.xr.setReferenceSpaceType('local');
      await this.renderer.xr.setSession(session);

      this.controls.enabled = false;
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
    this.hitTestSourceRequested = false;
    if (this.hitTestSource) {
      this.hitTestSource.cancel();
      this.hitTestSource = null;
    }

    this.controls.enabled = true;
    this.applyOrbitPresentationStyle();
    this.placedGroup.visible = true;
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
    this.camera.position.set(0, 2, 5);
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
    const ambient = new THREE.AmbientLight('#ffffff', 0.6);
    this.scene.add(ambient);
    this.orbitLights.push(ambient);

    const dir = new THREE.DirectionalLight('#ffffff', 0.8);
    dir.position.set(5, 10, 7);
    dir.castShadow = true;
    this.scene.add(dir);
    this.orbitLights.push(dir);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const envTexture = pmrem.fromScene(new THREE.Scene(), 0, 0.1, 100);
    this.scene.environment = envTexture.texture;
    pmrem.dispose();

    this.arHemisphere = new THREE.HemisphereLight(0xffffff, 0x444466, 2.2);
    this.arHemisphere.position.set(0.5, 1, 0.25);
    this.arHemisphere.visible = false;
    this.scene.add(this.arHemisphere);
  }

  private initControls(): void {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 50;
  }

  private initReticle(): void {
    const geom = new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00d4ff });
    this.reticle = new THREE.Mesh(geom, mat);
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.reticle);
  }

  private initXrControllers(): void {
    for (let i = 0; i < 2; i++) {
      const c = this.renderer.xr.getController(i);
      c.addEventListener('select', () => this.onArSelect());
      this.scene.add(c);
    }
  }

  private onArSelect(): void {
    if (!this.reticle.visible) return;
    this.reticle.matrix.decompose(
      this.placedGroup.position,
      this.placedGroup.quaternion,
      this.tmpScale
    );
    this.placedGroup.scale.set(1, 1, 1);
    this.placedGroup.visible = true;
  }

  private initDevClickLogger(): void {
    this.renderer.domElement.addEventListener('click', (event: MouseEvent) => {
      if (!this.model || this.renderer.xr.isPresenting || this.cameraSessionActive()) return;

      const rect = this.renderer.domElement.getBoundingClientRect();
      this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      this.raycaster.setFromCamera(this.mouse, this.camera);
      const hits = this.raycaster.intersectObject(this.model, true);

      if (hits.length > 0) {
        const p = hits[0].point;
        console.log(
          `Annotation point: [${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}]`
        );
      }
    });
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

        this.camera.position.set(2.5, 2, 5);
        this.controls.target.set(0, 0, 0);
        this.controls.update();

        this.placeAnnotations();
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
    for (const o of this.orbitLights) {
      o.visible = false;
    }
    if (this.arHemisphere) {
      this.arHemisphere.visible = true;
    }
    this.scene.environment = null;
    this.reticle.visible = false;
  }

  private applyOrbitPresentationStyle(): void {
    this.scene.background = new THREE.Color(0x1a1a2e);
    this.renderer.setClearColor(0x000000, 1);
    for (const o of this.orbitLights) {
      o.visible = true;
    }
    if (this.arHemisphere) {
      this.arHemisphere.visible = false;
    }

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const envTexture = pmrem.fromScene(new THREE.Scene(), 0, 0.1, 100);
    this.scene.environment = envTexture.texture;
    pmrem.dispose();
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
    if (this.cameraSessionActive()) {
      this.updateVideoBackdropScale();
    }
  }

  private onAnimationFrame(_time: number, frame: XRFrame | null): void {
    const presenting = this.renderer.xr.isPresenting;

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
              this.reticle.visible = true;
              this.tmpMatrix.fromArray(pose.transform.matrix);
              this.reticle.matrix.copy(this.tmpMatrix);
            }
          } else {
            this.reticle.visible = false;
          }
        }
      }
    } else if (!this.cameraSessionActive()) {
      this.controls.update();
    }

    this.renderer.render(this.scene, this.camera);
    this.css2DRenderer.render(this.scene, this.camera);
  }

  private stopCameraSession(): void {
    if (!this.cameraSessionActive() && !this.mediaStream && !this.videoMesh) return;

    this.teardownCameraPointerHandlers();
    this.teardownVideoBackdrop();

    if (this.placedGroup.parent === this.camera) {
      this.camera.remove(this.placedGroup);
      this.scene.add(this.placedGroup);
    }
    this.placedGroup.position.set(0, 0, 0);
    this.placedGroup.quaternion.identity();
    this.placedGroup.scale.set(1, 1, 1);

    this.camera.position.copy(this.savedOrbitCameraPos);
    this.camera.quaternion.copy(this.savedOrbitCameraQuat);
    this.controls.target.copy(this.savedOrbitTarget);
    this.controls.update();

    this.controls.enabled = true;
    this.renderer.domElement.style.touchAction = '';
    this.applyOrbitPresentationStyle();

    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;

    this.cameraSessionActive.set(false);
    this.zone.run(() => this.cdr.markForCheck());
  }

  private teardownVideoBackdrop(): void {
    if (this.videoMesh) {
      this.camera.remove(this.videoMesh);
      this.videoMesh.geometry.dispose();
      const mat = this.videoMesh.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
      this.videoMesh = null;
    }
    this.videoTexture = null;
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.srcObject = null;
      this.videoEl = null;
    }
  }

  private updateVideoBackdropScale(): void {
    if (!this.videoMesh || !this.videoEl) return;
    const v = this.videoEl;
    if (v.videoWidth === 0 || v.videoHeight === 0) return;

    const dist = 14;
    const videoAspect = v.videoWidth / v.videoHeight;
    const viewAspect = this.camera.aspect;
    const vFovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const viewH = 2 * Math.tan(vFovRad / 2) * dist;
    const viewW = viewH * viewAspect;

    let planeW = viewH * videoAspect;
    let planeH = viewH;
    if (planeW < viewW) {
      planeW = viewW;
      planeH = planeW / videoAspect;
    }

    this.videoMesh.scale.set(planeW, planeH, 1);
    this.videoMesh.position.set(0, 0, -dist);
  }

  private setupCameraPointerHandlers(): void {
    const el = this.renderer.domElement;
    const opts = { passive: false };
    el.addEventListener('pointerdown', this.onCamPointerDown, opts);
    el.addEventListener('pointermove', this.onCamPointerMove, opts);
    el.addEventListener('pointerup', this.onCamPointerUp, opts);
    el.addEventListener('pointercancel', this.onCamPointerUp, opts);
  }

  private teardownCameraPointerHandlers(): void {
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onCamPointerDown);
    el.removeEventListener('pointermove', this.onCamPointerMove);
    el.removeEventListener('pointerup', this.onCamPointerUp);
    el.removeEventListener('pointercancel', this.onCamPointerUp);
    this.camPointers.clear();
    this.pinchRef = null;
  }

  private readonly onCamPointerDown = (e: PointerEvent): void => {
    if (!this.cameraSessionActive()) return;
    e.preventDefault();
    this.camPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.camPointers.size === 2) {
      this.pinchRef = {
        dist: this.getPinchDistance(),
        scale: this.placedGroup.scale.x,
      };
    }
  };

  private readonly onCamPointerMove = (e: PointerEvent): void => {
    if (!this.cameraSessionActive() || !this.camPointers.has(e.pointerId)) return;
    e.preventDefault();

    const prev = this.camPointers.get(e.pointerId)!;
    this.camPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.camPointers.size === 2) {
      if (!this.pinchRef) {
        this.pinchRef = {
          dist: this.getPinchDistance(),
          scale: this.placedGroup.scale.x,
        };
      }
      const d = this.getPinchDistance();
      if (d > 1 && this.pinchRef) {
        const s = THREE.MathUtils.clamp(
          this.pinchRef.scale * (d / this.pinchRef.dist),
          0.35,
          3.5
        );
        this.placedGroup.scale.setScalar(s);
      }
      return;
    }

    if (this.camPointers.size === 1) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      this.placedGroup.position.x -= dx * this.camDragSens;
      this.placedGroup.position.y += dy * this.camDragSens;
    }
  };

  private readonly onCamPointerUp = (e: PointerEvent): void => {
    if (!this.camPointers.has(e.pointerId)) return;
    e.preventDefault();
    this.camPointers.delete(e.pointerId);
    if (this.camPointers.size < 2) {
      this.pinchRef = null;
    }
  };

  private getPinchDistance(): number {
    const pts = [...this.camPointers.values()];
    if (pts.length < 2) return 0;
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.hypot(dx, dy);
  }
}
