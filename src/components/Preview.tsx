import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  createPreviewClient,
  type PreviewClient,
  type PreviewProfile,
  type SupportPreview,
} from "@time-estimator/browser-preview";
import { displayTransform } from "@time-estimator/browser-preview/geometry";
import {
  createToolpathOverlay,
  type SupportOverlay,
} from "@time-estimator/browser-preview/three";
import "../styles/support-preview.css";

interface Model {
  positions: Float32Array;
  min: number[];
  max: number[];
}
interface Props {
  file: File | null;
  color: string;
  mirror: boolean;
  infill: number;
  layerHeight: number;
  supports: string;
}
const categories = [
  { id: "walls", label: "Walls", color: "#ff7d38" },
  { id: "infill", label: "Infill", color: "#b03029" },
  { id: "surfaces", label: "Surfaces", color: "#9654cc" },
  { id: "supports", label: "Supports", color: "#00b000" },
  { id: "helpers", label: "Outline", color: "#00876e" },
];

export default function Preview({
  file,
  color,
  mirror,
  infill,
  layerHeight,
  supports,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const fileWorker = useRef<Worker | null>(null);
  const client = useRef<PreviewClient<File> | null>(null);
  const meshRef = useRef<THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshStandardMaterial
  > | null>(null);
  const frameRef = useRef<THREE.Group | null>(null);
  const overlayRef = useRef<SupportOverlay | null>(null);
  const reset = useRef<() => void>(() => {});
  const render = useRef<() => void>(() => {});
  const revision = useRef(0);
  const [model, setModel] = useState<Model | null>(null);
  const [profile, setProfile] = useState<PreviewProfile | null>(null);
  const [preview, setPreview] = useState<SupportPreview | null>(null);
  const [tab, setTab] = useState<"model" | "layers">("model");
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [layerIndex, setLayerIndex] = useState(0);
  const [onlyLayer, setOnlyLayer] = useState(false);
  const [progress, setProgress] = useState(100);
  const [playing, setPlaying] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/preview-profile.json", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const value = await response.json();
        if (value.id && value.configuration) setProfile(value);
      })
      .catch(() => {});
    return () => {
      controller.abort();
      client.current?.dispose();
      client.current = null;
    };
  }, []);

  useEffect(() => {
    revision.current++;
    client.current?.cancel();
    overlayRef.current?.dispose();
    overlayRef.current = null;
    setPreview(null);
    setBusy(false);
    setPlaying(false);
    setTab("model");
    setMessage("");
  }, [file, mirror, infill, layerHeight, supports]);

  async function showLayers() {
    if (preview) {
      setTab("layers");
      return;
    }
    if (!file || !profile || busy) return;
    const currentRevision = ++revision.current;
    client.current ??= createPreviewClient<File>({
      manifestUrl: new URL(
        "/preview-engine/manifest.json",
        window.location.origin,
      ).href,
      workerFactory: () =>
        new Worker(new URL("../workers/support.worker.ts", import.meta.url), {
          type: "module",
        }),
    });
    setTab("layers");
    setBusy(true);
    setMessage("");
    try {
      const result = await client.current.generate({
        input: file,
        profile,
        view: "print",
        support: supports === "none" ? "none" : "tree",
        mirrorX: mirror,
        infill,
        layerHeight,
      });
      if (revision.current !== currentRevision) return;
      setPreview(result);
      setLayerIndex(result.layers.length - 1);
      setProgress(100);
      setHidden([]);
    } catch (error) {
      if (revision.current !== currentRevision) return;
      const code = (error as { code?: string }).code;
      setTab("model");
      setMessage(
        code === "canceled"
          ? "Preview canceled."
          : code === "mesh_limit" || code === "segment_limit"
            ? "This model is too detailed to preview."
            : code === "timeout"
              ? "Preview took too long. Try again."
              : "Couldn't prepare this preview.",
      );
    } finally {
      if (revision.current === currentRevision) setBusy(false);
    }
  }

  useEffect(() => {
    setModel(null);
    setReading(Boolean(file));
    if (!file) return;
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("../workers/stl.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      setReading(false);
      setMessage("Preview unavailable.");
      return;
    }
    fileWorker.current = worker;
    worker.onmessage = ({ data }) => {
      setReading(false);
      if (data.error) setMessage("Couldn't open this preview.");
      else setModel(data);
      worker.terminate();
    };
    worker.onerror = () => {
      setReading(false);
      setMessage("Couldn't open this preview.");
      worker.terminate();
    };
    worker.postMessage(file);
    return () => {
      worker.terminate();
      fileWorker.current = null;
    };
  }, [file]);

  useEffect(() => {
    if (!host.current || !model) return;
    const element = host.current;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setMessage("3D preview unavailable.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    root.matrix.fromArray(displayTransform({ min: model.min, max: model.max }));
    root.matrixWorldNeedsUpdate = true;
    const frame = new THREE.Group();
    frameRef.current = frame;
    root.add(frame);
    scene.add(root);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(model.positions, 3),
    );
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.65,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    meshRef.current = mesh;
    root.add(mesh);
    scene.add(new THREE.HemisphereLight("#ffffff", "#96988a", 2.5));
    const light = new THREE.DirectionalLight("#ffffff", 3);
    light.position.set(4, 6, 4);
    scene.add(light);
    const extent = Math.max(
      ...model.max.map((value, i) => value - model.min[i]),
      0.000001,
    );
    const grid = new THREE.GridHelper(5, 20, "#c8cbbd", "#dfe0d5");
    grid.position.y = -(model.max[2] - model.min[2]) / extent - 0.02;
    scene.add(grid);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minDistance = 1;
    controls.maxDistance = 15;
    let animation = 0,
      disposed = false;
    const requestDraw = () => {
      if (!animation && !disposed) animation = requestAnimationFrame(draw);
    };
    const draw = () => {
      animation = 0;
      controls.update();
      renderer.render(scene, camera);
    };
    render.current = requestDraw;
    controls.addEventListener("change", requestDraw);
    reset.current = () => {
      camera.position.set(3.4, 2.5, 4.3);
      controls.target.set(0, 0, 0);
      controls.update();
    };
    reset.current();
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth,
        height = element.clientHeight;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      requestDraw();
    });
    observer.observe(element);
    requestDraw();
    return () => {
      disposed = true;
      cancelAnimationFrame(animation);
      render.current = () => {};
      observer.disconnect();
      controls.dispose();
      overlayRef.current?.dispose();
      overlayRef.current = null;
      frameRef.current = null;
      meshRef.current = null;
      geometry.dispose();
      material.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [model]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || !model) return;
    mesh.material.color.set(
      (
        {
          black: "#414442",
          white: "#f5f1e7",
          yellow: "#efc84a",
          red: "#c9493b",
        } as Record<string, string>
      )[color],
    );
    mesh.matrix.makeScale(mirror ? -1 : 1, 1, 1);
    mesh.matrix.setPosition(mirror ? model.min[0] + model.max[0] : 0, 0, 0);
    mesh.matrixWorldNeedsUpdate = true;
    render.current();
  }, [color, mirror, model]);

  useEffect(() => {
    overlayRef.current?.dispose();
    overlayRef.current = null;
    if (!preview || !frameRef.current || !model) return;
    const center = model.min.map((value, i) => (value + model.max[i]) / 2);
    frameRef.current.position.set(
      center[0] - (preview.bounds.min[0] + preview.bounds.max[0]) / 2,
      center[1] - (preview.bounds.min[1] + preview.bounds.max[1]) / 2,
      model.min[2],
    );
    const overlay = createToolpathOverlay(preview);
    overlayRef.current = overlay;
    frameRef.current.add(overlay.group);
    return () => {
      overlay.dispose();
      if (overlayRef.current === overlay) overlayRef.current = null;
    };
  }, [preview, model]);

  useEffect(() => {
    const layered = tab === "layers" && Boolean(preview);
    if (meshRef.current) meshRef.current.visible = !layered;
    const overlay = overlayRef.current;
    if (!overlay) {
      render.current();
      return;
    }
    overlay.setVisible(layered);
    const layer = preview?.layers[layerIndex];
    if (layer) {
      overlay.setLayerRange(-Infinity, layer.printZ + 0.000001);
      const start = layer.startSegment ?? 0,
        end = layer.endSegment ?? preview!.segmentCount;
      overlay.setMoveRange(
        onlyLayer ? start : 0,
        Math.ceil(start + ((end - start) * progress) / 100),
      );
    }
    for (const feature of preview?.features ?? [])
      overlay.setFeatureVisible(feature.id, !hidden.includes(feature.category));
    render.current();
  }, [preview, model, tab, layerIndex, onlyLayer, progress, hidden]);

  useEffect(() => {
    if (!playing || tab !== "layers") return;
    const from = progress >= 100 ? 0 : progress,
      started = performance.now();
    let animation = 0;
    const step = () => {
      const value = Math.min(100, from + (performance.now() - started) / 40);
      setProgress(value);
      if (value === 100) setPlaying(false);
      else animation = requestAnimationFrame(step);
    };
    animation = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animation);
  }, [playing, tab]);

  const layered = tab === "layers" && Boolean(preview);
  const dimensions = model?.min
    .map((value, i) => Number((model.max[i] - value).toFixed(1)))
    .join(" × ");
  const seconds = preview?.time?.estimatedSeconds;
  const time = seconds
    ? seconds < 60
      ? "Under 1 min"
      : `About ${Math.round(seconds / 60)} min`
    : "";
  return (
    <div className="preview-panel print-preview">
      <div className="preview-header">
        <h2>Print preview</h2>
        <div className="preview-tabs" role="tablist" aria-label="Preview mode">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "model"}
            onClick={() => {
              setTab("model");
              setPlaying(false);
            }}
          >
            Model
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "layers"}
            disabled={!model || !profile}
            onClick={showLayers}
          >
            Layers
          </button>
        </div>
      </div>
      <div className={`preview-canvas-frame${layered ? " has-layers" : ""}`}>
        <div
          className="preview-viewport"
          ref={host}
          role="img"
          aria-label={
            layered
              ? "Layer-by-layer print preview"
              : "Interactive model preview"
          }
        >
          {!model && (
            <div className="preview-placeholder">
              <p>{reading ? "Opening model…" : "Choose a file to preview."}</p>
            </div>
          )}
          {busy && (
            <div className="preview-loading" role="status">
              Preparing preview…{" "}
              <button
                type="button"
                className="text-button"
                onClick={() => client.current?.cancel()}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
        {layered && (
          <div className="layer-rail">
            <span>{preview!.layers.length}</span>
            <input
              type="range"
              aria-label="Layer"
              min="1"
              max={preview!.layers.length}
              value={layerIndex + 1}
              onChange={(event) => {
                setLayerIndex(Number(event.target.value) - 1);
                setPlaying(false);
                setProgress(100);
              }}
            />
            <span>1</span>
          </div>
        )}
      </div>
      <div className="preview-toolbar">
        <span>Drag to rotate · Scroll to zoom</span>
        <button
          type="button"
          className="text-button"
          onClick={() => reset.current()}
          disabled={!model}
        >
          Reset view
        </button>
      </div>
      {layered && (
        <div className="layer-controls">
          <div className="layer-heading">
            <strong>
              Layer {layerIndex + 1} / {preview!.layers.length}
            </strong>
            <label>
              <input
                type="checkbox"
                checked={onlyLayer}
                onChange={(event) => setOnlyLayer(event.target.checked)}
              />{" "}
              Only this layer
            </label>
          </div>
          <div className="move-controls">
            <button
              type="button"
              className="text-button"
              onClick={() => setPlaying(!playing)}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <input
              type="range"
              aria-label="Layer progress"
              min="0"
              max="100"
              step="1"
              value={Math.round(progress)}
              onChange={(event) => {
                setPlaying(false);
                setProgress(Number(event.target.value));
              }}
            />
          </div>
          <div className="feature-legend" aria-label="Print features">
            {categories
              .filter((category) =>
                preview!.features?.some(
                  (feature) => feature.category === category.id,
                ),
              )
              .map((category) => (
                <button
                  key={category.id}
                  type="button"
                  aria-pressed={!hidden.includes(category.id)}
                  onClick={() =>
                    setHidden((current) =>
                      current.includes(category.id)
                        ? current.filter((value) => value !== category.id)
                        : [...current, category.id],
                    )
                  }
                >
                  <i style={{ background: category.color }} />
                  {category.label}
                </button>
              ))}
          </div>
        </div>
      )}
      {message && (
        <p className="small preview-message" role="status">
          {message}
        </p>
      )}
      <div className="preview-summary">
        <span>{dimensions && `${dimensions} mm`}</span>
        {time && <strong>{time}</strong>}
      </div>
      {profile && (
        <details className="preview-settings">
          <summary>Preview settings</summary>
          <p>{profile.label}. Final settings may differ.</p>
          {supports === "operator" && (
            <p>Tree supports are shown as an example.</p>
          )}
        </details>
      )}
    </div>
  );
}
