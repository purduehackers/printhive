import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  createPreviewClient,
  type PreviewClient,
  type FastSupportPreview,
} from "@time-estimator/browser-preview";
import { displayTransform } from "@time-estimator/browser-preview/geometry";
import {
  createSupportShapeOverlay,
  type SupportShapeOverlay,
} from "@time-estimator/browser-preview/three";
import "../styles/support-preview.css";
import { previewColor } from "../lib/shared";
import { rememberThumbnailMesh } from "../lib/thumbnail-mesh";
import {
  PreviewResultCache,
  previewCacheKey,
  runtimeCacheIdentity,
} from "../lib/preview-cache";
import {
  PREVIEW_PRINTERS,
  PREVIEW_PROFILE_FILES,
  parsePreviewProfile,
  selectPreviewPrinter,
  fitsPreviewPrinter,
  profileForPreviewBed,
  formatPrintTime,
  applyPrintTimeAllowance,
  type PrinterPreviewProfile,
} from "../lib/preview";
import {
  IDENTITY_ROTATION,
  poseMatrix,
  multiplyRotations,
  rotationForFace,
} from "@time-estimator/browser-preview/pose";

interface Model {
  file: File;
  rotation: number[];
  mirror: boolean;
  scale: number;
  positions: Float32Array;
  min: number[];
  max: number[];
  hullPositions?: Float32Array;
}
interface Props {
  file: File | null;
  retainedFiles: File[];
  modelUnits: string;
  settingsValid: boolean;
  color: string;
  copies: number;
  mirror: boolean;
  scale: number;
  infill: number;
  layerHeight: number;
  supports: string;
  supportAngle?: number;
  rotation: number[];
  onRotationChange: (rotation: number[]) => void;
  onUseMeters: () => void;
  disabled?: boolean;
}

export default function Preview({
  file,
  retainedFiles,
  modelUnits,
  settingsValid,
  color,
  copies,
  mirror,
  scale,
  infill,
  layerHeight,
  supports,
  supportAngle,
  rotation,
  onRotationChange,
  onUseMeters,
  disabled = false,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const fileWorker = useRef<Worker | null>(null);
  const client = useRef<PreviewClient<File> | null>(null);
  const resultCache = useRef<PreviewResultCache | null>(null);
  resultCache.current ??= new PreviewResultCache();
  const [cacheRuntime, setCacheRuntime] = useState<ReturnType<
    typeof runtimeCacheIdentity
  > | null>();
  const orientationClient = useRef<PreviewClient<File> | null>(null);
  const meshRef = useRef<THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshStandardMaterial
  > | null>(null);
  const frameRef = useRef<THREE.Group | null>(null);
  const overlayRef = useRef<SupportShapeOverlay | null>(null);
  const reset = useRef<() => void>(() => {});
  const render = useRef<() => void>(() => {});
  const revision = useRef(0);
  const faceAction = useRef<(normal: number[]) => void>(() => {});
  const faceModeRef = useRef(false);
  const [loadedModel, setModel] = useState<Model | null>(null);
  const [loadedProfile, setLoadedProfile] = useState<{
    file: File;
    printerId: string;
    retry: number;
    profile?: PrinterPreviewProfile;
    error?: string;
  } | null>(null);
  const [preview, setPreview] = useState<FastSupportPreview | null>(null);
  const [tab, setTab] = useState<"model" | "layers">("model");
  const [reading, setReading] = useState(false);
  const [orienting, setOrienting] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [calculationProgress, setCalculationProgress] = useState<
    number | "finishing" | null
  >(null);
  const [retry, setRetry] = useState(0);
  const [message, setMessage] = useState("");
  const [layerIndex, setLayerIndex] = useState(0);
  const [faceMode, setFaceMode] = useState(false);
  const model =
    loadedModel?.file === file &&
    loadedModel.rotation === rotation &&
    loadedModel.mirror === mirror &&
    loadedModel.scale === scale
      ? loadedModel
      : null;
  const modelDimensions = model
    ? model.min.map((value, i) => model.max[i] - value)
    : [];
  const printer = model
    ? selectPreviewPrinter(modelDimensions)
    : PREVIEW_PRINTERS[0];
  const activeProfile =
    loadedProfile?.file === file &&
    loadedProfile.printerId === printer.id &&
    loadedProfile.retry === retry
      ? loadedProfile
      : null;
  const profile = activeProfile?.profile ?? null;
  const profileError = activeProfile?.error;
  const profileLoading = !profile && !profileError;
  const fits = model ? fitsPreviewPrinter(modelDimensions, printer) : true;
  const modelReady = Boolean(model);
  const tooSmall =
    modelReady &&
    modelUnits === "mm" &&
    Math.max(...modelDimensions) < 1 &&
    modelDimensions[2] < layerHeight / 2;
  faceModeRef.current = faceMode && !disabled;
  faceAction.current = (normal) => {
    onRotationChange(multiplyRotations(rotationForFace(normal), rotation));
    setFaceMode(false);
  };

  useEffect(() => {
    const controller = new AbortController();
    fetch("/preview-engine/manifest.json", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Missing engine identity");
        return response.json();
      })
      .then(runtimeCacheIdentity)
      .then((identity) => {
        if (!controller.signal.aborted) setCacheRuntime(identity);
      })
      .catch(() => {
        if (!controller.signal.aborted) setCacheRuntime(null);
      });
    return () => {
      controller.abort();
      client.current?.dispose();
      orientationClient.current?.dispose();
      client.current = null;
      orientationClient.current = null;
    };
  }, []);

  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    setLoadedProfile(null);
    fetch(PREVIEW_PROFILE_FILES[printer.id], {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Missing printer settings (${response.status})`);
        return parsePreviewProfile(await response.json(), printer.id);
      })
      .then((profile) => {
        if (!controller.signal.aborted)
          setLoadedProfile({ file, printerId: printer.id, retry, profile });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setLoadedProfile({
            file,
            printerId: printer.id,
            retry,
            error: `Couldn't load slicer settings for ${printer.name}. Reload to try again.`,
          });
      });
    return () => controller.abort();
    // Revalidate on file selection/retry. Unchanged configuration still reuses completed results.
    // Bind the response to its file and printer so stale settings cannot start an estimate.
  }, [file, printer, retry]);

  useEffect(() => {
    revision.current++;
    client.current?.cancel();
    orientationClient.current?.cancel();
    overlayRef.current?.dispose();
    overlayRef.current = null;
    setPreview(null);
    setOrienting(false);
    setMessage("");
  }, [
    file,
    mirror,
    rotation,
    scale,
    infill,
    layerHeight,
    supports,
    supportAngle,
    settingsValid,
  ]);

  useEffect(() => {
    setTab("model");
    setFaceMode(false);
  }, [file]);

  useEffect(() => {
    resultCache.current?.retain(retainedFiles);
  }, [retainedFiles]);

  useEffect(() => {
    if (supports === "none") setTab("model");
  }, [supports]);

  function makeClient() {
    return createPreviewClient<File>({
      manifestUrl: new URL(
        "/preview-engine/manifest.json",
        window.location.origin,
      ).href,
      workerFactory: () =>
        new Worker(new URL("../workers/support.worker.ts", import.meta.url), {
          type: "module",
        }),
    });
  }

  async function autoOrient() {
    if (!file || orienting || disabled) return;
    const currentRevision = ++revision.current;
    client.current?.cancel();
    setOrienting(true);
    setTab("model");
    setMessage("");
    try {
      orientationClient.current ??= makeClient();
      const result = await orientationClient.current.orient({
        input: file,
        rotation,
        mirrorX: mirror,
        scale,
      });
      if (revision.current === currentRevision) {
        setFaceMode(false);
        onRotationChange(result.rotation);
      }
    } catch (error) {
      if (revision.current === currentRevision)
        setMessage(
          (error as { code?: string }).code === "canceled"
            ? "Orientation canceled."
            : error instanceof Error
              ? error.message.slice(0, 200)
              : "Couldn't find an orientation. Choose a face instead.",
        );
    } finally {
      if (revision.current === currentRevision) setOrienting(false);
    }
  }

  // One background task shares physical slices between support shapes and quick timing.
  useEffect(() => {
    if (
      !file ||
      cacheRuntime === undefined ||
      !profile ||
      !modelReady ||
      !fits ||
      tooSmall ||
      orienting ||
      disabled
    ) {
      setCalculating(false);
      return;
    }
    const effectiveProfile = profileForPreviewBed(
      profile,
      printer,
      supportAngle,
    );
    const key = cacheRuntime
      ? previewCacheKey(cacheRuntime.key, effectiveProfile, {
          rotation,
          mirror,
          scale,
          infill,
          layerHeight,
          supports,
        })
      : null;
    const cached = key ? resultCache.current?.get(file, key) : undefined;
    if (cached) {
      setPreview({ ...cached });
      setLayerIndex(Math.max(0, cached.layers.length - 1));
      setCalculating(false);
      return;
    }
    let active = true;
    setCalculating(true);
    setCalculationProgress(null);
    const timer = window.setTimeout(async () => {
      try {
        client.current ??= makeClient();
        const result = await client.current.estimate(
          {
            input: file,
            profile: effectiveProfile,
            support:
              supports === "none"
                ? "none"
                : supports === "normal"
                  ? "normal"
                  : "tree",
            scope: "model_and_supports",
            mirrorX: mirror,
            rotation,
            scale,
            infill,
            layerHeight,
          },
          {
            onProgress: (progress) => {
              if (!active) return;
              if (progress.stage === "extracting")
                setCalculationProgress("finishing");
              else if (
                progress.stage === "generating" &&
                Number.isFinite(progress.percent)
              )
                setCalculationProgress((current) =>
                  Math.max(
                    typeof current === "number" ? current : 0,
                    Math.min(99, Math.round(progress.percent)),
                  ),
                );
            },
          },
        );
        if (active) {
          if (
            key &&
            result.provenance.runtimeSha256 === cacheRuntime?.wasmSha256
          )
            resultCache.current?.set(file, key, result);
          flushSync(() => {
            setPreview(result);
            setLayerIndex(Math.max(0, result.layers.length - 1));
            setCalculating(false);
          });
        }
      } catch (error) {
        if (active && (error as { code?: string }).code !== "canceled")
          setMessage(
            error instanceof Error
              ? error.message.slice(0, 200)
              : "Couldn't prepare this preview.",
          );
      } finally {
        if (active) setCalculating(false);
      }
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
      client.current?.cancel();
    };
  }, [
    file,
    cacheRuntime,
    profile,
    modelReady,
    printer,
    fits,
    tooSmall,
    mirror,
    rotation,
    scale,
    infill,
    layerHeight,
    supports,
    supportAngle,
    orienting,
    disabled,
    retry,
  ]);

  useEffect(() => {
    setReading(Boolean(file));
    if (!file) {
      setModel(null);
      return;
    }
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
      else {
        const model = { ...data, file, rotation, mirror, scale };
        rememberThumbnailMesh(file, model);
        setModel(model);
      }
      worker.terminate();
    };
    worker.onerror = () => {
      setReading(false);
      setMessage("Couldn't open this preview.");
      worker.terminate();
    };
    worker.postMessage({ file, rotation, mirror, scale, hull: faceMode });
    return () => {
      worker.terminate();
      fileWorker.current = null;
    };
  }, [file, rotation, mirror, scale, faceMode]);

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
    const { x: bedWidth, y: bedDepth } = printer.buildVolume;
    const grid = new THREE.GridHelper(
      bedWidth,
      Math.max(1, Math.round(bedWidth / 10)),
      "#a5afb6",
      "#6e7b84",
    );
    grid.rotation.x = Math.PI / 2;
    grid.scale.z = bedDepth / bedWidth;
    grid.position.z = -0.02;
    root.add(grid);
    const bed = new THREE.Mesh(
      new THREE.PlaneGeometry(bedWidth, bedDepth),
      new THREE.MeshStandardMaterial({ color: "#48545c", roughness: 1 }),
    );
    bed.position.z = -0.05;
    root.add(bed);
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
  }, [model, printer]);

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
    let overlay: SupportShapeOverlay;
    try {
      overlay = createSupportShapeOverlay(preview);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Couldn't display supports.",
      );
      render.current();
      return;
    }
    overlayRef.current = overlay;
    frameRef.current.add(overlay.group);
    return () => {
      overlay.dispose();
      if (overlayRef.current === overlay) overlayRef.current = null;
    };
  }, [preview, model]);

  useEffect(() => {
    const layered =
      tab === "layers" &&
      Boolean(preview?.shapes.length && preview?.layers.length);
    if (meshRef.current) {
      meshRef.current.visible = true;
      const material = meshRef.current.material;
      const showSupports = layered && Boolean(preview?.shapes.length);
      if (material.transparent !== showSupports) {
        material.transparent = showSupports;
        material.depthWrite = !showSupports;
        material.needsUpdate = true;
      }
      material.opacity = showSupports ? 0.3 : 1;
    }
    const overlay = overlayRef.current;
    if (!overlay) {
      render.current();
      return;
    }
    overlay.setVisible(layered);
    const layer = preview?.layers[layerIndex];
    if (layer) {
      overlay.setLayerRange(-Infinity, layer.printZ + 0.000001);
    }
    render.current();
  }, [preview, model, tab, layerIndex]);

  const layered =
    tab === "layers" &&
    Boolean(preview?.shapes.length && preview?.layers.length);
  const dimensions = model?.min
    .map((value, i) => Number((model.max[i] - value).toFixed(1)))
    .join(" × ");
  const noSupportsNeeded =
    modelReady &&
    preview &&
    supports !== "none" &&
    preview.shapes.length === 0 &&
    !calculating &&
    settingsValid;
  const timeAllowancePercent = profile?.timeAllowancePercent ?? 30;
  const seconds = preview?.estimatedSeconds;
  const time =
    seconds !== undefined
      ? formatPrintTime(
          applyPrintTimeAllowance(seconds, timeAllowancePercent),
          true,
        )
      : orienting
        ? "Waiting for orientation…"
        : !fits || tooSmall || !settingsValid || profileError
          ? "Unavailable"
          : calculating ||
              reading ||
              profileLoading ||
              (!message && !profileError && !disabled && !tooSmall)
            ? calculationProgress === "finishing"
              ? "Finishing…"
              : calculationProgress === null
                ? "Calculating…"
                : `Calculating… ${calculationProgress}%`
            : "Unavailable";
  return (
    <div className="preview-panel print-preview">
      <div className="preview-header">
        <h2>Print preview</h2>
        <div className="preview-tabs" role="tablist" aria-label="Preview mode">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "model"}
            onClick={() => setTab("model")}
          >
            Model
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "layers"}
            disabled={
              supports === "none" || !model || !profile || disabled || tooSmall
            }
            onClick={() => {
              setFaceMode(false);
              setTab("layers");
            }}
          >
            Supports
          </button>
        </div>
      </div>
      {file && (
        <div className="preview-file">
          <span>Previewing</span>
          <strong title={file.name}>{file.name}</strong>
        </div>
      )}
      {file && (
        <div className="print-time" aria-live="polite">
          <span>Print time:</span>
          <strong>{time}</strong>
          {model && (
            <span className="small muted" aria-label="Estimate printer">
              For {printer.name}
            </span>
          )}
          {preview && <span className="small muted">Quick estimate</span>}
          {copies > 1 && (
            <span className="small muted">per copy · {copies} copies</span>
          )}
        </div>
      )}
      {noSupportsNeeded && (
        <div className="support-result" role="status">
          <span className="support-result-icon" aria-hidden="true">
            ✓
          </span>
          <div>
            <strong>No supports needed</strong>
            <p>None were generated for this orientation and these settings.</p>
          </div>
        </div>
      )}
      {file && (
        <div
          className="orientation-toolbar"
          role="group"
          aria-label="Model orientation"
        >
          <span>Orientation</span>
          <button
            type="button"
            disabled={orienting || disabled || !model}
            onClick={autoOrient}
          >
            Auto
          </button>
          <button
            type="button"
            disabled={orienting || disabled || reading}
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
            disabled={orienting || disabled}
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
            layered ? "Generated support shapes" : "Interactive model preview"
          }
        >
          {!model && (
            <div className="preview-placeholder">
              <p>{reading ? "Opening model…" : "Choose a file to preview."}</p>
            </div>
          )}
          {orienting && (
            <div className="preview-loading" role="status">
              Finding an orientation…{" "}
              <button
                type="button"
                className="text-button"
                onClick={() => orientationClient.current?.cancel()}
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
          </div>
        </div>
      )}
      {model && (
        <div className="printer-fit-info">
          <span className="fit-label">Printer fit</span>
          <div className="fit-badges">
            {PREVIEW_PRINTERS.map((printer) => {
              const fits = fitsPreviewPrinter(modelDimensions, printer);
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
      {model && (
        <p className="preview-bed">
          Bed: <strong>{printer.name}</strong> · {printer.buildVolume.x} ×{" "}
          {printer.buildVolume.y} mm
          {!fits && (
            <span>
              {" "}
              · Too large for this bed. Rotate the part or choose a smaller
              model.
            </span>
          )}
        </p>
      )}
      {calculating && (
        <p className="small" role="status">
          {calculationProgress === "finishing"
            ? "Finishing supports…"
            : typeof calculationProgress === "number"
              ? `Preparing supports… ${calculationProgress}%`
              : "Preparing supports…"}
        </p>
      )}
      {tooSmall && (
        <p className="small unit-warning">
          This file is smaller than 1 mm. Was it exported in meters?{" "}
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={onUseMeters}
          >
            Use meters
          </button>
        </p>
      )}
      {(message || profileError) && (
        <p className="small preview-message" role="status">
          {message || profileError}{" "}
          {profile && !calculating && !orienting && fits && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setMessage("");
                setRetry((value) => value + 1);
              }}
            >
              Try again
            </button>
          )}
        </p>
      )}
      <div className="preview-summary">
        <span>{dimensions && `${dimensions} mm`}</span>
      </div>
    </div>
  );
}
