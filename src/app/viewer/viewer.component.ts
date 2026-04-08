import {
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  AmbientLight,
  Box3,
  BoxGeometry,
  DoubleSide,
  DirectionalLight,
  Camera,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

interface MindARAnchor {
  group: Group;
  onTargetFound?: () => void;
  onTargetLost?: () => void;
}

interface MindARThreeInstance {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: Camera;
  addAnchor: (index: number) => MindARAnchor;
  start: () => Promise<void>;
  stop: () => void;
}

declare global {
  interface Window {
    MINDAR?: {
      IMAGE?: {
        MindARThree?: new (options: {
          container: HTMLElement;
          imageTargetSrc: string;
          uiScanning?: boolean;
          uiLoading?: boolean;
          uiError?: boolean;
        }) => MindARThreeInstance;
      };
    };
  }
}

@Component({
  selector: 'app-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="viewer-shell">
      <div #arContainer class="ar-container"></div>

      <div class="overlay-panel" *ngIf="!arStarted || !!statusText">
        <button
          type="button"
          class="start-btn"
          (click)="startAr()"
          [disabled]="arStarted"
          *ngIf="!arStarted"
        >
          Start AR
        </button>
        <p class="status-text">{{ statusText }}</p>
        <p class="hint-text" *ngIf="arStarted && !targetVisible">
          Point your camera to the printed card target.
        </p>
        <p class="hint-text" *ngIf="!arStarted">
          Print this target first:
          <a
            class="marker-link"
            href="https://cdn.jsdelivr.net/gh/hiukim/mind-ar-js@1.2.5/examples/image-tracking/assets/card-example/card.png"
            target="_blank"
            rel="noreferrer"
            >Open printable target</a
          >
        </p>
      </div>
    </div>
  `,
  styles: [
    `
      :host,
      .viewer-shell {
        display: block;
        position: fixed;
        inset: 0;
        width: 100%;
        height: 100%;
      }

      .ar-container {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }

      .overlay-panel {
        position: absolute;
        left: 50%;
        bottom: 20px;
        transform: translateX(-50%);
        z-index: 20;
        min-width: 220px;
        max-width: calc(100% - 24px);
        padding: 12px 14px;
        border-radius: 12px;
        background: rgba(10, 25, 47, 0.78);
        border: 1px solid rgba(255, 255, 255, 0.14);
        backdrop-filter: blur(6px);
        color: #fff;
        text-align: center;
      }

      .start-btn {
        border: 0;
        border-radius: 10px;
        padding: 10px 14px;
        font-size: 14px;
        font-weight: 600;
        color: #0a192f;
        background: #7dd3fc;
      }

      .marker-link {
        display: inline-block;
        margin-top: 6px;
        color: #7dd3fc;
      }

      .status-text,
      .hint-text {
        margin: 8px 0 0;
        font-size: 13px;
        line-height: 1.35;
      }
    `,
  ],
})
export class ViewerComponent implements OnDestroy {
  private static readonly DEBUG_BUILD = 'debug-build-2026-04-08T14:20Z';
  private static readonly MINDAR_CDN_URL =
    'https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-three.prod.js';
  private static readonly MINDAR_CDN_FALLBACK_URL =
    'https://unpkg.com/mind-ar@1.2.5/dist/mindar-image-three.prod.js';
  private static readonly CARD_MIND_URL =
    'https://cdn.jsdelivr.net/gh/hiukim/mind-ar-js@1.2.5/examples/image-tracking/assets/card-example/card.mind';
  private static mindarLoadPromise?: Promise<void>;
  private static readonly DEBUG_ENDPOINT =
    'http://127.0.0.1:7913/ingest/77e9c71a-58dc-48e1-991b-949e089be7ff';
  private static readonly DEBUG_SESSION_ID = '31b045';

  @ViewChild('arContainer', { static: true })
  private readonly containerRef!: ElementRef<HTMLDivElement>;

  arStarted = false;
  targetVisible = false;
  statusText = 'Start AR, then point to the printed card target.';

  private mindarThree?: MindARThreeInstance;
  private renderer?: WebGLRenderer;
  private modelGroup?: Group;
  private debugCube?: Mesh;
  private debugPlane?: Mesh;
  private currentRunId = `run-${Date.now()}`;

  async startAr(): Promise<void> {
    if (this.arStarted) {
      return;
    }

    try {
      this.currentRunId = `run-${Date.now()}`;
      // #region agent log
      this.debugLog('H15_BUILD_STAMP', ViewerComponent.DEBUG_BUILD);
      this.debugLog('H4_BASE_URI', `baseURI=${document.baseURI}, location=${location.href}`);
      // #endregion
      this.statusText = 'Loading AR engine...';
      await this.ensureMindARLoaded();

      const MindARThreeCtor = this.browserGlobal.MINDAR?.IMAGE?.MindARThree;
      if (!MindARThreeCtor) {
        this.statusText = 'MindAR SDK loaded but constructor is missing.';
        return;
      }

      this.statusText = 'Starting camera and image tracking...';

      const mindarThree = new MindARThreeCtor({
        container: this.containerRef.nativeElement,
        imageTargetSrc: ViewerComponent.CARD_MIND_URL,
        uiLoading: false,
        uiScanning: false,
        uiError: false,
      });
      this.mindarThree = mindarThree;

      const { renderer, scene, camera } = mindarThree;
      this.renderer = renderer;

      scene.add(new AmbientLight(0xffffff, 1.1));
      const keyLight = new DirectionalLight(0xffffff, 1.4);
      keyLight.position.set(2.5, 4, 1.5);
      scene.add(keyLight);

      const anchor = mindarThree.addAnchor(0);
      anchor.onTargetFound = () => {
        this.targetVisible = true;
        this.statusText = 'Target detected. Move around the router.';
        // #region agent log
        this.debugLog(
          'H7_TARGET_FOUND',
          `anchor found; modelLoaded=${!!this.modelGroup}; modelVisible=${this.modelGroup?.visible ?? false}; modelChildren=${this.modelGroup?.children.length ?? 0}; debugCube=${!!this.debugCube}`,
        );
        this.logMindARDomState('H12_ON_TARGET_FOUND_DOM');
        this.debugLog(
          'H14_CULL_STATE',
          `wrapperVisible=${this.modelGroup?.visible ?? 'n/a'}; debugVisible=${this.debugCube?.visible ?? 'n/a'}; planeVisible=${this.debugPlane?.visible ?? 'n/a'}; wrapperPos=(${this.modelGroup?.position.x ?? 0},${this.modelGroup?.position.y ?? 0},${this.modelGroup?.position.z ?? 0}); debugPos=(${this.debugCube?.position.x ?? 0},${this.debugCube?.position.y ?? 0},${this.debugCube?.position.z ?? 0}); planePos=(${this.debugPlane?.position.x ?? 0},${this.debugPlane?.position.y ?? 0},${this.debugPlane?.position.z ?? 0})`,
        );
        // #endregion
      };
      anchor.onTargetLost = () => {
        this.targetVisible = false;
        this.statusText = 'Target lost. Point camera back to the printed card.';
        // #region agent log
        this.debugLog('H7_TARGET_LOST', 'anchor lost');
        // #endregion
      };

      await this.loadModel(anchor.group);
      // #region agent log
      this.debugLog(
        'H6_AFTER_LOAD_MODEL',
        `anchorChildren=${anchor.group.children.length}; modelVisible=${this.modelGroup?.visible ?? false}`,
      );
      // #endregion
      await mindarThree.start();
      // #region agent log
      this.logMindARDomState('H12_AFTER_START_DOM');
      // #endregion
      renderer.setAnimationLoop(() => {
        renderer.render(scene, camera);
      });
      // #region agent log
      this.debugLog(
        'H8_RENDER_LOOP_SET',
        `rendererCanvas=${renderer.domElement.width}x${renderer.domElement.height}`,
      );
      // #endregion

      this.arStarted = true;
      this.statusText = 'Point your camera to the printed card target.';
    } catch (error) {
      this.statusText =
        error instanceof Error
          ? error.message
          : 'AR start failed. Please allow camera access and reload.';
    }
  }

  ngOnDestroy(): void {
    this.renderer?.setAnimationLoop(null);
    this.mindarThree?.stop();
    this.renderer?.dispose();
    this.containerRef.nativeElement.innerHTML = '';
    this.modelGroup = undefined;
    this.debugCube = undefined;
    this.debugPlane = undefined;
  }

  private async loadModel(parent: Group): Promise<void> {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync('/router.glb');
    const model = gltf.scene;

    model.traverse((obj) => {
      obj.castShadow = false;
      obj.receiveShadow = false;
    });

    // Center model origin to make tap placement predictable.
    const box = new Box3().setFromObject(model);
    const center = box.getCenter(new Vector3());
    model.position.sub(center);

    const size = box.getSize(new Vector3()).length() || 1;
    const scale = 0.9 / size;
    model.scale.setScalar(scale);
    model.position.y += 0.2;
    model.position.z -= 0.08;
    // #region agent log
    this.debugLog(
      'H6_MODEL_BOUNDS',
      `boxCenter=(${center.x.toFixed(3)},${center.y.toFixed(3)},${center.z.toFixed(3)}); diag=${size.toFixed(6)}; scale=${scale.toFixed(6)}; pos=(${model.position.x.toFixed(3)},${model.position.y.toFixed(3)},${model.position.z.toFixed(3)})`,
    );
    // #endregion

    const wrapper = new Group();
    wrapper.add(model);
    parent.add(wrapper);

    this.modelGroup = wrapper;

    // #region agent log
    let meshCount = 0;
    let transparentCount = 0;
    model.traverse((obj) => {
      if (obj instanceof Mesh) {
        meshCount += 1;
        const mat = obj.material;
        const mats = Array.isArray(mat) ? mat : [mat];
        transparentCount += mats.filter((m) => (m as MeshBasicMaterial).transparent).length;
      }
    });
    this.debugLog(
      'H10_MATERIAL_INFO',
      `meshCount=${meshCount}; transparentMaterialCount=${transparentCount}`,
    );
    // #endregion

    const debugGeometry = new BoxGeometry(0.6, 0.6, 0.6);
    const debugMaterial = new MeshBasicMaterial({ color: 0xff00ff });
    const debugCube = new Mesh(debugGeometry, debugMaterial);
    debugCube.position.set(0, 0.3, -0.2);
    parent.add(debugCube);
    this.debugCube = debugCube;
    // #region agent log
    this.debugLog(
      'H9_DEBUG_CUBE_ADDED',
      `debugCubePos=(${debugCube.position.x.toFixed(3)},${debugCube.position.y.toFixed(3)},${debugCube.position.z.toFixed(3)})`,
    );
    // #endregion

    const debugPlaneGeometry = new PlaneGeometry(1.2, 1.2);
    const debugPlaneMaterial = new MeshBasicMaterial({
      color: 0xffff00,
      side: DoubleSide,
      transparent: true,
      opacity: 0.5,
    });
    const debugPlane = new Mesh(debugPlaneGeometry, debugPlaneMaterial);
    debugPlane.position.set(0, 0, -0.22);
    parent.add(debugPlane);
    this.debugPlane = debugPlane;
    // #region agent log
    this.debugLog(
      'H16_DEBUG_PLANE_ADDED',
      `debugPlanePos=(${debugPlane.position.x.toFixed(3)},${debugPlane.position.y.toFixed(3)},${debugPlane.position.z.toFixed(3)})`,
    );
    // #endregion
    // #region agent log
    this.debugLog(
      'H7_MODEL_ATTACHED',
      `parentChildren=${parent.children.length}; wrapperChildren=${wrapper.children.length}; wrapperVisible=${wrapper.visible}`,
    );
    // #endregion
  }

  private ensureMindARLoaded(): Promise<void> {
    if (this.browserGlobal.MINDAR?.IMAGE?.MindARThree) {
      return Promise.resolve();
    }

    if (ViewerComponent.mindarLoadPromise) {
      return ViewerComponent.mindarLoadPromise;
    }

    ViewerComponent.mindarLoadPromise = this.loadMindARModule(
      ViewerComponent.MINDAR_CDN_URL,
    ).catch((cdnError) =>
      this.loadMindARModule(ViewerComponent.MINDAR_CDN_FALLBACK_URL).catch((fallbackError) => {
        throw new Error(
          `MindAR load failed: jsdelivr=${this.getErrorMessage(cdnError)} | unpkg=${this.getErrorMessage(fallbackError)}`,
        );
      }),
    );

    return ViewerComponent.mindarLoadPromise;
  }

  private async loadMindARModule(src: string): Promise<void> {
    if (this.browserGlobal.MINDAR?.IMAGE?.MindARThree) {
      return;
    }

    const moduleUrl = src.startsWith('http') ? src : new URL(src, document.baseURI).toString();
    // #region agent log
    this.debugLog('H1_IMPORT_ATTEMPT', `import(${moduleUrl})`);
    // #endregion
    try {
      await import(/* webpackIgnore: true */ moduleUrl);
      // #region agent log
      this.debugLog('H1_IMPORT_OK', `import resolved for ${src}, MINDAR exists: ${!!this.browserGlobal.MINDAR}, IMAGE exists: ${!!this.browserGlobal.MINDAR?.IMAGE}, Ctor exists: ${!!this.browserGlobal.MINDAR?.IMAGE?.MindARThree}`);
      // #endregion
    } catch (importError: unknown) {
      // #region agent log
      this.debugLog('H1_IMPORT_FAILED', `import() threw for ${src}: ${importError instanceof Error ? importError.message : String(importError)}`);
      // #endregion
      throw importError;
    }
    await this.waitForMindARGlobal();
  }

  private waitForMindARGlobal(timeoutMs = 4000): Promise<void> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const check = (): void => {
        if (this.browserGlobal.MINDAR?.IMAGE?.MindARThree) {
          resolve();
          return;
        }

        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error('MindAR global was not initialized in time.'));
          return;
        }

        setTimeout(check, 50);
      };
      check();
    });
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }

  private get browserGlobal(): Window {
    return globalThis as unknown as Window;
  }

  // #region agent log
  private logMindARDomState(tag: string): void {
    const container = this.containerRef.nativeElement;
    const rendererCanvas = this.renderer?.domElement;
    const video = container.querySelector('video') as HTMLVideoElement | null;
    const queryCanvas = container.querySelector('canvas') as HTMLCanvasElement | null;
    const rendererStyle = rendererCanvas ? getComputedStyle(rendererCanvas) : null;
    const videoStyle = video ? getComputedStyle(video) : null;
    const containerStyle = getComputedStyle(container);
    this.debugLog(
      tag,
      `children=${container.children.length}; containerPos=${containerStyle.position}; containerZ=${containerStyle.zIndex}; renderer=${!!rendererCanvas}; rendererZ=${rendererStyle?.zIndex ?? 'none'}; rendererDisplay=${rendererStyle?.display ?? 'none'}; rendererOpacity=${rendererStyle?.opacity ?? 'none'}; queryCanvas=${!!queryCanvas}; video=${!!video}; videoZ=${videoStyle?.zIndex ?? 'none'}; videoDisplay=${videoStyle?.display ?? 'none'}; videoOpacity=${videoStyle?.opacity ?? 'none'}`,
    );
  }

  private readonly debugLogs: string[] = [];
  private debugLog(tag: string, msg: string): void {
    const entry = `[${tag}] ${msg}`;
    this.debugLogs.push(entry);
    console.log(`[DEBUG-31b045] ${entry}`);
    let el = document.getElementById('debug-31b045');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'debug-31b045';
      el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:rgba(0,0,0,0.85);color:#0f0;font-size:10px;padding:8px;max-height:40vh;overflow:auto;pointer-events:auto;white-space:pre-wrap;word-break:break-all;';
      document.body.appendChild(el);
    }
    el.textContent = this.debugLogs.join('\n');
    const hypothesisId = tag.includes('_') ? tag.split('_')[0] : tag;
    fetch(ViewerComponent.DEBUG_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': ViewerComponent.DEBUG_SESSION_ID }, body: JSON.stringify({ sessionId: ViewerComponent.DEBUG_SESSION_ID, runId: this.currentRunId, hypothesisId, location: 'src/app/viewer/viewer.component.ts:debugLog', message: tag, data: { msg }, timestamp: Date.now() }) }).catch(() => {});
  }
  // #endregion
}
