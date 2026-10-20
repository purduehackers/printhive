import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
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
}: {
  file: File | null;
  color: string;
  mirror: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    workerRef = useRef<Worker | null>(null),
    reset = useRef<() => void>(() => {});
  const meshRef = useRef<THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshStandardMaterial
  > | null>(null);
  const [model, setModel] = useState<Model | null>(null),
    [message, setMessage] = useState(""),
    [loading, setLoading] = useState(false);
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
    geometry.translate(-center[0], -center[1], -center[2]);
    geometry.scale(2 / extent, 2 / extent, 2 / extent);
    geometry.rotateX(-Math.PI / 2);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.65,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    meshRef.current = mesh;
    scene.add(mesh);
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
    mesh.scale.x = mirror ? -1 : 1;
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
    meshRef.current.scale.x = mirror ? -1 : 1;
  }, [color, mirror]);
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
      <p className="small muted">
        Units: millimeters. Preview does not check printability. Mirroring
        leaves the original STL unchanged.
      </p>
    </div>
  );
}
