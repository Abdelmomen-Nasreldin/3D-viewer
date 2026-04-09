import { Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';

interface MindARAnchor {
  group: any;
  onTargetFound?: () => void;
  onTargetLost?: () => void;
}

interface MindARThreeInstance {
  renderer: any;
  scene: any;
  camera: any;
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
        <button type="button" class="start-btn" (click)="startAr()" [disabled]="arStarted" *ngIf="!arStarted">
          Start AR
        </button>
        <p class="status-text">{{ statusText }}</p>
        <p class="hint-text" *ngIf="arStarted && !targetVisible">
          Point your camera to the printed logo target.
        </p>
        <p class="hint-text" *ngIf="!arStarted">
          Print this target first:
          <a
            class="marker-link"
            [href]="printableTargetUrl"
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
  private static readonly THREE_MODULE_URL = 'https://unpkg.com/three@0.160.0/build/three.module.js';
  private static readonly THREE_GLTF_LOADER_URL =
    'https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
  private static readonly MINDAR_CDN_URL =
    'https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-three.prod.js';
  private static readonly MINDAR_CDN_FALLBACK_URL =
    'https://unpkg.com/mind-ar@1.2.5/dist/mindar-image-three.prod.js';
  private static readonly TARGET_MIND_URL = '/logo.mind';
  private static mindarLoadPromise?: Promise<void>;
  private static runtimeThreePromise?: Promise<any>;
  private static runtimeThree?: any;
  private static runtimeGLTFLoaderCtor?: any;

  @ViewChild('arContainer', { static: true })
  private readonly containerRef!: ElementRef<HTMLDivElement>;

  arStarted = false;
  targetVisible = false;
  statusText = 'Start AR, then point to the printed logo target.';
  readonly printableTargetUrl = '/logo.jpg';

  private mindarThree?: MindARThreeInstance;
  private renderer?: any;
  private modelGroup?: any;

  async startAr(): Promise<void> {
    if (this.arStarted) {
      return;
    }

    try {
      this.statusText = 'Loading AR engine...';
      await this.ensureMindARLoaded();
      await this.ensureThreeRuntimeLoaded();
      await this.assertMindTargetExists();

      const MindARThreeCtor = this.browserGlobal.MINDAR?.IMAGE?.MindARThree;
      if (!MindARThreeCtor) {
        this.statusText = 'MindAR SDK loaded but constructor is missing.';
        return;
      }

      this.statusText = 'Starting camera and image tracking...';

      const mindarThree = new MindARThreeCtor({
        container: this.containerRef.nativeElement,
        imageTargetSrc: ViewerComponent.TARGET_MIND_URL,
        uiLoading: false,
        uiScanning: false,
        uiError: false,
      });
      this.mindarThree = mindarThree;

      const { renderer, scene, camera } = mindarThree;
      this.renderer = renderer;

      const THREE = ViewerComponent.runtimeThree;
      scene.add(new THREE.AmbientLight(0xffffff, 1.1));
      const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
      keyLight.position.set(2.5, 4, 1.5);
      scene.add(keyLight);

      const anchor = mindarThree.addAnchor(0);
      anchor.onTargetFound = () => {
        this.targetVisible = true;
        this.statusText = 'Target detected. Move around the router.';
      };
      anchor.onTargetLost = () => {
        this.targetVisible = false;
        this.statusText = 'Target lost. Point camera back to the printed logo.';
      };

      await this.loadModel(anchor.group);
      await mindarThree.start();
      renderer.setAnimationLoop(() => renderer.render(scene, camera));

      this.arStarted = true;
      this.statusText = 'Point your camera to the printed logo target.';
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
  }

  private async loadModel(parent: any): Promise<void> {
    const THREE = ViewerComponent.runtimeThree;
    const GLTFLoaderCtor = ViewerComponent.runtimeGLTFLoaderCtor;
    if (!THREE || !GLTFLoaderCtor) {
      throw new Error('Three runtime is not initialized.');
    }

    const loader = new GLTFLoaderCtor();
    const gltf = await loader.loadAsync('/router.glb');
    const model = gltf.scene;

    model.traverse((obj: any) => {
      obj.castShadow = false;
      obj.receiveShadow = false;
    });

    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);

    const sizeVec = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(sizeVec.x, sizeVec.y, sizeVec.z) || 1;
    const scale = 1.2 / maxDim;
    model.scale.setScalar(scale);
    model.position.y += 0.03;
    model.position.z -= 0.03;

    const wrapper = new THREE.Group();
    wrapper.add(model);
    parent.add(wrapper);
    this.modelGroup = wrapper;
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

  private ensureThreeRuntimeLoaded(): Promise<void> {
    if (ViewerComponent.runtimeThree && ViewerComponent.runtimeGLTFLoaderCtor) {
      return Promise.resolve();
    }
    if (ViewerComponent.runtimeThreePromise) {
      return ViewerComponent.runtimeThreePromise;
    }

    ViewerComponent.runtimeThreePromise = (async () => {
      const threeModule = await import(/* webpackIgnore: true */ ViewerComponent.THREE_MODULE_URL);
      const gltfModule = await import(
        /* webpackIgnore: true */ ViewerComponent.THREE_GLTF_LOADER_URL
      );

      ViewerComponent.runtimeThree = threeModule;
      ViewerComponent.runtimeGLTFLoaderCtor = gltfModule.GLTFLoader;
      if (!ViewerComponent.runtimeGLTFLoaderCtor) {
        throw new Error('GLTFLoader export was not found in runtime module.');
      }
    })().catch((error: unknown) => {
      ViewerComponent.runtimeThreePromise = undefined;
      throw error;
    });

    return ViewerComponent.runtimeThreePromise;
  }

  private async loadMindARModule(src: string): Promise<void> {
    if (this.browserGlobal.MINDAR?.IMAGE?.MindARThree) {
      return;
    }

    const moduleUrl = src.startsWith('http') ? src : new URL(src, document.baseURI).toString();
    await import(/* webpackIgnore: true */ moduleUrl);
    await this.waitForMindARGlobal();
  }

  private async assertMindTargetExists(): Promise<void> {
    const response = await fetch(ViewerComponent.TARGET_MIND_URL, {
      method: 'GET',
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(
        'Missing /logo.mind. Generate it from logo.jpg using MindAR Compiler and place it in public/logo.mind.',
      );
    }
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
}
