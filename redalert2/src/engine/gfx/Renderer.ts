import * as THREE from 'three';
import { TextureAtlas } from './TextureAtlas';
import Stats from 'stats.js';
import { EventDispatcher } from '../../util/event';
import { RendererError } from './RendererError';
import { GpuTimer } from './GpuTimer';
import { getPerformanceCaptureGeneration, getPerformanceSimulationTick, incrementPerformanceCounter, isPerformanceTelemetryEnabled, measurePerformanceMetric, recordPerformanceDuration, setPerformanceContext } from '@/performance/PerformanceRuntime';
export class Renderer {
    private width: number;
    private height: number;
    private renderer!: THREE.WebGLRenderer;
    private gpuTimer?: GpuTimer;
    private rendererTelemetryContext?: Record<string, unknown>;
    private pixelRatio: number = 1;
    // The ratio currently applied to the main canvas, readable by code with no
    // renderer reference (e.g. WorldScene's device-pixel pan snapping).
    static activePixelRatio: number = 1;
    private scenes: Set<any> = new Set();
    private isContextLost: boolean = false;
    private stats?: Stats;
    private _onFrame = new EventDispatcher<string, number>();
    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }
    get onFrame() {
        return this._onFrame.asEvent();
    }
    getCanvas(): HTMLCanvasElement {
        return this.renderer.domElement;
    }
    getStats(): Stats | undefined {
        return this.stats;
    }
    supportsInstancing(): boolean {
        if (!this.renderer) {
            throw new Error('Renderer not yet initialized');
        }
        return !!this.renderer.extensions.get('ANGLE_instanced_arrays');
    }
    initStats(container: HTMLElement): void {
        if (!this.stats) {
            this.stats = new Stats();
            this.stats.showPanel(0);
            this.stats.dom.style.top = 'auto';
            this.stats.dom.style.bottom = '0px';
            this.stats.dom.classList.add('stats-layer');
            container.appendChild(this.stats.dom);
        }
    }
    destroyStats(): void {
        if (this.stats) {
            if (this.stats.dom.parentNode) {
                this.stats.dom.parentNode.removeChild(this.stats.dom);
            }
            this.stats = undefined;
        }
    }
    init(container: HTMLElement): void {
        const renderer = this.createGlRenderer();
        container.appendChild(renderer.domElement);
        renderer.domElement.addEventListener('contextmenu', (event) => {
            event.preventDefault();
        });
        renderer.domElement.addEventListener('mousedown', (event) => {
            event.preventDefault();
        });
        renderer.domElement.addEventListener('wheel', (event) => {
            event.stopPropagation();
        }, { passive: true });
        renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
        renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestored);
        this.renderer = renderer;
        this.initGpuTimer();
    }
    createGlRenderer(canvas?: HTMLCanvasElement): THREE.WebGLRenderer {
        // Atlases drop their CPU pixel copies after upload; a fresh GL context
        // re-uploads from texture.image.data, so refill them first or every
        // sprite comes back fully transparent.
        TextureAtlas.restoreAll();
        let renderer: THREE.WebGLRenderer;
        try {
            renderer = new THREE.WebGLRenderer({
                canvas: canvas,
                // Nothing reads the framebuffer back; preserving it forces a
                // costly per-frame copy on tile-based (iOS) GPUs.
                preserveDrawingBuffer: false,
                stencil: false,
                powerPreference: 'high-performance',
            });
        }
        catch (error) {
            throw new RendererError('Failed to initialize WebGL renderer');
        }
        renderer.setPixelRatio(this.pixelRatio);
        renderer.setSize(this.width, this.height);
        renderer.autoClear = false;
        renderer.autoClearDepth = false;
        renderer.shadowMap.enabled = true;
        renderer.localClippingEnabled = true;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.outputColorSpace = (THREE as any).SRGBColorSpace ?? THREE.LinearSRGBColorSpace;
        return renderer;
    }
    setSize(width: number, height: number): void {
        this.width = width;
        this.height = height;
        if (this.renderer) {
            this.renderer.setSize(width, height);
        }
    }
    /**
     * Renders the logical-resolution scene into a backing store of
     * logical x ratio pixels (three keeps the canvas CSS size logical and
     * multiplies viewports internally). With ratio = displayScale x
     * devicePixelRatio, every rendered pixel maps 1:1 onto a device pixel —
     * eliminating the blur from CSS-upscaling a small canvas.
     */
    setPixelRatio(ratio: number): void {
        const clamped = Math.max(1, Math.min(3, ratio));
        if (this.pixelRatio === clamped) {
            return;
        }
        this.pixelRatio = clamped;
        Renderer.activePixelRatio = clamped;
        if (this.renderer) {
            this.renderer.setPixelRatio(clamped);
            this.renderer.setSize(this.width, this.height);
        }
    }
    addScene(scene: any): void {
        this.scenes.add(scene);
        scene.create3DObject();
    }
    removeScene(scene: any): void {
        this.scenes.delete(scene);
    }
    getScenes(): any[] {
        return [...this.scenes];
    }
    update(deltaTime: number, ...args: any[]): void {
        measurePerformanceMetric('render.sceneUpdate', () => {
            this.scenes.forEach((scene) => {
                scene.update(deltaTime, ...args);
            });
        });
        measurePerformanceMetric('render.frameCallbacks', () => this._onFrame.dispatch('frame', deltaTime));
    }
    render(): void {
        if (this.isContextLost)
            return;
        const profiling = isPerformanceTelemetryEnabled();
        this.gpuTimer?.begin(profiling, getPerformanceSimulationTick(), getPerformanceCaptureGeneration());
        try {
            measurePerformanceMetric('render.submit', () => {
                this.renderer.clear();
                this.scenes.forEach((scene) => {
                    this.renderer.clearDepth();
                    const viewportY = this.height - scene.viewport.y - scene.viewport.height;
                    this.renderer.setViewport(scene.viewport.x, viewportY, scene.viewport.width, scene.viewport.height);
                    this.renderer.render(scene.scene, scene.camera);
                    if (profiling) {
                        // Three resets render counters on each render() by default.
                        const info = this.renderer.info.render;
                        incrementPerformanceCounter('render.drawCalls', info.calls);
                        incrementPerformanceCounter('render.triangles', info.triangles);
                        incrementPerformanceCounter('render.lines', info.lines);
                        incrementPerformanceCounter('render.points', info.points);
                    }
                });
            });
        } finally {
            this.gpuTimer?.end();
            if (profiling) {
                try { this.publishRendererTelemetry(); }
                catch { /* Context metadata must never interrupt rendering. */ }
            }
        }
    }
    private initGpuTimer(): void {
        this.rendererTelemetryContext = undefined;
        this.gpuTimer = new GpuTimer(this.renderer.getContext() as WebGL2RenderingContext,
            (milliseconds, tick, startedAt) => recordPerformanceDuration('gpu.render', milliseconds, tick, startedAt));
    }
    private publishRendererTelemetry(): void {
        if (!this.rendererTelemetryContext) {
            const gl = this.renderer.getContext();
            const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
            this.rendererTelemetryContext = {
                vendor: gl.getParameter(gl.VENDOR),
                renderer: gl.getParameter(gl.RENDERER),
                webglVersion: gl.getParameter(gl.VERSION),
                deviceVendor: rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_VENDOR_WEBGL) : undefined,
                deviceRenderer: rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : undefined,
            };
        }
        setPerformanceContext('renderer', {
            ...this.rendererTelemetryContext,
            logicalWidth: this.width,
            logicalHeight: this.height,
            pixelRatio: this.pixelRatio,
            bufferWidth: this.renderer.domElement.width,
            bufferHeight: this.renderer.domElement.height,
            geometries: this.renderer.info.memory.geometries,
            textures: this.renderer.info.memory.textures,
            programs: this.renderer.info.programs?.length,
        });
        setPerformanceContext('gpuTimer', this.gpuTimer?.snapshot());
    }
    flush(): void {
        this.renderer.renderLists.dispose();
    }
    dispose(): void {
        this.gpuTimer?.dispose();
        this.renderer.domElement.remove();
        this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);
        this.renderer.domElement.removeEventListener('webglcontextrestored', this.handleContextRestored);
        this.renderer.dispose();
        this.destroyStats();
    }
    private handleContextLost = (event: Event): void => {
        event.preventDefault();
        this.isContextLost = true;
        this.gpuTimer?.contextLost();
        if (isPerformanceTelemetryEnabled()) setPerformanceContext('gpuTimer', this.gpuTimer?.snapshot());
    };
    private handleContextRestored = (): void => {
        const canvas = this.renderer.domElement;
        this.renderer.dispose();
        this.renderer = this.createGlRenderer(canvas);
        this.initGpuTimer();
        this.isContextLost = false;
    };
}
