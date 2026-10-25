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
import { previewColor, AVAILABLE_PRINTERS } from "../lib/shared";
import {
  IDENTITY_ROTATION,
  poseMatrix,
  multiplyRotations,
  rotationForFace,
} from "@time-estimator/browser-preview/pose";

interface Model {
  positions: Float32Array;
  min: number[];
  max: number[];
  hullPositions?: Float32Array;
}
interface Props {
  file: File | null;
  color: string;
  mirror: boolean;
  infill: number;
  layerHeight: number;
  supports: string;
  rotation: number[];
  onRotationChange: (rotation: number[]) => void;
  disabled?: boolean;
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
  rotation,
  onRotationChange,
  disabled = false,
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
  const faceAction = useRef<(normal: number[]) => void>(() => {});
  const faceModeRef = useRef(false);
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
  const [faceMode, setFaceMode] = useState(false);
  const [operation, setOperation] = useState("Preparing preview…");
  faceModeRef.current = faceMode && !disabled;
  faceAction.current = (normal) => {
    onRotationChange(multiplyRotations(rotationForFace(normal), rotation));
    setFaceMode(false);
  };

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
  }, [file, mirror, rotation, infill, layerHeight, supports]);

  function getClient() {
    return (client.current ??= createPreviewClient<File>({
      manifestUrl: new URL(
        "/preview-engine/manifest.json",
        window.location.origin,
      ).href,
      workerFactory: () =>
        new Worker(new URL("../workers/support.worker.ts", import.meta.url), {
          type: "module",
        }),
    }));
  }

  async function autoOrient() {
    if (!file || busy || disabled) return;
    const currentRevision = ++revision.current;
    setBusy(true);
    setTab("model");
    setMessage("");
    setOperation("Finding an orientation…");
    try {
      const result = await getClient().orient({
        input: file,
        rotation,
        mirrorX: mirror,
      });
      if (revision.current === currentRevision) {
        setFaceMode(false);
        onRotationChange(result.rotation);
      }
    } catch (error) {
      if (revision.current === currentRevision)
        setMessage(
          (error as { code?: string }).code === "canceled"
            ? "Preview canceled."
            : "Couldn't find an orientation. Choose a face instead.",
        );
    } finally {
      if (revision.current === currentRevision) setBusy(false);
    }
  }

  async function showLayers() {
    if (preview) {
      setTab("layers");
      return;
    }
    if (!file || !profile || busy || disabled) return;
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
    setFaceMode(false);
    setOperation("Preparing preview…");
    setTab("layers");
    setBusy(true);
    setMessage("");
    try {
      const result = await client.current.generate({
        input: file,
        profile,
        view: "print",
        support:
          supports === "none"
            ? "none"
            : supports === "normal"
              ? "normal"
              : "tree",
        mirrorX: mirror,
        rotation,
        fitBed: true,
        infill,
        layerHeight,
      });
      if (revision.current !== currentRevision) return;
      setPreview(result);
      setLayerIndex(result.layers.length - 1);
      setOnlyLayer(false);
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
              : code === "out_of_memory"
                ? "The browser ran out of slicing memory. Close other tabs and retry."
                : error instanceof Error
                  ? error.message.slice(0, 200)
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
    worker.postMessage({ file, rotation, mirror, hull: faceMode });
    return () => {
      worker.terminate();
      fileWorker.current = null;
    };
  }, [file, rotation, mirror, faceMode]);

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
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(40, 1, 0.05, 40);
    scene.background = new THREE.Color("#d2d7da");
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
    mesh.matrixWorldNeedsUpdate = true;
    meshRef.current = mesh;
    root.add(mesh);
    scene.add(new THREE.HemisphereLight("#ffffff", "#626d78", 1.8));
    const light = new THREE.DirectionalLight("#ffffff", 2);
    light.position.set(4, 6, 4);
    scene.add(light);
    const extent = Math.max(
      ...model.max.map((value, i) => value - model.min[i]),
      0.000001,
    );
    const grid = new THREE.GridHelper(5, 25, "#a5afb6", "#6e7b84");
    grid.position.y = -(model.max[2] - model.min[2]) / extent - 0.02;
    scene.add(grid);
    const bed = new THREE.Mesh(
      new THREE.PlaneGeometry(5, 5),
      new THREE.MeshStandardMaterial({ color: "#48545c", roughness: 1 }),
    );
    bed.rotation.x = -Math.PI / 2;
    bed.position.y = grid.position.y - 0.003;
    scene.add(bed);
    let hull: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null =
      null;
    let highlight: THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshBasicMaterial
    > | null = null;
    if (model.hullPositions) {
      const hullGeometry = new THREE.BufferGeometry();
      hullGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(model.hullPositions, 3),
      );
      hullGeometry.computeVertexNormals();
      hull = new THREE.Mesh(
        hullGeometry,
        new THREE.MeshBasicMaterial({
          color: "#5ba161",
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      hull.matrixAutoUpdate = false;
      hull.matrixWorldNeedsUpdate = true;
      hull.renderOrder = 2;
      root.add(hull);
      highlight = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({
          color: "#e8cb65",
          transparent: true,
          opacity: 0.65,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
        }),
      );
      highlight.matrixAutoUpdate = false;
      highlight.matrix.copy(hull.matrix);
      highlight.matrixWorldNeedsUpdate = true;
      highlight.visible = false;
      highlight.renderOrder = 3;
      root.add(highlight);
    }
    const raycaster = new THREE.Raycaster();
    let down = [0, 0];
    const pointerDown = (event: PointerEvent) => {
      down = [event.clientX, event.clientY];
    };
    const pickFace = (event: PointerEvent) => {
      if (!hull) return;
      const rect = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          1 - ((event.clientY - rect.top) / rect.height) * 2,
        ),
        camera,
      );
      root.updateMatrixWorld(true);
      return raycaster.intersectObject(hull)[0];
    };
    let highlightedPlane = "";
    const pointerLeave = () => {
      if (highlight) highlight.visible = false;
      highlightedPlane = "";
      render.current();
    };
    const pointerMove = (event: PointerEvent) => {
      if (!faceModeRef.current || !hull || !highlight || !model.hullPositions)
        return;
      const hit = pickFace(event);
      renderer.domElement.style.cursor = hit ? "pointer" : "grab";
      if (!hit?.face) {
        pointerLeave();
        return;
      }
      const normal = hit.face.normal,
        source = model.hullPositions;
      const point = new THREE.Vector3().fromArray(source, hit.face.a * 3);
      const distance = normal.dot(point),
        key =
          normal
            .toArray()
            .map((v) => v.toFixed(5))
            .join(",") + distance.toFixed(4);
      if (key === highlightedPlane) return;
      highlightedPlane = key;
      const normals = hull.geometry.getAttribute("normal"),
        selected: number[] = [];
      for (let i = 0; i < source.length; i += 9) {
        const faceNormal = new THREE.Vector3().fromBufferAttribute(
          normals,
          i / 3,
        );
        const vertex = new THREE.Vector3().fromArray(source, i);
        if (
          faceNormal.dot(normal) > 1 - 1e-5 &&
          Math.abs(normal.dot(vertex) - distance) < extent * 1e-5
        )
          selected.push(...source.subarray(i, i + 9));
      }
      highlight.geometry.dispose();
      highlight.geometry = new THREE.BufferGeometry();
      highlight.geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(selected, 3),
      );
      highlight.visible = true;
      render.current();
    };
    const pointerUp = (event: PointerEvent) => {
      if (
        !faceModeRef.current ||
        Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 5
      )
        return;
      const hit = pickFace(event);
      if (hit?.face) {
        const normal = hit.face.normal.clone().normalize();
        faceAction.current(normal.toArray());
      }
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    renderer.domElement.addEventListener("pointermove", pointerMove);
    renderer.domElement.addEventListener("pointerleave", pointerLeave);
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
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerleave", pointerLeave);
      hull?.geometry.dispose();
      hull?.material.dispose();
      highlight?.geometry.dispose();
      highlight?.material.dispose();
      bed.geometry.dispose();
      bed.material.dispose();
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
    mesh.material.color.set(previewColor(color));
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
            disabled={!model || !profile || disabled}
            onClick={showLayers}
          >
            Layers
          </button>
        </div>
      </div>
      {file && (
        <div
          className="orientation-toolbar"
          role="group"
          aria-label="Model orientation"
        >
          <span>Orientation</span>
          <button
            type="button"
            disabled={busy || disabled || !model}
            onClick={autoOrient}
          >
            Auto
          </button>
          <button
            type="button"
            disabled={busy || disabled || reading}
            aria-pressed={faceMode}
            onClick={() => {
              setFaceMode(!faceMode);
              setTab("model");
            }}
          >
            Lay on face
          </button>
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => {
              setFaceMode(false);
              onRotationChange([...IDENTITY_ROTATION]);
            }}
          >
            Reset orientation
          </button>
        </div>
      )}
      {faceMode && (
        <div className="face-picker">
          <p>Click a highlighted face to place it on the bed.</p>
          <div>
            {[
              { name: "Bottom", normal: [0, 0, -1] },
              { name: "Top", normal: [0, 0, 1] },
              { name: "Front", normal: [0, -1, 0] },
              { name: "Back", normal: [0, 1, 0] },
              { name: "Left", normal: [-1, 0, 0] },
              { name: "Right", normal: [1, 0, 0] },
            ].map((face) => (
              <button
                type="button"
                key={face.name}
                disabled={disabled || reading}
                onClick={() => {
                  const normal = new THREE.Vector3(...face.normal).applyMatrix3(
                    new THREE.Matrix3().setFromMatrix4(
                      new THREE.Matrix4().fromArray(
                        poseMatrix(rotation, mirror),
                      ),
                    ),
                  );
                  faceAction.current(normal.toArray());
                }}
              >
                {face.name}
              </button>
            ))}
          </div>
        </div>
      )}
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
          {layered && (
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
          )}
          {busy && (
            <div className="preview-loading" role="status">
              {operation}{" "}
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
        </div>
      )}
      {model && (
        <div className="printer-fit-info">
          <span className="fit-label">Printer fit</span>
          <div className="fit-badges">
            {AVAILABLE_PRINTERS.map((printer) => {
              const fits =
                model.max[0] - model.min[0] <= printer.buildVolume.x &&
                model.max[1] - model.min[1] <= printer.buildVolume.y &&
                model.max[2] - model.min[2] <= printer.buildVolume.z;
              return (
                <span
                  key={printer.id}
                  className={`fit-badge ${fits ? "fits" : "exceeds"}`}
                >
                  {printer.name}: {fits ? "Fits" : "Exceeds"}
                </span>
              );
            })}
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
          <p>
            {profile.label}. The preview bed expands to fit the model. Final
            settings may differ.
          </p>
          {supports === "operator" && (
            <p>Tree supports are shown as an example.</p>
          )}
        </details>
      )}
    </div>
  );
}
