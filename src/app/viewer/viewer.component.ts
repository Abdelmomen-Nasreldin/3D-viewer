import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  AmbientLight,
  Camera,
  Box3,
  DirectionalLight,
  Group,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { THREEx } from '@ar-js-org/ar.js-threejs';

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
          Point your camera to the marker image.
        </p>
        <p class="hint-text" *ngIf="!arStarted">
          Print this marker first:
          <a
            class="marker-link"
            href="https://cdn.jsdelivr.net/npm/@ar-js-org/ar.js-threejs@0.3.2/data/marker-artoolkit-pattern-pattratio-09.png"
            target="_blank"
            rel="noreferrer"
            >Open marker image</a
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
export class ViewerComponent implements AfterViewInit, OnDestroy {
  private static readonly CAMERA_PARAMETERS_URL =
    'https://cdn.jsdelivr.net/npm/@ar-js-org/ar.js-threejs@0.3.2/data/camera_para.dat';
  private static readonly PATTERN_URL =
    'https://cdn.jsdelivr.net/npm/@ar-js-org/ar.js-threejs@0.3.2/data/patt.hiro';

  @ViewChild('arContainer', { static: true })
  private readonly containerRef!: ElementRef<HTMLDivElement>;

  arStarted = false;
  targetVisible = false;
  statusText = 'Start AR, then point to the printed marker.';

  private readonly scene = new Scene();
  private readonly arCamera = new Camera();
  private renderer?: WebGLRenderer;
  private arToolkitSource?: InstanceType<typeof THREEx.ArToolkitSource>;
  private arToolkitContext?: InstanceType<typeof THREEx.ArToolkitContext>;
  private modelGroup?: Group;
  private markerRoot?: Group;
  private markerControls?: InstanceType<typeof THREEx.ArMarkerControls>;
  private frameHandle = 0;
  private wasTargetVisible = false;

  ngAfterViewInit(): void {
    this.initRenderer();
  }

  async startAr(): Promise<void> {
    if (this.arStarted) {
      return;
    }

    this.statusText = 'Starting camera and marker tracking...';

    try {
      this.setupArToolkit();
      await this.initArToolkitSource();
      await this.initArToolkitContext();
      this.createMarkerAnchor();
      await this.loadModel();
      this.arStarted = true;
      this.statusText = 'Point your camera to the marker image.';
      this.handleResize();
      this.animate();
    } catch (error) {
      this.statusText =
        error instanceof Error
          ? error.message
          : 'AR start failed. Please allow camera access and reload.';
    }
  }

  @HostListener('window:resize')
  onResize(): void {
    this.handleResize();
  }

  ngOnDestroy(): void {
    if (this.frameHandle) {
      cancelAnimationFrame(this.frameHandle);
    }

    this.stopCameraStream();
    this.renderer?.dispose();
    this.modelGroup = undefined;
    this.markerRoot = undefined;
    this.markerControls = undefined;
    this.removeArVideoElement();
  }

  private async loadModel(): Promise<void> {
    if (!this.markerRoot) {
      throw new Error('Marker anchor is not initialized.');
    }

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
    this.markerRoot.add(wrapper);

    this.modelGroup = wrapper;
  }

  private readonly animate = (): void => {
    this.frameHandle = requestAnimationFrame(this.animate);
    if (this.arToolkitSource?.ready) {
      this.arToolkitContext?.update(this.arToolkitSource.domElement);
      this.targetVisible = this.markerRoot?.visible ?? false;
      if (this.targetVisible !== this.wasTargetVisible) {
        this.statusText = this.targetVisible
          ? 'Marker detected. Move around the model.'
          : 'Marker lost. Point camera back to the marker.';
        this.wasTargetVisible = this.targetVisible;
      }
    }

    this.renderer?.render(this.scene, this.arCamera);
  };

  private initRenderer(): void {
    this.renderer = new WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.domElement.style.position = 'absolute';
    this.renderer.domElement.style.inset = '0';

    this.containerRef.nativeElement.innerHTML = '';
    this.containerRef.nativeElement.appendChild(this.renderer.domElement);

    this.scene.add(this.arCamera);
    this.scene.add(new AmbientLight(0xffffff, 1.1));
    const keyLight = new DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(2.5, 4, 1.5);
    this.scene.add(keyLight);
  }

  private setupArToolkit(): void {
    this.arToolkitSource = new THREEx.ArToolkitSource({
      sourceType: 'webcam',
      sourceWidth: 1280,
      sourceHeight: 720,
      displayWidth: window.innerWidth,
      displayHeight: window.innerHeight,
    });

    this.arToolkitContext = new THREEx.ArToolkitContext({
      cameraParametersUrl: ViewerComponent.CAMERA_PARAMETERS_URL,
      detectionMode: 'mono',
      maxDetectionRate: 30,
    });
  }

  private initArToolkitSource(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.arToolkitSource?.init(
        () => resolve(),
        (error: unknown) =>
          reject(
            error instanceof Error ? error : new Error('Failed to initialize camera source.'),
          ),
      );
    });
  }

  private initArToolkitContext(): Promise<void> {
    return new Promise((resolve) => {
      this.arToolkitContext?.init(() => {
        if (this.arToolkitContext) {
          this.arCamera.projectionMatrix.copy(this.arToolkitContext.getProjectionMatrix());
        }
        resolve();
      });
    });
  }

  private createMarkerAnchor(): void {
    if (!this.arToolkitContext) {
      throw new Error('Tracking context is not initialized.');
    }

    this.markerRoot = new Group();
    this.scene.add(this.markerRoot);

    this.markerControls = new THREEx.ArMarkerControls(this.arToolkitContext, this.markerRoot, {
      type: 'pattern',
      patternUrl: ViewerComponent.PATTERN_URL,
      changeMatrixMode: 'modelViewMatrix',
    });
  }

  private handleResize(): void {
    this.arToolkitSource?.onResizeElement();
    if (this.renderer) {
      this.arToolkitSource?.copyElementSizeTo(this.renderer.domElement);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    if (this.arToolkitContext?.arController !== null) {
      this.arToolkitSource?.copyElementSizeTo(this.arToolkitContext?.arController?.canvas);
    }
  }

  private stopCameraStream(): void {
    const mediaElement = this.arToolkitSource?.domElement;
    if (mediaElement instanceof HTMLVideoElement) {
      const stream = mediaElement.srcObject;
      if (stream instanceof MediaStream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      mediaElement.srcObject = null;
      mediaElement.pause();
    }
  }

  private removeArVideoElement(): void {
    const arVideo = document.getElementById('arjs-video');
    if (arVideo) {
      arVideo.remove();
    }
  }
}
