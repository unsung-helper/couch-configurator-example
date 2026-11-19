import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { LoadWasm } from '../LoadWasm';
import {
  createSceneEffects, environmentToWorld, highlight, loadEnvironmentMap, setToneMapping, syncLayers, toneMapped,
} from './sceneEffects';

// Every point of a points output is this sphere, scaled to the point size (its
// diameter, in world units)
const POINT_SPHERE = new THREE.SphereGeometry(0.5, 12, 8);
POINT_SPHERE.userData.shared = true;

/**
 * Full-size three.js canvas that:
 *  - Loads the WASM module (unsung.js) and calls module.load() once ready
 *    (the product is baked into the export at build time — load() takes no
 *    arguments and no separate "query" step is needed), then module.execute()
 *    when productLoaded arrives, so the product runs on load.
 *  - Renders the mesh / polyline / points / scene-camera outputs.
 *  - Forwards every pointer/wheel event over the canvas to the WASM via
 *    sendMouseEvent()/sendWheelEvent() — any node can listen for these now,
 *    not just a single "active" one — and replays them as native events when
 *    the module reports nothing consumed them (userEventHandled), so
 *    TrackballControls performs its own default navigation.
 *  - Reports TrackballControls-driven camera changes back to the engine via
 *    sendCameraChange(), and canvas resizes via sendDimensionsChange().
 *  - Calls onModuleReady(module) once the WASM is initialised and loaded.
 */
const ThreeCanvas = ({ onModuleReady, onLoadError }) => {
  const mountRef = useRef(null);
  const moduleRef = useRef(null);
  const fitToSceneRef = useRef(null);
  // Frame rate counter, switched on by the scene output's showFrameRate input.
  // The render loop writes the rate straight into the element.
  const [showFrameRate, setShowFrameRate] = useState(false);
  const frameRateRef = useRef(null);

  useEffect(() => {
    let camera, scene, renderer, controls, effects;
    // id → prototype THREE.Mesh / LineSegments / Points of every geometry
    // output. The handlers below keep its geometry, material and visibility up
    // to date, but it isn't in the scene itself: `groups[id]` is, with one child
    // per engine instance sharing the prototype's geometry and material (see
    // syncInstances).
    const objects = {};
    const groups = {};           // id → THREE.Group in the scene
    const instanceMatrices = {}; // id → THREE.Matrix4[] from *OutputInstancesChanged
    // Geometries and materials by engine id. Outputs that show the same one
    // (assembly instances sharing it) all point at one entry, so it exists
    // once, on the GPU too. Set by mesh/polyline Geometry/MaterialChanged, which
    // replace the content of an id for every output that shows it, and disposed
    // on the matching ...Removed, never by the outputs that use them.
    const meshGeometries = {};  // id → THREE.BufferGeometry
    const meshMaterials = {};   // id → { detail, texture, releaseTexture, variants: { plain, colored } }
    // url → { users, texture, waiting, release }: textures shared by every
    // material that shows one, so a material that changes in anything but its
    // texture doesn't load and upload it again. One that no material uses
    // anymore is kept a moment, as the engine may remove a material before it
    // adds the one replacing it.
    const textures = new Map();
    const lineGeometries = {};  // id → THREE.BufferGeometry
    const lineMaterials = {};   // id → THREE.LineBasicNodeMaterial
    // output id → the geometry or material id it shows
    const meshGeometryOf = {};
    const meshMaterialOf = {};
    const lineGeometryOf = {};
    const lineMaterialOf = {};
    // the outputs that show the given id
    const showing = (of, resource) => Object.keys(of).filter(id => of[id] === resource);
    const pendingEvents = {}; // requestId → saved pointer event data (for userEventHandled)
    const pendingWheelEvents = {}; // requestId → saved wheel event data
    // Whether the engine's last-known camera is locked — echoed back on every
    // sendCameraChange call (see sendCameraToEngine below).
    let cameraLocked = false;

    // ── Lighting ───────────────────────────────────────────────────────────
    // Driven by the engine's `sceneOutputLightingChanged` event. Until one
    // arrives (or after the scene output / product goes away) the default is a
    // single camera-attached point light at 0.9,0.9,0.9. A received config is
    // authoritative: whatever it omits is simply absent. Light colours are used
    // as direct radiance — point lights use decay 0 so brightness is
    // independent of model scale. An environment map lights the scene as well;
    // the ambient light is ignored while there is one.
    let lightRig = null;
    let cameraLight = null;
    let lightingSourceId = null;
    let lastLightingDetail = null;
    const DEFAULT_CAMERA_LIGHT = [0.9, 0.9, 0.9];

    function disposeLightRig() {
      if (!lightRig) return;
      for (const child of [...lightRig.children]) {
        lightRig.remove(child);
        child.dispose?.();
      }
    }
    function setCameraLight(rgb) {
      if (cameraLight) { camera.remove(cameraLight); cameraLight.dispose(); cameraLight = null; }
      if (!rgb) return;
      cameraLight = new THREE.PointLight(new THREE.Color(rgb[0], rgb[1], rgb[2]), 1, 0, 0);
      camera.add(cameraLight);
    }
    // The region shadows should be optimised for: the engine's explicit
    // `bounds` (shadow bounds) when given — this is what tightens the shadow map
    // onto the part of the scene that matters — else the live scene bbox, else a
    // default cube.
    function shadowRegion(bounds) {
      if (bounds && bounds.min && bounds.max) {
        return new THREE.Box3(
          new THREE.Vector3().fromArray(bounds.min),
          new THREE.Vector3().fromArray(bounds.max),
        );
      }
      const box = new THREE.Box3();
      Object.values(groups).forEach(obj => {
        if (!obj.visible) return;
        const b = new THREE.Box3().setFromObject(obj);
        if (!b.isEmpty()) box.union(b);
      });
      if (!box.isEmpty()) return box;
      return new THREE.Box3(new THREE.Vector3(-1000, -1000, -1000), new THREE.Vector3(1000, 1000, 1000));
    }
    // Tighten a directional light's orthographic shadow frustum to exactly
    // enclose `box` (in the shadow camera's own space) so every shadow-map texel
    // is spent on that region. The renderer still derives the shadow camera's
    // position/orientation from the light itself.
    const _c = new THREE.Vector3();
    function fitDirectionalShadow(light, box) {
      light.updateWorldMatrix(true, false);
      light.target.updateWorldMatrix(true, false);
      light.shadow.updateMatrices(light);
      const view = light.shadow.camera.matrixWorldInverse;
      const lb = new THREE.Box3();
      for (let i = 0; i < 8; i++) {
        _c.set(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        ).applyMatrix4(view);
        lb.expandByPoint(_c);
      }
      const cam = light.shadow.camera;
      cam.left = lb.min.x; cam.right = lb.max.x;
      cam.bottom = lb.min.y; cam.top = lb.max.y;
      cam.near = Math.max(-lb.max.z - 1, 0.01); // camera looks down -Z
      cam.far = -lb.min.z + 1;
      cam.updateProjectionMatrix();
    }
    // The lighting's environment map (see loadEnvironmentMap), loaded once per
    // URL. The background shows it too when the scene output asks for that.
    let environmentUrl = null;
    let environmentMap = null;
    let environmentFrame = environmentToWorld(0);
    function setEnvironment(environment) {
      environmentFrame = environmentToWorld(environment?.rotation ?? 0);
      scene.environmentRotation.setFromRotationMatrix(environmentFrame);
      scene.environmentIntensity = environment?.intensity ?? 1;
      const url = environment?.map || null;
      if (url !== environmentUrl) {
        environmentUrl = url;
        environmentMap?.dispose();
        environmentMap = null;
        scene.environment = null;
        if (url) {
          loadEnvironmentMap(url, environment.format ?? '', map => {
            if (environmentUrl !== url) { map.dispose(); return; }
            environmentMap = map;
            scene.environment = map;
            effects?.setEnvironment(environmentMap, environmentFrame);
          }, error => console.warn('Could not load the environment map', error));
        }
      }
      effects?.setEnvironment(environmentMap, environmentFrame);
    }
    function rebuildLighting(detail) {
      disposeLightRig();
      lastLightingDetail = detail;
      if (!detail) {
        lightingSourceId = null;
        setEnvironment(null);
        setCameraLight(DEFAULT_CAMERA_LIGHT);
        return;
      }
      if (detail.id) lightingSourceId = detail.id;
      const region = shadowRegion(detail.bounds);
      const center = region.getCenter(new THREE.Vector3());
      const radius = region.getBoundingSphere(new THREE.Sphere()).radius || 1;

      setEnvironment(detail.environment ?? null);
      if (!detail.environment) {
        const amb = detail.ambientLightColor || [0, 0, 0];
        lightRig.add(new THREE.AmbientLight(new THREE.Color(amb[0], amb[1], amb[2]), 1));
      }

      setCameraLight(detail.cameraLight ? (detail.cameraLightColor || DEFAULT_CAMERA_LIGHT) : null);

      (detail.directionalLights || []).forEach(dl => {
        if (!dl.enabled) return;
        const light = new THREE.DirectionalLight(new THREE.Color(dl.color[0], dl.color[1], dl.color[2]), 1);
        const dir = new THREE.Vector3(dl.direction[0], dl.direction[1], dl.direction[2]);
        if (dir.lengthSq() < 1e-12) dir.set(0, -1, 0);
        dir.normalize();
        light.position.copy(center).addScaledVector(dir, -radius * 2);
        light.target.position.copy(center);
        lightRig.add(light);
        lightRig.add(light.target);
        if (dl.castsShadow) {
          light.castShadow = true;
          light.shadow.mapSize.set(2048, 2048);
          light.shadow.bias = -0.0005;
          fitDirectionalShadow(light, region);
        }
      });

      (detail.pointLights || []).forEach(pl => {
        if (!pl.enabled) return;
        const light = new THREE.PointLight(new THREE.Color(pl.color[0], pl.color[1], pl.color[2]), 1, 0, 0);
        light.position.set(pl.position[0], pl.position[1], pl.position[2]);
        if (pl.castsShadow) {
          light.castShadow = true;
          light.shadow.mapSize.set(1024, 1024);
          light.shadow.bias = -0.0005;
          const distToCenter = light.position.distanceTo(center);
          light.shadow.camera.near = Math.max((distToCenter - radius) * 0.9, 0.05);
          light.shadow.camera.far = distToCenter + radius + 1;
          light.shadow.camera.updateProjectionMatrix();
        }
        lightRig.add(light);
      });
    }
    function refitShadows() {
      if (!lastLightingDetail || (lastLightingDetail.bounds && lastLightingDetail.bounds.min)) return;
      if (lightRig && lightRig.children.some(c => c.isDirectionalLight && c.castShadow)) {
        rebuildLighting(lastLightingDetail);
      }
    }
    function onSceneOutputLightingChanged(event) {
      rebuildLighting(event.detail);
      effects.invalidate();
    }
    // The scene output's background and contact shadow, see sceneEffects.js:
    // until there is one, no background (the page shows through) and no shadow
    function resetSceneOutput() {
      effects.setBackground({ mode: 'none' });
      setToneMapping('none', 1);
      effects.setContactShadow({ enabled: false, orientation: new THREE.Matrix4().elements });
      setShowFrameRate(false);
    }
    function onSceneOutputRemoved(event) {
      if (event.detail.id === lightingSourceId) rebuildLighting(null);
      resetSceneOutput();
    }
    function onSceneOutputChanged(event) {
      const { showFrameRate, background, contactShadow, toneMapping, exposure } = event.detail;
      setShowFrameRate(!!showFrameRate);
      effects.setBackground(background);
      setToneMapping(toneMapping, exposure);
      effects.setContactShadow(contactShadow);
    }

    // ── three.js scene setup ────────────────────────────────────────────────

    function initThree() {
      const container = mountRef.current;
      const width = container.clientWidth;
      const height = container.clientHeight;

      scene = new THREE.Scene();

      camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 10000);
      camera.position.set(150, 150, 150);
      camera.up.set(0, 0, 1); // the engine's cameras are z-up by default

      // WebGPU where the browser has it, WebGL 2 otherwise. Transparent: where
      // the product has no background, the page shows through.
      renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      container.appendChild(renderer.domElement);

      scene.add(camera); // camera-attached light only renders if the camera is in the graph
      lightRig = new THREE.Group();
      scene.add(lightRig);
      rebuildLighting(null); // default: single 0.9,0.9,0.9 camera light

      // background, contact shadow and highlights; the contact shadow covers
      // the lighting's shadow bounds, like the light shadows do
      effects = createSceneEffects(renderer, scene, camera, () => shadowRegion(lastLightingDetail?.bounds));
      effects.setEnvironment(environmentMap, environmentFrame);

      // Free rotation around the target: the up vector turns along with the
      // view instead of being pinned to the axis OrbitControls fixes when it
      // is created. Left drag rotates, right drag pans, middle drag and the
      // wheel zoom.
      controls = new TrackballControls(camera, renderer.domElement);
      controls.staticMoving = true;
      controls.rotateSpeed = 1.5;
      controls.panSpeed = 1;
      // no A/S/D mode keys: they would fire while typing in the page's inputs
      controls.keys = ['', '', ''];
      controls.addEventListener('change', sendCameraToEngine);

      // starts once the renderer is initialised
      renderer.setAnimationLoop(animate);
    }

    // Reports the current camera back to the engine — after local navigation
    // (TrackballControls drag/pan/zoom) as well as after applying a camera pushed
    // from the engine itself (see onSceneOutputCameraChanged below), so
    // IDisplay::camera() (and anything listening via onCameraChanged()) never
    // goes stale relative to what's actually on screen. Not an echo loop:
    // sendCameraChange only updates IDisplay's own camera state and doesn't
    // trigger re-execution (see PassCameraChangedCommand::triggersExecution()),
    // so it can't feed back into another sceneOutputCameraChanged.
    // The near and far planes follow the camera's distance to what it orbits:
    // depth precision falls with distance² / near, so a near plane fixed while
    // zooming out (or the engine's default 0.01) makes depth coarse enough for
    // the contact shadow, and any coplanar faces, to creep up objects. The
    // engine's camera (its CreateCamera inputs) only sets limits: the near plane
    // is never closer, the far plane never nearer, than it asks. Those limits,
    // not the planes in use, are what is reported back to the engine.
    let requestedNear = 0.01;
    let requestedFar = 10000;
    function updateDepthRange() {
      const distance = camera.position.distanceTo(controls.target)
      const near = Math.max(requestedNear, distance * 0.001)
      const far = Math.max(requestedFar, distance * 100, near * 10)
      if (near === camera.near && far === camera.far) return
      camera.near = near
      camera.far = far
      camera.updateProjectionMatrix()
    }

    function sendCameraToEngine() {
      updateDepthRange();
      if (!moduleRef.current) return;
      moduleRef.current.sendCameraChange(
        camera.position.x, camera.position.y, camera.position.z,
        controls.target.x, controls.target.y, controls.target.z,
        camera.up.x, camera.up.y, camera.up.z,
        requestedNear, requestedFar, camera.fov,
        cameraLocked ? 1 : 0
      );
    }

    function fitToScene() {
      const box = new THREE.Box3();
      let hasGeometry = false;
      Object.values(groups).forEach(obj => {
        if (!obj.visible) return;
        const objBox = new THREE.Box3().setFromObject(obj);
        if (!objBox.isEmpty()) { box.union(objBox); hasGeometry = true; }
      });
      if (!hasGeometry || box.isEmpty()) return;

      const center = new THREE.Vector3();
      box.getCenter(center);
      const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
      const fovRad = camera.fov * (Math.PI / 180);
      const distance = (radius / Math.sin(fovRad / 2)) * 1.1;

      const direction = camera.position.clone().sub(controls.target);
      const dirLength = direction.length();
      direction.divideScalar(dirLength || 1).multiplyScalar(distance);

      controls.target.copy(center);
      camera.position.copy(center).add(direction);
      updateDepthRange();
      controls.update();
      refitShadows();
    }

    let frames = 0;
    let framesSince = performance.now();
    function animate() {
      controls?.update();
      effects.render();
      ++frames;
      const now = performance.now();
      if (now - framesSince >= 500) {
        if (frameRateRef.current) frameRateRef.current.textContent = `${Math.round(frames * 1000 / (now - framesSince))} fps`;
        frames = 0;
        framesSince = now;
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      if (!renderer || !mountRef.current) return;
      const container = mountRef.current;
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      controls?.handleResize();
      effects.invalidate();
      if (moduleRef.current) moduleRef.current.sendDimensionsChange(w, h);
    });

    // ── User event forwarding ──────────────────────────────────────────────
    // Every pointer/wheel interaction over the canvas is forwarded to the
    // engine unconditionally — any node may be listening now. We intercept in
    // the capture phase and only let TrackballControls see the gesture (by
    // replaying a synthetic copy) once a `userEventHandled` reply says
    // nothing consumed it. Gesture: Press=0, Move=1, Release=2. Button:
    // None=0, Left=1 (matches IDisplay::MouseGesture/MouseButton in
    // engine/core/IDisplay.h).

    function modifiersOf(event) {
      let m = 0;
      if (event.ctrlKey) m |= 1;
      if (event.altKey) m |= 2;
      if (event.shiftKey) m |= 4;
      return m;
    }

    // Maps DOM `button` (0=left,1=middle,2=right,3/4=back/forward) to
    // IDisplay::MouseButton (None=0,Left=1,Middle=2,Right=3) for press/release.
    function pressedButtonOf(event) {
      switch (event.button) {
        case 0: return 1; // Left
        case 1: return 2; // Middle
        case 2: return 3; // Right
        default: return 0; // None (back/forward/etc — not forwarded)
      }
    }
    // Maps the DOM `buttons` bitmask (1=left,2=right,4=middle — note this is
    // NOT the same bit order as `button`) to a single held IDisplay::MouseButton
    // for move events, in case more than one is held.
    function heldButtonOf(buttons) {
      if (buttons & 1) return 1; // Left
      if (buttons & 4) return 2; // Middle
      if (buttons & 2) return 3; // Right
      return 0; // None
    }

    // event.clientX/clientY are viewport-relative; the canvas sits beside the
    // parameter panel, so it's not necessarily at (0,0). Convert to
    // canvas-local pixels before handing coordinates to the engine.
    function toLocal(event) {
      const rect = renderer.domElement.getBoundingClientRect();
      return { x: Math.round(event.clientX - rect.left), y: Math.round(event.clientY - rect.top) };
    }

    function savePending(id, event) {
      pendingEvents[id] = {
        type: event.type, clientX: event.clientX, clientY: event.clientY,
        button: event.button, pointerId: event.pointerId,
        pointerType: event.pointerType, isPrimary: event.isPrimary,
      };
    }

    function handlePointerDown(event) {
      const button = pressedButtonOf(event);
      if (event._fromSyntheticHandler || button === 0 || !moduleRef.current) return;
      event.stopPropagation(); event.preventDefault();
      // the canvas may have moved without resizing; the controls map pointers by its rect
      controls.handleResize();
      const { x, y } = toLocal(event);
      const id = moduleRef.current.sendMouseEvent(0, button, x, y, modifiersOf(event));
      savePending(id, event);
    }
    function handlePointerMove(event) {
      if (event._fromSyntheticHandler || !moduleRef.current) return;
      event.stopPropagation(); event.preventDefault();
      const { x, y } = toLocal(event);
      const id = moduleRef.current.sendMouseEvent(1, heldButtonOf(event.buttons), x, y, modifiersOf(event));
      savePending(id, event);
    }
    function handlePointerUp(event) {
      const button = pressedButtonOf(event);
      if (event._fromSyntheticHandler || button === 0 || !moduleRef.current) return;
      event.stopPropagation(); event.preventDefault();
      const { x, y } = toLocal(event);
      const id = moduleRef.current.sendMouseEvent(2, button, x, y, modifiersOf(event));
      savePending(id, event);
    }

    function handleWheel(event) {
      if (event._fromSyntheticHandler || !moduleRef.current) return;
      event.stopPropagation(); event.preventDefault();
      const id = moduleRef.current.sendWheelEvent(event.deltaY, modifiersOf(event));
      pendingWheelEvents[id] = {
        deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode,
        clientX: event.clientX, clientY: event.clientY,
      };
    }

    // ── WASM output event listeners ─────────────────────────────────────────

    // Instancing: every mesh/polyline/points output is drawn once per engine
    // instance transformation.
    function addOutput(id, proto) {
      objects[id] = proto;
      groups[id] = new THREE.Group();
      scene.add(groups[id]);
      syncInstances(id);
      return proto;
    }
    // Shared geometries and materials belong to their maps above, not to the
    // outputs showing them.
    function disposeGeometry(geometry) {
      if (geometry && !geometry.userData.shared) geometry.dispose();
    }
    function disposeMaterial(material) {
      if (material && !material.userData.shared) material.dispose();
    }
    function removeOutput(id) {
      const proto = objects[id];
      if (!proto) return;
      scene.remove(groups[id]);
      disposeGeometry(proto.geometry);
      disposeMaterial(proto.material);
      delete objects[id];
      delete groups[id];
      delete instanceMatrices[id];
      delete meshGeometryOf[id];
      delete meshMaterialOf[id];
      delete lineGeometryOf[id];
      delete lineMaterialOf[id];
      effects.invalidate();
    }
    // Mirror the prototype onto one child per instance. Call after anything
    // about the prototype or the instance list changes.
    function syncInstances(id) {
      const proto = objects[id];
      const group = groups[id];
      if (!proto || !group) return;
      // Nothing is drawn until the engine reports instances; an empty list means draw nothing.
      const matrices = instanceMatrices[id] ?? [];
      while (group.children.length > matrices.length) group.remove(group.children[group.children.length - 1]);
      while (group.children.length < matrices.length) {
        const child = proto.isInstancedMesh
          ? new THREE.InstancedMesh(proto.geometry, proto.material, 0)
          : new proto.constructor();
        child.matrixAutoUpdate = false;
        group.add(child);
      }
      group.children.forEach((child, i) => {
        child.geometry = proto.geometry;
        child.material = proto.material;
        child.castShadow = proto.castShadow;
        child.receiveShadow = proto.receiveShadow;
        child.matrix.copy(matrices[i]);
        child.matrixWorldNeedsUpdate = true;
        if (proto.isInstancedMesh) {
          // points: the spheres are instances too, laid out on the prototype
          child.instanceMatrix = proto.instanceMatrix;
          child.count = proto.count;
          child.boundingBox = proto.boundingBox;
          child.boundingSphere = proto.boundingSphere;
        }
        // nothing to draw until the geometry arrives
        child.visible = proto.isInstancedMesh ? proto.count > 0 : proto.geometry.hasAttribute('position');
        syncLayers(child);
      });
      group.visible = proto.visible;
      effects.invalidate();
    }
    function onOutputInstancesChanged(event) {
      const { id, instances } = event.detail;
      const matrices = [];
      for (let i = 0; i + 16 <= instances.length; i += 16) matrices.push(new THREE.Matrix4().fromArray(instances, i));
      instanceMatrices[id] = matrices;
      syncInstances(id);
      refitShadows();
    }
    function onOutputRemoved(event) { removeOutput(event.detail.id); }
    function onOutputVisibilityChanged(event) {
      const proto = objects[event.detail.id];
      if (!proto) return;
      proto.visible = !!event.detail.visible;
      syncInstances(event.detail.id);
    }

    function ensureMesh(id) {
      if (objects[id]) return objects[id];
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), toneMapped(new THREE.MeshStandardNodeMaterial({ color: 0xaaaaaa })));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return addOutput(id, mesh);
    }
    function onMeshOutputAdded(event) { ensureMesh(event.detail.id); }
    // New content for a material id: every output that shows it gets it
    function onMeshMaterialChanged(event) {
      const detail = event.detail;
      const old = meshMaterials[detail.material];
      const shared = { detail, texture: null, releaseTexture: null, variants: {} };
      meshMaterials[detail.material] = shared;
      if (detail.texture) {
        shared.releaseTexture = acquireTexture(detail.texture, (tex) => {
          shared.texture = tex;
          Object.values(shared.variants).forEach(mat => { mat.map = tex; mat.needsUpdate = true; });
        });
      }
      showing(meshMaterialOf, detail.material).forEach(showMeshMaterial);
      if (old) disposeSharedMeshMaterial(old);
    }
    // Calls done with the texture of url once it's loaded, right away when it
    // is. Returns what to call once the texture isn't used anymore.
    function acquireTexture(url, done) {
      let entry = textures.get(url);
      if (!entry) {
        const created = { users: 0, texture: null, waiting: new Set(), release: null };
        textures.set(url, created);
        new THREE.TextureLoader().load(url, (tex) => {
          if (textures.get(url) !== created) { tex.dispose(); return; }
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.colorSpace = THREE.SRGBColorSpace;
          created.texture = tex;
          created.waiting.forEach(waiter => waiter(tex));
          created.waiting.clear();
        });
        entry = created;
      }
      const used = entry;
      clearTimeout(used.release);
      ++used.users;
      const waiter = (tex) => done(tex);
      if (used.texture) done(used.texture);
      else used.waiting.add(waiter);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        used.waiting.delete(waiter);
        if (--used.users === 0) used.release = setTimeout(() => dropTexture(url, used), 2000);
      };
    }
    function dropTexture(url, entry) {
      entry.texture?.dispose();
      textures.delete(url);
    }
    function disposeSharedMeshMaterial(shared) {
      Object.values(shared.variants).forEach(mat => mat.dispose());
      shared.releaseTexture?.();
    }
    function onMeshMaterialRemoved(event) {
      const { material } = event.detail;
      if (meshMaterials[material]) disposeSharedMeshMaterial(meshMaterials[material]);
      delete meshMaterials[material];
    }
    // A shared material is made for geometries with and without per-vertex
    // colors separately, as that is compiled into its shader.
    function sharedMeshMaterial(shared, vertexColors) {
      const key = vertexColors ? 'colored' : 'plain';
      if (!shared.variants[key]) {
        const { color, roughness, metallic, opacity, doubleSided } = shared.detail;
        const mat = highlight(toneMapped(new THREE.MeshStandardNodeMaterial({
          color: new THREE.Color(color[0], color[1], color[2]),
          metalness: metallic, roughness, opacity,
          transparent: opacity < 1.0,
          side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
          // Per-vertex color (when the geometry carries one) multiplies this
          // base color, matching the engine's own shader — see the `*=
          // vertexColor` in editorTemplate/qt/renderer/QmlShaders.cpp.
          vertexColors,
        })), shared.detail);
        mat.userData.shared = true;
        if (shared.texture) mat.map = shared.texture;
        shared.variants[key] = mat;
      }
      return shared.variants[key];
    }
    function showMeshMaterial(id) {
      const shared = meshMaterials[meshMaterialOf[id]];
      if (!shared) return;
      const mesh = ensureMesh(id);
      const mat = sharedMeshMaterial(shared, mesh.geometry.hasAttribute('color'));
      if (mesh.material !== mat) {
        disposeMaterial(mesh.material);
        mesh.material = mat;
      }
      // `castsShadow` is the per-material toggle; every mesh still receives.
      mesh.castShadow = !!shared.detail.castsShadow;
      mesh.receiveShadow = true;
      syncInstances(id);
    }
    function onMeshOutputMaterialChanged(event) {
      const { id, material } = event.detail;
      meshMaterialOf[id] = material;
      showMeshMaterial(id);
    }
    // New content for a geometry id: every output that shows it gets it
    function onMeshGeometryChanged(event) {
      const { geometry: geometryId, vertices, normals, uvs, colors } = event.detail;
      const old = meshGeometries[geometryId];
      const geometry = new THREE.BufferGeometry();
      if (vertices?.length) {
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        if (normals?.length) geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        if (uvs?.length) geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        if (colors?.length) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      }
      geometry.userData.shared = true;
      meshGeometries[geometryId] = geometry;
      showing(meshGeometryOf, geometryId).forEach(showMeshGeometry);
      old?.dispose();
    }
    function onMeshGeometryRemoved(event) {
      const { geometry } = event.detail;
      meshGeometries[geometry]?.dispose();
      delete meshGeometries[geometry];
    }
    function onMeshOutputGeometryChanged(event) {
      const { id, geometry } = event.detail;
      meshGeometryOf[id] = geometry;
      showMeshGeometry(id);
    }
    function showMeshGeometry(id) {
      const mesh = ensureMesh(id);
      const geometry = meshGeometries[meshGeometryOf[id]] ?? new THREE.BufferGeometry();
      const hasColors = geometry.hasAttribute('color');
      disposeGeometry(mesh.geometry);
      mesh.geometry = geometry;
      // A material shown before this geometry (or for a mesh whose geometry
      // previously had no color data) is swapped for the variant that matches.
      if (meshMaterialOf[id] !== undefined) {
        showMeshMaterial(id);
      } else if (mesh.material && mesh.material.vertexColors !== hasColors) {
        mesh.material.vertexColors = hasColors;
        mesh.material.needsUpdate = true;
      }
      syncInstances(id);
      refitShadows(); // keep shadow-camera extents fitted as geometry streams in
    }

    function ensureLine(id) {
      if (objects[id]) return objects[id];
      return addOutput(id, new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicNodeMaterial({ color: 0xaaaaaa })));
    }
    function onPolylineOutputAdded(event) { ensureLine(event.detail.id); }
    function onPolylineMaterialChanged(event) {
      const { material, color, linewidth, opacity } = event.detail;
      const old = lineMaterials[material];
      const mat = highlight(new THREE.LineBasicNodeMaterial({
        color: new THREE.Color(color[0], color[1], color[2]),
        linewidth: linewidth ?? 1, opacity, transparent: opacity < 1.0,
      }), event.detail);
      mat.userData.shared = true;
      lineMaterials[material] = mat;
      showing(lineMaterialOf, material).forEach(showLineMaterial);
      old?.dispose();
    }
    function onPolylineMaterialRemoved(event) {
      const { material } = event.detail;
      lineMaterials[material]?.dispose();
      delete lineMaterials[material];
    }
    function onPolylineGeometryChanged(event) {
      const { geometry: geometryId, segments } = event.detail;
      const old = lineGeometries[geometryId];
      const geometry = new THREE.BufferGeometry();
      if (segments?.length) geometry.setAttribute('position', new THREE.BufferAttribute(segments, 3));
      geometry.userData.shared = true;
      lineGeometries[geometryId] = geometry;
      showing(lineGeometryOf, geometryId).forEach(showLineGeometry);
      old?.dispose();
    }
    function onPolylineGeometryRemoved(event) {
      const { geometry } = event.detail;
      lineGeometries[geometry]?.dispose();
      delete lineGeometries[geometry];
    }
    function onPolylineOutputMaterialChanged(event) {
      const { id, material } = event.detail;
      lineMaterialOf[id] = material;
      showLineMaterial(id);
    }
    function showLineMaterial(id) {
      const line = ensureLine(id);
      const mat = lineMaterials[lineMaterialOf[id]];
      if (!mat || mat === line.material) return;
      disposeMaterial(line.material);
      line.material = mat;
      syncInstances(id);
    }
    function onPolylineOutputGeometryChanged(event) {
      const { id, geometry } = event.detail;
      lineGeometryOf[id] = geometry;
      showLineGeometry(id);
    }
    function showLineGeometry(id) {
      const line = ensureLine(id);
      disposeGeometry(line.geometry);
      line.geometry = lineGeometries[lineGeometryOf[id]] ?? new THREE.BufferGeometry();
      syncInstances(id);
    }

    // Points: spheres with a diameter of the point size, in world units, lit
    // when the material is shaded and in its flat color otherwise
    function ensurePoints(id) {
      if (objects[id]) return objects[id];
      const pts = new THREE.InstancedMesh(POINT_SPHERE, new THREE.MeshBasicNodeMaterial({ color: 0xaaaaaa }), 0);
      pts.userData.points = new Float32Array(0);
      pts.userData.size = 1;
      return addOutput(id, pts);
    }
    // Places a sphere on every point
    function layoutPoints(pts) {
      const { points, size } = pts.userData;
      const count = Math.floor(points.length / 3);
      if (pts.instanceMatrix.count < count) {
        pts.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(count * 16), 16);
      }
      const matrix = new THREE.Matrix4();
      for (let i = 0; i < count; i++) {
        matrix.makeScale(size, size, size).setPosition(points[3 * i], points[3 * i + 1], points[3 * i + 2]);
        pts.setMatrixAt(i, matrix);
      }
      pts.count = count;
      pts.instanceMatrix.needsUpdate = true;
      pts.computeBoundingBox();
      pts.computeBoundingSphere();
    }
    function onPointsOutputAdded(event) { ensurePoints(event.detail.id); }
    function onPointsOutputMaterialChanged(event) {
      const { id, color, pointsize, opacity, shaded } = event.detail;
      const pts = ensurePoints(id);
      disposeMaterial(pts.material);
      const parameters = { color: new THREE.Color(color[0], color[1], color[2]), opacity, transparent: opacity < 1.0 };
      pts.material = shaded
        ? toneMapped(new THREE.MeshStandardNodeMaterial({ ...parameters, roughness: 0.95, metalness: 0.04 }))
        : new THREE.MeshBasicNodeMaterial(parameters);
      pts.userData.size = pointsize ?? 1;
      layoutPoints(pts);
      syncInstances(id);
    }
    function onPointsOutputGeometryChanged(event) {
      const { id, points } = event.detail;
      const pts = ensurePoints(id);
      pts.userData.points = points ?? new Float32Array(0);
      layoutPoints(pts);
      syncInstances(id);
    }

    function onSceneOutputCameraChanged(event) {
      const d = event.detail;
      camera.fov = d.fov;
      if (d.near) requestedNear = d.near;
      if (d.far) requestedFar = d.far;
      camera.position.set(d.position[0], d.position[1], d.position[2]);
      camera.up.set(d.up[0], d.up[1], d.up[2]);
      controls.target.set(d.target[0], d.target[1], d.target[2]);
      camera.updateProjectionMatrix();
      updateDepthRange();
      cameraLocked = !!d.lock;
      controls.enabled = !d.lock;
      controls.update();
      // Report straight back — see the comment on sendCameraToEngine.
      sendCameraToEngine();
    }

    function onUserEventHandled(event) {
      const { id, handled } = event.detail;
      if (Object.prototype.hasOwnProperty.call(pendingEvents, id)) {
        const eventData = pendingEvents[id];
        delete pendingEvents[id];
        if (!handled) {
          const syntheticEvent = new PointerEvent(eventData.type, {
            bubbles: true, cancelable: true,
            clientX: eventData.clientX, clientY: eventData.clientY,
            button: eventData.button, pointerId: eventData.pointerId,
            pointerType: eventData.pointerType || 'mouse',
            isPrimary: eventData.isPrimary ?? true,
            view: window,
          });
          syntheticEvent._fromSyntheticHandler = true;
          renderer.domElement.dispatchEvent(syntheticEvent);
        }
        return;
      }
      if (Object.prototype.hasOwnProperty.call(pendingWheelEvents, id)) {
        const eventData = pendingWheelEvents[id];
        delete pendingWheelEvents[id];
        if (!handled) {
          const syntheticEvent = new WheelEvent('wheel', {
            bubbles: true, cancelable: true, view: window,
            deltaX: eventData.deltaX, deltaY: eventData.deltaY,
            deltaZ: eventData.deltaZ, deltaMode: eventData.deltaMode,
            clientX: eventData.clientX, clientY: eventData.clientY,
          });
          syntheticEvent._fromSyntheticHandler = true;
          renderer.domElement.dispatchEvent(syntheticEvent);
        }
      }
    }

    // Downloadable files (e.g. exported CAD formats) trigger a browser
    // download as soon as their contents are available.
    function onBinaryOutputContentsChanged(event) {
      const { filename, data } = event.detail;
      const url = URL.createObjectURL(new Blob([data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }

    // load() only announces the parameters and outputs; it computes nothing.
    // Run the product as soon as it is loaded, so the viewer sees a result
    // without pressing anything. That first run is also what fills in the
    // names, descriptions and external IDs (they arrive in …Changed events).
    //
    // Deferred: productLoaded fires while the engine still reports the Setup
    // status, in which it silently drops every command it gets. It leaves that
    // status right after this event's listeners have returned.
    function runProduct() {
      setTimeout(() => moduleRef.current?.execute());
    }

    // Reset the scene when a fresh load happens.
    function clearScene() {
      Object.keys(objects).forEach(removeOutput);
      Object.keys(instanceMatrices).forEach(k => delete instanceMatrices[k]);
      if (controls) controls.enabled = true;
      cameraLocked = false;
      rebuildLighting(null); // back to the default camera light
      resetSceneOutput();
    }

    const wasmListeners = [
      ['meshOutputAdded', onMeshOutputAdded],
      ['meshOutputRemoved', onOutputRemoved],
      ['meshOutputChanged', onOutputVisibilityChanged],
      ['meshOutputInstancesChanged', onOutputInstancesChanged],
      ['meshOutputMaterialChanged', onMeshOutputMaterialChanged],
      ['meshOutputGeometryChanged', onMeshOutputGeometryChanged],
      ['meshGeometryChanged', onMeshGeometryChanged],
      ['meshGeometryRemoved', onMeshGeometryRemoved],
      ['meshMaterialChanged', onMeshMaterialChanged],
      ['meshMaterialRemoved', onMeshMaterialRemoved],
      ['polylineOutputAdded', onPolylineOutputAdded],
      ['polylineOutputRemoved', onOutputRemoved],
      ['polylineOutputChanged', onOutputVisibilityChanged],
      ['polylineOutputInstancesChanged', onOutputInstancesChanged],
      ['polylineOutputMaterialChanged', onPolylineOutputMaterialChanged],
      ['polylineOutputGeometryChanged', onPolylineOutputGeometryChanged],
      ['polylineGeometryChanged', onPolylineGeometryChanged],
      ['polylineGeometryRemoved', onPolylineGeometryRemoved],
      ['polylineMaterialChanged', onPolylineMaterialChanged],
      ['polylineMaterialRemoved', onPolylineMaterialRemoved],
      ['pointsOutputAdded', onPointsOutputAdded],
      ['pointsOutputRemoved', onOutputRemoved],
      ['pointsOutputChanged', onOutputVisibilityChanged],
      ['pointsOutputInstancesChanged', onOutputInstancesChanged],
      ['pointsOutputMaterialChanged', onPointsOutputMaterialChanged],
      ['pointsOutputGeometryChanged', onPointsOutputGeometryChanged],
      ['sceneOutputCameraChanged', onSceneOutputCameraChanged],
      ['sceneOutputLightingChanged', onSceneOutputLightingChanged],
      ['sceneOutputRemoved', onSceneOutputRemoved],
      ['sceneOutputChanged', onSceneOutputChanged],
      ['userEventHandled', onUserEventHandled],
      ['binaryOutputContentsChanged', onBinaryOutputContentsChanged],
      // Clear when a load starts, not on productLoaded: that fires after
      // the load already announced every output (and the scene lighting).
      ['loadingStarted', clearScene],
      ['productLoaded', runProduct],
    ];

    // ── Init ───────────────────────────────────────────────────────────────

    initThree();
    fitToSceneRef.current = fitToScene;

    const container = mountRef.current;
    resizeObserver.observe(container);

    renderer.domElement.addEventListener('pointerdown', handlePointerDown, true);
    renderer.domElement.addEventListener('pointermove', handlePointerMove, true);
    renderer.domElement.addEventListener('pointerup', handlePointerUp, true);
    renderer.domElement.addEventListener('wheel', handleWheel, { capture: true, passive: false });

    wasmListeners.forEach(([evt, fn]) => document.addEventListener(evt, fn));

    LoadWasm()
      .then((mod) => {
        moduleRef.current = mod;
        onModuleReady(mod);
        mod.load(); // runProduct() executes it once productLoaded arrives
      })
      .catch((err) => {
        console.error('[unsung] Failed to load WASM:', err);
        onLoadError?.(err);
      });

    return () => {
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown, true);
      renderer.domElement.removeEventListener('pointermove', handlePointerMove, true);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp, true);
      renderer.domElement.removeEventListener('wheel', handleWheel, true);
      controls.removeEventListener('change', sendCameraToEngine);
      controls.dispose();
      wasmListeners.forEach(([evt, fn]) => document.removeEventListener(evt, fn));
      disposeLightRig();
      if (cameraLight) { camera.remove(cameraLight); cameraLight.dispose(); }
      environmentMap?.dispose();
      effects.dispose();
      renderer.dispose();
      // a remount (e.g. under StrictMode) would otherwise leave this canvas,
      // blank, on top of the new one
      renderer.domElement.remove();
      Object.values(objects).forEach(obj => {
        disposeGeometry(obj.geometry);
        disposeMaterial(obj.material);
      });
      [...Object.values(meshGeometries), ...Object.values(lineGeometries)].forEach(geometry => geometry.dispose());
      Object.values(lineMaterials).forEach(material => material.dispose());
      Object.values(meshMaterials).forEach(disposeSharedMeshMaterial);
      textures.forEach((entry, url) => { clearTimeout(entry.release); dropTexture(url, entry); });
    };
  }, []); // run once on mount

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      <button
        onClick={() => fitToSceneRef.current?.()}
        title="Fit entire scene into view"
        style={{
          position: 'absolute', top: 12, left: 12,
          padding: '6px 10px', background: 'rgba(255,255,255,0.88)',
          border: '1px solid rgba(0,0,0,0.18)', borderRadius: 5,
          cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', color: '#222',
          boxShadow: '0 1px 4px rgba(0,0,0,0.12)', userSelect: 'none',
        }}
      >
        ⛶ Fit to scene
      </button>
      {showFrameRate && (
        <div
          ref={frameRateRef}
          style={{
            position: 'absolute', top: 12, right: 12,
            padding: '5px 9px', background: 'rgba(255,255,255,0.88)',
            border: '1px solid rgba(0,0,0,0.18)', borderRadius: 5,
            fontSize: 12, fontFamily: 'monospace', color: '#222',
            boxShadow: '0 1px 4px rgba(0,0,0,0.12)', userSelect: 'none', pointerEvents: 'none',
          }}
        >
          – fps
        </div>
      )}
    </div>
  );
};

export default ThreeCanvas;
