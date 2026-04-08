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
  Box3,
  DirectionalLight,
  Euler,
  Group,
  MathUtils,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

@Component({
  selector: 'app-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="viewer-shell">
      <video #cameraFeed class="camera-feed" autoplay playsinline muted></video>
      <canvas #arCanvas class="ar-canvas" (click)="onCanvasTap()"></canvas>

      <div class="overlay-panel" *ngIf="!arStarted || !!statusText || modelPlaced">
        <button
          type="button"
          class="start-btn"
          (click)="startAr()"
          [disabled]="arStarted && modelLoaded"
          *ngIf="!arStarted"
        >
          Start AR
        </button>
        <p class="status-text">{{ statusText }}</p>
        <p class="hint-text" *ngIf="arStarted && modelLoaded && !modelPlaced">
          Tap anywhere to place the router model.
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

      .camera-feed,
      .ar-canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }

      .camera-feed {
        object-fit: cover;
        background: #000;
      }

      .ar-canvas {
        touch-action: manipulation;
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
  @ViewChild('cameraFeed', { static: true })
  private readonly cameraFeedRef!: ElementRef<HTMLVideoElement>;

  @ViewChild('arCanvas', { static: true })
  private readonly canvasRef!: ElementRef<HTMLCanvasElement>;

  arStarted = false;
  modelLoaded = false;
  modelPlaced = false;
  statusText = 'Start AR to allow camera access.';

  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(60, 1, 0.01, 100);
  private renderer?: WebGLRenderer;
  private modelGroup?: Group;
  private stream?: MediaStream;
  private frameHandle = 0;
  private orientationReady = false;
  private alphaDeg = 0;
  private betaDeg = 0;
  private gammaDeg = 0;
  private readonly worldUp = new Vector3(0, 1, 0);
  private readonly cameraForward = new Vector3();
  private readonly modelPosition = new Vector3();
  private readonly euler = new Euler();
  private readonly q0 = new Quaternion();
  private readonly q1 = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
  private readonly zee = new Vector3(0, 0, 1);
  private readonly onOrientationEvent = (event: DeviceOrientationEvent): void => {
    this.alphaDeg = event.alpha ?? 0;
    this.betaDeg = event.beta ?? 0;
    this.gammaDeg = event.gamma ?? 0;
    this.orientationReady = true;
  };

  ngAfterViewInit(): void {
    this.initScene();
    this.onResize();
    this.animate();
  }

  async startAr(): Promise<void> {
    if (this.arStarted) {
      return;
    }

    this.statusText = 'Requesting permissions...';

    try {
      await this.requestOrientationPermission();
      await this.startCamera();
      await this.loadModel();
      this.bindOrientationListener();
      this.arStarted = true;
      this.statusText = 'Move your phone, then tap to place the model.';
    } catch (error) {
      this.statusText =
        error instanceof Error
          ? error.message
          : 'AR start failed. Please allow camera and motion access.';
    }
  }

  onCanvasTap(): void {
    if (!this.arStarted || !this.modelGroup || this.modelPlaced) {
      return;
    }

    this.camera.getWorldDirection(this.cameraForward);
    this.modelPosition.copy(this.camera.position);
    this.modelPosition.add(this.cameraForward.multiplyScalar(1.2));
    this.modelPosition.y -= 0.4;

    this.modelGroup.position.copy(this.modelPosition);
    this.modelGroup.visible = true;
    this.modelPlaced = true;
    this.statusText = 'Router placed.';
  }

  @HostListener('window:resize')
  onResize(): void {
    const canvas = this.canvasRef.nativeElement;
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer?.setSize(width, height, false);
    this.renderer?.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  }

  ngOnDestroy(): void {
    if (this.frameHandle) {
      cancelAnimationFrame(this.frameHandle);
    }

    globalThis.removeEventListener('deviceorientation', this.onOrientationEvent);
    this.stopCamera();
    this.renderer?.dispose();
    this.modelGroup = undefined;
  }

  private initScene(): void {
    const canvas = this.canvasRef.nativeElement;
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);

    this.camera.position.set(0, 1.45, 0);
    this.scene.add(new AmbientLight(0xffffff, 1.2));
    const keyLight = new DirectionalLight(0xffffff, 1.5);
    keyLight.position.set(3, 4, 2);
    this.scene.add(keyLight);
  }

  private async startCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera API is not available in this WebView.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
      },
    });

    this.stream = stream;
    const cameraFeed = this.cameraFeedRef.nativeElement;
    cameraFeed.srcObject = stream;
    await cameraFeed.play();
  }

  private stopCamera(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.cameraFeedRef.nativeElement.srcObject = null;
  }

  private async loadModel(): Promise<void> {
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
    const scale = 0.85 / size;
    model.scale.setScalar(scale);

    const wrapper = new Group();
    wrapper.visible = false;
    wrapper.add(model);
    this.scene.add(wrapper);

    this.modelGroup = wrapper;
    this.modelLoaded = true;
  }

  private bindOrientationListener(): void {
    globalThis.removeEventListener('deviceorientation', this.onOrientationEvent);
    globalThis.addEventListener('deviceorientation', this.onOrientationEvent, true);
  }

  private async requestOrientationPermission(): Promise<void> {
    type IOSPermissionEvent = typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };

    const orientationEvent = DeviceOrientationEvent as IOSPermissionEvent;
    if (typeof orientationEvent.requestPermission !== 'function') {
      return;
    }

    const permission = await orientationEvent.requestPermission();
    if (permission !== 'granted') {
      throw new Error('Motion permission denied.');
    }
  }

  private readonly animate = (): void => {
    this.frameHandle = requestAnimationFrame(this.animate);
    this.updateCameraFromOrientation();
    this.renderer?.render(this.scene, this.camera);
  };

  private updateCameraFromOrientation(): void {
    if (!this.orientationReady) {
      return;
    }

    const alpha = MathUtils.degToRad(this.alphaDeg);
    const beta = MathUtils.degToRad(this.betaDeg);
    const gamma = MathUtils.degToRad(this.gammaDeg);
    const orient = MathUtils.degToRad(this.getScreenAngle());

    this.euler.set(beta, alpha, -gamma, 'YXZ');
    this.camera.quaternion.setFromEuler(this.euler);
    this.camera.quaternion.multiply(this.q1);
    this.camera.quaternion.multiply(this.q0.setFromAxisAngle(this.zee, -orient));
    this.camera.up.copy(this.worldUp);
  }

  private getScreenAngle(): number {
    if (screen.orientation && typeof screen.orientation.angle === 'number') {
      return screen.orientation.angle;
    }

    return 0;
  }
}
