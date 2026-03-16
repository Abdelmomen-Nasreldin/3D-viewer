import {
  Component,
  ElementRef,
  AfterViewInit,
  OnDestroy,
  ViewChild,
  NgZone,
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
 * Hardcoded annotations for the Vodafone router.
 *
 * To find the right coordinates:
 *   1. Place your router.glb in the public/ folder and run `ng serve`
 *   2. Click anywhere on the model -- the 3D point is logged to the browser console
 *   3. Copy the logged {x, y, z} values into the position tuples below
 */
const ROUTER_ANNOTATIONS: Annotation[] = [
  { id: 'front-led',   position: [0, 0, 0], text: 'Status LED' },
  { id: 'power-port',  position: [0, 0, 0], text: 'Power Port' },
  { id: 'ethernet',    position: [0, 0, 0], text: 'Ethernet Ports' },
  { id: 'wps-button',  position: [0, 0, 0], text: 'WPS Button' },
  { id: 'reset',       position: [0, 0, 0], text: 'Reset Button' },
];

@Component({
  selector: 'app-viewer',
  standalone: true,
  template: `<div #rendererContainer class="viewer-container"></div>`,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }
      .viewer-container {
        width: 100%;
        height: 100%;
        position: relative;
        overflow: hidden;
      }
    `,
  ],
})
export class ViewerComponent implements AfterViewInit, OnDestroy {
  @ViewChild('rendererContainer', { static: true })
  containerRef!: ElementRef<HTMLDivElement>;

  private renderer!: THREE.WebGLRenderer;
  private css2DRenderer!: CSS2DRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private animationId = 0;
  private resizeObserver!: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private model: THREE.Group | null = null;

  constructor(private zone: NgZone) {}

  ngAfterViewInit(): void {
    this.initScene();
    this.initRenderers();
    this.initLights();
    this.initControls();
    this.initDevClickLogger();
    this.loadModel();
    this.zone.runOutsideAngular(() => this.animate());
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animationId);
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.renderer?.dispose();
    this.css2DRenderer?.domElement.remove();
  }

  private initScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);

    const container = this.containerRef.nativeElement;
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    this.camera.position.set(0, 2, 5);
  }

  private initRenderers(): void {
    const container = this.containerRef.nativeElement;
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(w, h);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
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

    const dir = new THREE.DirectionalLight('#ffffff', 0.8);
    dir.position.set(5, 10, 7);
    dir.castShadow = true;
    this.scene.add(dir);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const envTexture = pmrem.fromScene(new THREE.Scene(), 0, 0.1, 100);
    this.scene.environment = envTexture.texture;
    pmrem.dispose();
  }

  private initControls(): void {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 50;
  }

  /** Logs the 3D click position to the console so you can find annotation coordinates. */
  private initDevClickLogger(): void {
    this.renderer.domElement.addEventListener('click', (event: MouseEvent) => {
      if (!this.model) return;

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

  private loadModel(): void {
    const loader = new GLTFLoader();
    loader.load(
      'router.glb',
      (gltf) => {
        this.model = gltf.scene;

        const box = new THREE.Box3().setFromObject(this.model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 3 / maxDim;

        this.model.scale.setScalar(scale);
        this.model.position.sub(center.multiplyScalar(scale));

        this.scene.add(this.model);

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
      this.scene.add(label);

      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.03, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0x00d4ff })
      );
      dot.position.set(x, y, z);
      this.scene.add(dot);
    }
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

  private animate(): void {
    this.animationId = requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.css2DRenderer.render(this.scene, this.camera);
  }
}
