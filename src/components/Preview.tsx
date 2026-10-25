import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createPreviewClient, type PreviewClient, type PreviewProfile, type SupportPreview } from "@time-estimator/browser-preview";
import { displayTransform } from "@time-estimator/browser-preview/geometry";
import { createSupportOverlay, type SupportOverlay } from "@time-estimator/browser-preview/three";
import "../styles/support-preview.css";
interface Model {
  positions: Float32Array;
  min: number[];
  max: number[];
  triangles: number;
  simplified: boolean;
}
export default function Preview({
  file,
  color,
  mirror,
  infill,
  layerHeight,
  supports,
}: {
  file: File | null;
  color: string;
  mirror: boolean;
  infill: number;
  layerHeight: number;
  supports: string;
}) {
  const host = useRef<HTMLDivElement>(null),
    workerRef = useRef<Worker | null>(null),
    reset = useRef<() => void>(() => {});
  const supportClient = useRef<PreviewClient<File> | null>(null);
  const contentRoot = useRef<THREE.Group | null>(null);
  const supportFrame = useRef<THREE.Group | null>(null);
  const overlayRef = useRef<SupportOverlay | null>(null);
  const revision = useRef(0);
  const [profile, setProfile] = useState<PreviewProfile | null>(null);
  const [supportPreview, setSupportPreview] = useState<SupportPreview | null>(null);
  const [supportBusy, setSupportBusy] = useState(false);
  const [supportMessage, setSupportMessage] = useState("");
  const [showSupports, setShowSupports] = useState(true);
  const [opacity, setOpacity] = useState(0.45);
  const [layerIndex, setLayerIndex] = useState(-1);
  const meshRef = useRef<THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshStandardMaterial
  > | null>(null);
  const [model, setModel] = useState<Model | null>(null),
    [message, setMessage] = useState(""),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/preview-profile.json", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("No preview profile");
      const value = await response.json();
      if (!value.id || !value.label || !value.configuration) throw new Error("Invalid preview profile");
      setProfile(value);
    }).catch(() => { if (!controller.signal.aborted) setSupportMessage("Support preview is not configured. You can still submit."); });
    return () => { controller.abort(); supportClient.current?.dispose(); supportClient.current = null; };
  }, []);
  useEffect(() => {
    revision.current++;
    supportClient.current?.cancel();
    overlayRef.current?.dispose(); overlayRef.current = null;
    setSupportPreview(null); setSupportBusy(false); setLayerIndex(-1);
    setSupportMessage(supports === "none" ? "Supports are disabled." : "");
  }, [file, mirror, infill, layerHeight, supports]);

  async function generateSupports() {
    if (!file || !profile) return;
    const requestRevision = ++revision.current;
    if (!supportClient.current) supportClient.current = createPreviewClient<File>({
      manifestUrl: new URL("/preview-engine/manifest.json", window.location.origin).href,
      workerFactory: () => new Worker(new URL("../workers/support.worker.ts", import.meta.url), { type: "module" }),
    });
    setSupportPreview(null); setSupportBusy(true); setSupportMessage("Reading your complete model…");
    try {
      const result = await supportClient.current.generate({input:file, profile, support:"tree", mirrorX:mirror,
        infill, layerHeight}, {onProgress: progress => {
          if (revision.current === requestRevision) setSupportMessage(progress.stage === "loading_engine"
            ? "Loading support preview…" : "Generating supports…");
        }});
      if (revision.current !== requestRevision) return;
      setSupportPreview(result); setLayerIndex(result.layers.length); setShowSupports(true);
      setSupportMessage(result.segmentCount ? "Generated tree supports. Operator settings may differ." : "No supports were generated for this model and profile.");
    } catch (error) {
      if (revision.current !== requestRevision) return;
      const failure = error as {code?:string;message?:string};
      setSupportMessage(failure.code === "canceled" ? "Support preview canceled." :
        failure.code === "mesh_limit" ? "This model is too large for local support generation. You can still submit it." :
        failure.code === "timeout" ? "Support generation reached its time limit. You can still submit." :
        "Support preview could not run with this model and profile. You can still submit.");
    } finally { if (revision.current === requestRevision) setSupportBusy(false); }
  }
  useEffect(() => {
    setModel(null);
    setMessage("");
    if (!file) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("../workers/stl.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      setLoading(false);
      setMessage(
        "Preview is unavailable in this browser. You can still submit your file.",
      );
      return;
    }
    workerRef.current = worker;
    worker.onmessage = ({ data }) => {
      setLoading(false);
      if (data.error) setMessage(data.error);
      else setModel(data);
      worker.terminate();
    };
    worker.onerror = () => {
      setLoading(false);
      setMessage("Preview could not load. You can still submit your file.");
      worker.terminate();
    };
    worker.postMessage(file);
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [file]);
  useEffect(() => {
    if (!host.current || !model) return;
    const element = host.current;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setMessage("WebGL is unavailable. You can still submit your file.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(model.positions, 3),
    );
    const center = model.min.map((v, i) => (v + model.max[i]) / 2);
    const extent = Math.max(
      ...model.min.map((v, i) => model.max[i] - v),
      0.000001,
    );
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    root.matrix.fromArray(displayTransform({min:model.min,max:model.max}));
    root.matrixWorldNeedsUpdate = true;
    contentRoot.current = root;
    const supportGroup = new THREE.Group();
    supportFrame.current = supportGroup;
    root.add(supportGroup); scene.add(root);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.65,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    meshRef.current = mesh;
    root.add(mesh);
    material.color.set(
      (
        {
          black: "#414442",
          white: "#f5f1e7",
          yellow: "#efc84a",
          red: "#c9493b",
        } as Record<string, string>
      )[color],
    );
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeScale(mirror ? -1 : 1, 1, 1);
    mesh.matrix.setPosition(mirror ? 2 * center[0] : 0, 0, 0);
    mesh.matrixWorldNeedsUpdate = true;
    scene.add(new THREE.HemisphereLight("#ffffff", "#96988a", 2.5));
    const light = new THREE.DirectionalLight("#ffffff", 3);
    light.position.set(4, 6, 4);
    scene.add(light);
    const grid = new THREE.GridHelper(5, 20, "#c8cbbd", "#dfe0d5");
    grid.position.y = -(model.max[2] - model.min[2]) / extent - 0.02;
    scene.add(grid);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minDistance = 1;
    controls.maxDistance = 15;
    reset.current = () => {
      camera.position.set(3.4, 2.5, 4.3);
      controls.target.set(0, 0, 0);
      controls.update();
    };
    reset.current();
    const observer = new ResizeObserver(() => {
      const w = element.clientWidth,
        h = element.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    observer.observe(element);
    let frame = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      overlayRef.current?.dispose(); overlayRef.current = null;
      contentRoot.current = null; supportFrame.current = null;
      geometry.dispose();
      material.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      meshRef.current = null;
    };
  }, [model]);
  useEffect(() => {
    if (!meshRef.current) return;
    meshRef.current.material.color.set(
      (
        {
          black: "#414442",
          white: "#f5f1e7",
          yellow: "#efc84a",
          red: "#c9493b",
        } as Record<string, string>
      )[color],
    );
    meshRef.current.matrix.makeScale(mirror ? -1 : 1, 1, 1);
    meshRef.current.matrix.setPosition(mirror && model ? model.min[0] + model.max[0] : 0, 0, 0);
    meshRef.current.matrixWorldNeedsUpdate = true;
  }, [color, mirror, model]);
  useEffect(() => {
    overlayRef.current?.dispose(); overlayRef.current = null;
    if (!supportPreview || !supportFrame.current || !model) return;
    const frame = supportFrame.current;
    const center = model.min.map((value,i) => (value + model.max[i])/2);
    frame.position.set(center[0]-(supportPreview.bounds.min[0]+supportPreview.bounds.max[0])/2,
      center[1]-(supportPreview.bounds.min[1]+supportPreview.bounds.max[1])/2,model.min[2]);
    const overlay = createSupportOverlay(supportPreview);
    overlayRef.current = overlay; frame.add(overlay.group);
    return () => { overlay.dispose(); if (overlayRef.current === overlay) overlayRef.current = null; };
  }, [supportPreview, model]);
  useEffect(() => {
    const material = meshRef.current?.material;
    if (!material) return;
    material.transparent = Boolean(supportPreview) && opacity < 1;
    material.opacity = supportPreview ? opacity : 1;
    material.depthWrite = !material.transparent;
    material.needsUpdate = true;
    overlayRef.current?.setVisible(showSupports);
    const height = supportPreview?.layers[layerIndex]?.printZ ?? Infinity;
    overlayRef.current?.setHeight(height);
    if (Number.isFinite(height) && supportFrame.current) {
      contentRoot.current?.updateMatrixWorld(true);
      material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0,0,-1),height).applyMatrix4(supportFrame.current.matrixWorld)];
    } else material.clippingPlanes = [];
  }, [supportPreview, showSupports, opacity, layerIndex, model]);
  return (
    <div className="preview-panel">
      <div className="card-top">
        <h2>STL preview</h2>
      </div>
      <div
        className="preview-viewport"
        ref={host}
        role="img"
        aria-label={
          model
            ? "Interactive STL preview. Drag to rotate and scroll to zoom."
            : "Choose an STL to preview it."
        }
      >
        {!model && (
          <div className="preview-placeholder">
            <p>
              {loading ? "Reading your STL…" : "Choose an STL file to preview."}
            </p>
            {loading && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  workerRef.current?.terminate();
                  setLoading(false);
                  setMessage(
                    "Preview canceled. You can still submit your file.",
                  );
                }}
              >
                Cancel preview
              </button>
            )}
          </div>
        )}
      </div>
      {model && (
        <div className="preview-toolbar">
          <span>Drag to orbit · Scroll to zoom</span>
          <button
            type="button"
            className="text-button"
            disabled={!model}
            onClick={() => reset.current()}
          >
            Reset view
          </button>
        </div>
      )}
      {model && (
        <p className="small mono">
          {model.min.map((v, i) => (model.max[i] - v).toFixed(1)).join(" × ")}{" "}
          mm · {model.triangles.toLocaleString()} triangles
          {model.simplified && (
            <strong className="simplified">
              Simplified preview · showing up to 1,000,000 triangles
            </strong>
          )}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {model && <section className="support-inspection" aria-label="Support inspection">
        <h3>Generated supports</h3>
        {profile && <p className="small muted">{profile.label}. Illustrative preview; the operator may use different settings.</p>}
        {supports === "operator" && <p className="small muted">Preview a tree-support scenario while keeping “Operator decides” on your submission.</p>}
        <div className="preview-toolbar">
          <button type="button" className="text-button" disabled={!profile || supportBusy || supports === "none"}
            onClick={generateSupports}>{supportBusy ? "Generating…" : "Generate tree preview"}</button>
          {supportBusy && <button type="button" className="text-button" onClick={() => supportClient.current?.cancel()}>Cancel supports</button>}
        </div>
        {supportMessage && <p className="small" role="status">{supportMessage}</p>}
        {supportPreview && supportPreview.segmentCount > 0 && <>
          <label className="small"><input type="checkbox" checked={showSupports} onChange={event=>setShowSupports(event.target.checked)} /> Show supports · blue base / amber interface</label>
          <label className="small">Model opacity<input type="range" min="0.1" max="1" step="0.05" value={opacity} onChange={event=>setOpacity(Number(event.target.value))} /></label>
          <label className="small">Height: {layerIndex >= supportPreview.layers.length ? "All layers" : `${supportPreview.layers[layerIndex]?.printZ.toFixed(2)} mm`}<input type="range" min="0" max={supportPreview.layers.length} step="1" value={layerIndex} onChange={event=>setLayerIndex(Number(event.target.value))} /></label>
        </>}
        {supportPreview?.time && <p className="small">Slicer estimate: {Math.round(supportPreview.time.estimatedSeconds / 60)} min · not physically calibrated</p>}
        <p className="small muted">Single-part view; copies remain an operator instruction.</p>
      </section>}
      <p className="small muted">
        Units: millimeters. Preview does not check printability. Mirroring
        leaves the original STL unchanged.
      </p>
    </div>
  );
}
