import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

interface STLViewerProps {
  file: File;
}

export const STLViewer: React.FC<STLViewerProps> = ({ file }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<{ x: number; y: number; z: number; triangles: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!containerRef.current || !file) return;

    let isMounted = true;
    let animationFrameId: number;

    // Set up Three.js Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x090d16);

    const width = containerRef.current.clientWidth || 400;
    const height = 240;

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    containerRef.current.innerHTML = '';
    containerRef.current.appendChild(renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xCEB888, 1.2);
    dirLight1.position.set(50, 80, 50);
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0x38bdf8, 0.6);
    dirLight2.position.set(-50, -40, -50);
    scene.add(dirLight2);

    // Build Plate Grid
    const gridHelper = new THREE.GridHelper(120, 24, 0xCEB888, 0x1e293b);
    gridHelper.position.y = -0.5;
    scene.add(gridHelper);

    // Read and parse STL file
    const reader = new FileReader();
    reader.onload = (e) => {
      if (!isMounted || !e.target?.result) return;
      const buffer = e.target.result as ArrayBuffer;

      try {
        const geometry = parseSTL(buffer);
        geometry.computeVertexNormals();
        geometry.center();

        geometry.computeBoundingBox();
        const bbox = geometry.boundingBox!;
        const sizeX = Math.round((bbox.max.x - bbox.min.x) * 10) / 10;
        const sizeY = Math.round((bbox.max.y - bbox.min.y) * 10) / 10;
        const sizeZ = Math.round((bbox.max.z - bbox.min.z) * 10) / 10;
        const triangleCount = geometry.attributes.position.count / 3;

        setDimensions({ x: sizeX, y: sizeY, z: sizeZ, triangles: Math.round(triangleCount) });

        // Material with metallic sheen
        const material = new THREE.MeshStandardMaterial({
          color: 0xCEB888,
          metalness: 0.25,
          roughness: 0.45,
        });

        const mesh = new THREE.Mesh(geometry, material);
        // Position on top of the grid
        const maxDim = Math.max(sizeX, sizeY, sizeZ);
        mesh.position.y = (sizeY / 2);
        gridHelper.position.y = 0;

        scene.add(mesh);

        // Position camera nicely
        const distance = maxDim * 2.2;
        camera.position.set(distance * 0.8, distance * 0.9, distance * 1.2);
        camera.lookAt(0, maxDim * 0.4, 0);

        setLoading(false);

        // Gentle auto-rotation
        let isDragging = false;
        let prevMouseX = 0;
        let prevMouseY = 0;

        const onMouseDown = (ev: MouseEvent) => {
          isDragging = true;
          prevMouseX = ev.clientX;
          prevMouseY = ev.clientY;
        };

        const onMouseMove = (ev: MouseEvent) => {
          if (!isDragging) return;
          const deltaX = ev.clientX - prevMouseX;
          const deltaY = ev.clientY - prevMouseY;
          mesh.rotation.y += deltaX * 0.01;
          mesh.rotation.x += deltaY * 0.01;
          prevMouseX = ev.clientX;
          prevMouseY = ev.clientY;
        };

        const onMouseUp = () => {
          isDragging = false;
        };

        renderer.domElement.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        const animate = () => {
          animationFrameId = requestAnimationFrame(animate);
          if (!isDragging) {
            mesh.rotation.y += 0.008;
          }
          renderer.render(scene, camera);
        };
        animate();
      } catch (err) {
        console.error('Failed to parse STL geometry:', err);
        setLoading(false);
      }
    };

    reader.readAsArrayBuffer(file);

    return () => {
      isMounted = false;
      cancelAnimationFrame(animationFrameId);
      renderer.dispose();
    };
  }, [file]);

  return (
    <div className="relative rounded-xl overflow-hidden border border-slate-800 bg-slate-900/60 backdrop-blur-sm">
      <div ref={containerRef} className="w-full h-60 flex items-center justify-center cursor-grab active:cursor-grabbing" />
      
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70">
          <div className="flex items-center gap-2 text-amber-300 text-sm font-medium">
            <span className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin"></span>
            Loading 3D preview...
          </div>
        </div>
      )}

      {dimensions && (
        <div className="absolute bottom-2 left-2 right-2 flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-slate-900/80 backdrop-blur-md rounded-lg border border-slate-800 text-[11px] text-slate-300 font-mono">
          <div className="flex items-center gap-3">
            <span>Dimensions: <strong className="text-amber-300">{dimensions.x} × {dimensions.y} × {dimensions.z} mm</strong></span>
          </div>
          <div>
            <span>Triangles: <strong className="text-slate-100">{dimensions.triangles.toLocaleString()}</strong></span>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Standard binary/ASCII STL parser to Three.js BufferGeometry
 */
function parseSTL(data: ArrayBuffer): THREE.BufferGeometry {
  const reader = new DataView(data);
  const isBinary = data.byteLength > 84 && (() => {
    const faces = reader.getUint32(80, true);
    return data.byteLength === 84 + faces * 50;
  })();

  const geometry = new THREE.BufferGeometry();

  if (isBinary) {
    const faces = reader.getUint32(80, true);
    const positions = new Float32Array(faces * 9);
    let offset = 84;

    for (let i = 0; i < faces; i++) {
      offset += 12; // skip normal
      for (let j = 0; j < 3; j++) {
        positions[i * 9 + j * 3] = reader.getFloat32(offset, true);
        positions[i * 9 + j * 3 + 1] = reader.getFloat32(offset + 4, true);
        positions[i * 9 + j * 3 + 2] = reader.getFloat32(offset + 8, true);
        offset += 12;
      }
      offset += 2; // skip attribute byte count
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  } else {
    // ASCII Fallback
    const text = new TextDecoder().decode(data);
    const patternVertex = /vertex[\s]+([\d.eE\-+]+)[\s]+([\d.eE\-+]+)[\s]+([\d.eE\-+]+)/g;
    const positions: number[] = [];
    let match;

    while ((match = patternVertex.exec(text)) !== null) {
      positions.push(parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]));
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  }

  return geometry;
}
