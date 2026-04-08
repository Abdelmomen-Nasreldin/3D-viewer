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
  DirectionalLight,
  Camera,
  Group,
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
  private static readonly MINDAR_LOCAL_URL = '/mindar-image-three.prod.js';
  private static readonly MINDAR_CDN_URL =
    'https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-three.prod.js';
  private static readonly CARD_MIND_URL =
    'https://cdn.jsdelivr.net/gh/hiukim/mind-ar-js@1.2.5/examples/image-tracking/assets/card-example/card.mind';
  private static mindarLoadPromise?: Promise<void>;

  @ViewChild('arContainer', { static: true })
  private readonly containerRef!: ElementRef<HTMLDivElement>;

  arStarted = false;
  targetVisible = false;
  statusText = 'Start AR, then point to the printed card target.';

  private mindarThree?: MindARThreeInstance;
  private renderer?: WebGLRenderer;
  private modelGroup?: Group;

  async startAr(): Promise<void> {
    if (this.arStarted) {
      return;
    }

    this.statusText = 'Loading AR engine...';
    await this.ensureMindARLoaded();

    const MindARThreeCtor = window.MINDAR?.IMAGE?.MindARThree;
    if (!MindARThreeCtor) {
      this.statusText = 'MindAR SDK failed to load. Refresh and try again.';
      return;
    }

    this.statusText = 'Starting camera and image tracking...';

    try {
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
      };
      anchor.onTargetLost = () => {
        this.targetVisible = false;
        this.statusText = 'Target lost. Point camera back to the printed card.';
      };

      await this.loadModel(anchor.group);
      await mindarThree.start();
      renderer.setAnimationLoop(() => {
        renderer.render(scene, camera);
      });

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

    const wrapper = new Group();
    wrapper.add(model);
    parent.add(wrapper);

    this.modelGroup = wrapper;
  }

  private ensureMindARLoaded(): Promise<void> {
    if (window.MINDAR?.IMAGE?.MindARThree) {
      return Promise.resolve();
    }

    if (ViewerComponent.mindarLoadPromise) {
      return ViewerComponent.mindarLoadPromise;
    }

    ViewerComponent.mindarLoadPromise = this.loadMindARScript(
      ViewerComponent.MINDAR_LOCAL_URL,
    ).catch(() => this.loadMindARScript(ViewerComponent.MINDAR_CDN_URL));

    return ViewerComponent.mindarLoadPromise;
  }

  private loadMindARScript(src: string): Promise<void> {
    if (window.MINDAR?.IMAGE?.MindARThree) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const existingScript = document.querySelector(`script[data-mindar-src="${src}"]`);
      if (existingScript) {
        existingScript.addEventListener('load', () => resolve(), { once: true });
        existingScript.addEventListener('error', () => reject(new Error('Script load error')), {
          once: true,
        });
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset['mindarSrc'] = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.body.appendChild(script);
    });
  }
}
