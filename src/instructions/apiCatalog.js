/**
 * Static reference for the unsung.js client API: every kind of parameter /
 * output the engine can announce, the CustomEvents it dispatches on
 * `document` for it, what each key of their `event.detail` means, and how to
 * drive it from JavaScript.
 *
 * useApiInstructions.js combines this with the parameters/outputs the loaded
 * product actually announces, so the instructions modal only lists what this
 * product uses, with its real IDs filled in.
 *
 * Source of truth: the EM_ASM blocks and EMSCRIPTEN_BINDINGS(unsungRunner) in
 * webClient/WebClient.cpp of the engine. Keep this file in sync with it.
 *
 * Note on booleans: the engine passes C++ bools through EM_ASM, so boolean
 * detail fields arrive as the numbers 0/1. Convert them with `!!value`.
 *
 * Note on metadata: name, description, externalID, visible and editable can
 * be driven by the product itself, so the engine only knows them once the
 * product has run. …Added events announce the item before that first run;
 * the run then sends a …Changed event with the real values.
 */

// ── Shared field descriptions ────────────────────────────────────────────────

const AFTER_RUN = 'Only known after the product has run: until then the …Added event carries a placeholder, and the first run sends a …Changed event with the real value.';

const F = {
  id: 'Unique ID of this parameter/output inside the product. Pass it to the module\'s set…/invoke… functions and use it to correlate Added/Changed/Removed events.',
  name: `Display name set in the editor. May be empty; fall back to \`id\` for labels. ${AFTER_RUN}`,
  description: `Free-text description set in the editor (e.g. for tooltips). May be empty. ${AFTER_RUN}`,
  externalID: `Optional ID you choose in the editor to map this item onto your own system (SKU, form field, database column…). Empty when not set. The engine itself never uses it. ${AFTER_RUN}`,
  visible: `Whether the product wants this item shown (0/1). Hide the control or geometry when 0. ${AFTER_RUN}`,
  editable: `Whether the user may change the value (0/1). Render the control read-only/disabled when 0. ${AFTER_RUN}`,
};

const parameterFields = (valueDoc, defaultDoc, extra = {}) => ({
  id: F.id,
  name: F.name,
  description: F.description,
  externalID: F.externalID,
  value: valueDoc,
  defaultValue: defaultDoc,
  editable: F.editable,
  visible: F.visible,
  ...extra,
});

const outputHeaderFields = (extra = {}) => ({
  id: F.id,
  name: F.name,
  description: F.description,
  externalID: F.externalID,
  visible: F.visible,
  ...extra,
});

const removedFields = { id: 'ID of the parameter/output that no longer exists. Drop any UI/geometry you keep for it.' };

const COLOR3 = '[r, g, b], each channel a number in 0..1.';
// Instancing: mesh, polyline and points outputs are drawn once per instance.
const instancesEvent = (prefix, what) => ({
  name: `${prefix}InstancesChanged`,
  when: 'With every Changed event. Always the complete current list, not a diff.',
  fields: {
    id: F.id,
    instances: `Float32Array, 16 floats per instance: a column-major 4x4 matrix (THREE.Matrix4().fromArray(instances, 16 * i)). Draw the ${what} once per instance, transformed by that matrix. Empty means draw nothing.`,
  },
});

// Standard Added/Changed/Removed triple. Added and Changed carry the full
// current state (Changed is not a diff), so one handler can serve both.
function lifecycle(prefix, fields, addedNote, changedNote) {
  return [
    { name: `${prefix}Added`, when: addedNote ?? 'Once when the product is loaded (or the item first appears). Name, description, externalID and visibility are filled in by the first run, which sends a …Changed event; handle both with the same code.', fields },
    { name: `${prefix}Changed`, when: changedNote ?? 'Whenever any field changes. Carries the complete current state, not just the changed keys.', fields, sameAs: `${prefix}Added` },
    { name: `${prefix}Removed`, when: 'When the item disappears (e.g. on reload).', fields: removedFields },
  ];
}

// ── Kinds ────────────────────────────────────────────────────────────────────
//
// Each kind:
//   label      — human-readable title
//   group      — 'parameter' | 'output'
//   addedEvent — event that announces a new instance (used to discover them)
//   summary    — one-paragraph explanation
//   usage(id, detail) — JS snippet showing how to drive / consume it for that
//                id; detail is its latest Added/Changed payload (may be undefined)
//   events     — [{ name, when, fields: { key: explanation }, sameAs? }]
//                sameAs names an event with identical detail keys, so the
//                modal can refer to it instead of repeating the table.

export const KINDS = {
  booleanParameter: {
    label: 'Boolean parameter',
    group: 'parameter',
    summary: 'An on/off input, typically rendered as a checkbox or toggle.',
    usage: (id) => `Module.setBooleanParameterValue(${q(id)}, true);`,
    events: lifecycle('booleanParameter', parameterFields(
      'Current value, 0 (false) or 1 (true).',
      'Value the product starts with, 0 or 1.',
    )),
  },

  integerParameter: {
    label: 'Integer parameter',
    group: 'parameter',
    summary: 'A whole-number input within [minimum, maximum].',
    usage: (id) => `Module.setIntegerParameterValue(${q(id)}, 3); // whole number, clamp to [minimum, maximum]`,
    events: lifecycle('integerParameter', parameterFields(
      'Current value (integer).',
      'Value the product starts with.',
      {
        unit: 'Unit label to show next to the value (e.g. "mm"). May be empty.',
        minimum: 'Lowest allowed value.',
        maximum: 'Highest allowed value.',
      },
    )),
  },

  numberParameter: {
    label: 'Number parameter',
    group: 'parameter',
    summary: 'A floating-point input within [minimum, maximum].',
    usage: (id) => `Module.setNumberParameterValue(${q(id)}, 12.5); // clamp to [minimum, maximum]`,
    events: lifecycle('numberParameter', parameterFields(
      'Current value (float).',
      'Value the product starts with.',
      {
        unit: 'Unit label to show next to the value (e.g. "mm"). May be empty.',
        minimum: 'Lowest allowed value.',
        maximum: 'Highest allowed value.',
        presentation: 'Suggested control: 0 = text field, 1 = slider, 2 = custom (your own UI).',
      },
    )),
  },

  stringParameter: {
    label: 'String parameter',
    group: 'parameter',
    summary: 'A free-text input.',
    usage: (id) => `Module.setStringParameterValue(${q(id)}, 'Hello');`,
    events: lifecycle('stringParameter', parameterFields(
      'Current text.',
      'Text the product starts with.',
    )),
  },

  enumParameter: {
    label: 'Enum parameter',
    group: 'parameter',
    summary: 'A choice from a fixed list of options, shown as a dropdown or as tiles, with labels and/or images.',
    usage: (id, detail) => {
      const first = (detail?.options ?? '').split(',').map(s => s.trim()).find(Boolean) ?? 'option';
      return `Module.setEnumParameterValue(${q(id)}, ${q(first)}); // one of: ${detail?.options ?? 'detail.options'}`;
    },
    events: lifecycle('enumParameter', parameterFields(
      'Currently selected option.',
      'Option the product starts with.',
      {
        options: 'All allowed options as ONE comma-separated string, e.g. "small,medium,large". Split it: `detail.options.split(\',\')`.',
        images: 'Array with the image of each option, in the order of `options`: a URI string, "" for an option without one. "resources/<name>" is a file shipped in public/resources (resolve it against the page); a "data:<ext>;base64,…" URL carries the bare file extension where a MIME type belongs (use "image/<ext>", "image/svg+xml" for svg).',
        parameterPresentation: 'Suggested control: "dropdown" or "tiles" (a grid of buttons).',
        optionPresentation: 'What an option shows: "label", "icon" (its image) or "both". Show the label of an option without an image.',
      },
    )),
  },

  colorParameter: {
    label: 'Color parameter',
    group: 'parameter',
    summary: 'An RGB color input.',
    usage: (id) => `Module.setColorParameterValue(${q(id)}, 1.0, 0.5, 0.0); // r, g, b in 0..1`,
    events: lifecycle('colorParameter', parameterFields(
      `Current color, ${COLOR3}`,
      `Color the product starts with, ${COLOR3}`,
    )),
  },

  uriParameter: {
    label: 'File / URI parameter',
    group: 'parameter',
    summary: 'A file input. Pass the file contents as a data: URI, or a URL / relative path (e.g. "resources/foo.png") the browser can fetch.',
    usage: (id) => [
      `// e.g. from an <input type="file">`,
      `const reader = new FileReader();`,
      `reader.onload = () => Module.setURIParameterValue(${q(id)}, reader.result); // data: URI`,
      `reader.readAsDataURL(file);`,
    ].join('\n'),
    events: lifecycle('uriParameter', parameterFields(
      'Current URI as a string (data: URI, URL or relative path). Empty when no file is set.',
      'URI the product starts with.',
    )),
  },

  triggerParameter: {
    label: 'Trigger parameter',
    group: 'parameter',
    summary: 'A button that has no value: invoking it fires an action in the product.',
    usage: (id) => `Module.invokeTriggerParameter(${q(id)});`,
    events: lifecycle('triggerParameter', {
      id: F.id,
      name: F.name,
      description: F.description,
      externalID: F.externalID,
      editable: 'Whether the button may be pressed (0/1). Disable it when 0.',
      visible: F.visible,
    }),
  },

  meshOutput: {
    label: 'Mesh output',
    group: 'output',
    summary: '3D triangle geometry. Header events (Added/Changed) say the mesh exists. Material, geometry and instances arrive in separate events, which can come in either order. Geometries and materials are sent separately, by meshGeometryChanged and meshMaterialChanged (see the general events), each with an id, and can be shared by several mesh outputs: meshOutputGeometryChanged and meshOutputMaterialChanged only say which id this output shows. New content for an id concerns every output that shows it.',
    usage: () => [
      `// three.js: one THREE.BufferGeometry per geometry id, shared by every output showing it`,
      `document.addEventListener('meshGeometryChanged', ({ detail }) => {`,
      `  const old = geometries[detail.geometry];`,
      `  const geometry = new THREE.BufferGeometry();`,
      `  geometry.setAttribute('position', new THREE.BufferAttribute(detail.vertices, 3));`,
      `  if (detail.normals.length) geometry.setAttribute('normal', new THREE.BufferAttribute(detail.normals, 3));`,
      `  geometries[detail.geometry] = geometry;`,
      `  // new content for an id: every mesh showing it gets it`,
      `  for (const id in geometryOf) if (geometryOf[id] === detail.geometry) meshes[id].geometry = geometry;`,
      `  old?.dispose();`,
      `});`,
      `document.addEventListener('meshOutputGeometryChanged', ({ detail }) => {`,
      `  geometryOf[detail.id] = detail.geometry;`,
      `  meshes[detail.id].geometry = geometries[detail.geometry]; // don't dispose the old one here`,
      `});`,
      `// materials likewise: one THREE.MeshStandardMaterial per material id (and per vertexColors setting)`,
      `document.addEventListener('meshOutputMaterialChanged', ({ detail }) => {`,
      `  meshes[detail.id].material = materials[detail.material];`,
      `});`,
    ].join('\n'),
    events: [
      ...lifecycle('meshOutput', outputHeaderFields()),
      {
        name: 'meshOutputMaterialChanged',
        when: 'After Added and whenever the output shows another material. Always preceded by the meshMaterialChanged of that material.',
        fields: {
          id: F.id,
          material: 'Id (a number) of the material from meshMaterialChanged that this output shows. Its content can change later, by another meshMaterialChanged with this id.',
        },
      },
      {
        name: 'meshOutputGeometryChanged',
        when: 'After Added and whenever the output shows another geometry. Always preceded by the meshGeometryChanged of that geometry.',
        fields: {
          id: F.id,
          geometry: 'Id (a number) of the geometry from meshGeometryChanged that this output shows. Its content can change later, by another meshGeometryChanged with this id.',
        },
      },
      instancesEvent('meshOutput', 'mesh'),
    ],
  },

  polylineOutput: {
    label: 'Polyline output',
    group: 'output',
    summary: '3D line segments. Like mesh outputs, geometries and materials are sent separately, by polylineGeometryChanged and polylineMaterialChanged (see the general events), each with an id, and several polyline outputs can show the same id. New content for an id concerns every output that shows it.',
    usage: () => `new THREE.LineSegments(geometries[detail.geometry], materials[detail.material]) // shared, don't dispose per output`,
    events: [
      ...lifecycle('polylineOutput', outputHeaderFields()),
      {
        name: 'polylineOutputMaterialChanged',
        when: 'After Added and whenever the output shows another material. Always preceded by the polylineMaterialChanged of that material.',
        fields: {
          id: F.id,
          material: 'Id (a number) of the material from polylineMaterialChanged that this output shows. Its content can change later.',
        },
      },
      {
        name: 'polylineOutputGeometryChanged',
        when: 'After Added and whenever the output shows another geometry. Always preceded by the polylineGeometryChanged of that geometry.',
        fields: {
          id: F.id,
          geometry: 'Id (a number) of the geometry from polylineGeometryChanged that this output shows. Its content can change later.',
        },
      },
      instancesEvent('polylineOutput', 'polyline'),
    ],
  },

  pointsOutput: {
    label: 'Points output',
    group: 'output',
    summary: 'A 3D point cloud, drawn as spheres.',
    usage: () => [
      `// one sphere per point, pointsize being its diameter`,
      `const spheres = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5), material, points.length / 3);`,
      `for (let i = 0; i < spheres.count; i++) {`,
      `  spheres.setMatrixAt(i, new THREE.Matrix4().makeScale(size, size, size).setPosition(points[3 * i], points[3 * i + 1], points[3 * i + 2]));`,
      `}`,
    ].join('\n'),
    events: [
      ...lifecycle('pointsOutput', outputHeaderFields()),
      {
        name: 'pointsOutputMaterialChanged',
        when: 'After Added and whenever the material changes.',
        fields: {
          id: F.id,
          color: `Point color, ${COLOR3}`,
          pointsize: 'Diameter of the sphere drawn at every point, in world units.',
          opacity: '0 .. 1.',
          shaded: 'Whether the spheres should be lit/shaded (0/1) rather than drawn in their flat color.',
        },
      },
      {
        name: 'pointsOutputGeometryChanged',
        when: 'After Added and whenever the geometry is recomputed.',
        fields: {
          id: F.id,
          points: 'Float32Array of positions, 3 floats (x, y, z) per point.',
        },
      },
      instancesEvent('pointsOutput', 'point cloud'),
    ],
  },

  sceneOutput: {
    label: 'Scene output (camera, lighting & background)',
    group: 'output',
    summary: 'Tells the viewer how to set up the camera, lights, background and contact shadow. Report user camera moves back with Module.sendCameraChange(...) so the product can react to them.',
    usage: () => [
      `// after the user orbits the camera:`,
      `Module.sendCameraChange(pos.x, pos.y, pos.z, target.x, target.y, target.z,`,
      `                        up.x, up.y, up.z, near, far, fov, locked ? 1 : 0);`,
    ].join('\n'),
    events: [
      ...lifecycle('sceneOutput', {
        id: F.id, name: F.name, description: F.description, externalID: F.externalID,
        showFrameRate: 'Whether the viewer should show a frame rate counter (0/1).',
        background: `{ mode: 'none' }: a transparent background, so the page behind the viewer shows; { mode: 'color', color: [r, g, b] }, ${COLOR3}; or { mode: 'environment', blur, intensity }: the lighting's environment map (see sceneOutputLightingChanged), blurred as if reflected by a surface of roughness blur (0..1, like three.js' scene.backgroundBlurriness) and scaled by intensity (like scene.backgroundIntensity), then tone mapped. Without an environment map it is transparent.`,
        contactShadow: '{ enabled, orientation }: when enabled (0/1), a soft shadow under the objects on a ground plane, like three.js\' webgl_shadow_contact example. orientation is a Float32Array of 16 floats, a column-major 4x4 matrix whose z = 0 plane is the ground (identity: the XY plane); only its rotation and translation count. Geometry lying in the plane, or below it, casts no shadow, and neither do lines and points.',
        toneMapping: "'none', 'neutral', 'aces' or 'agx': how lit surfaces and the environment background are mapped to displayable colors, like three.js' NoToneMapping, NeutralToneMapping, ACESFilmicToneMapping and AgXToneMapping. Only lit (MeshStandardMaterial) surfaces and the environment background are tone mapped: unlit materials, lines, the background color and outlines keep their exact colors. Missing (older engines): 'none'.",
        exposure: 'Multiplies the light of lit surfaces and the environment background before the tone mapping, also with \'none\' (like three.js\' toneMappingExposure, which three only applies with a tone mapping). Missing: 1.',
      }),
      {
        name: 'sceneOutputCameraChanged',
        when: 'After Added and whenever the product sets a camera.',
        fields: {
          id: F.id,
          position: '[x, y, z] camera eye position.',
          target: '[x, y, z] point the camera looks at (orbit center).',
          up: '[x, y, z] camera up vector.',
          fov: 'Vertical field of view in degrees.',
          near: 'Near clipping distance.',
          far: 'Far clipping distance.',
          lock: 'When 1, the user must not move the camera (disable orbit controls).',
        },
      },
      {
        name: 'sceneOutputLightingChanged',
        when: 'After Added and whenever the lighting setup changes. If received, it replaces your default lighting entirely.',
        fields: {
          id: F.id,
          cameraLight: 'Whether to attach a point light to the camera (0/1).',
          cameraLightColor: `Camera light color, ${COLOR3}`,
          ambientLightColor: `Ambient light color, ${COLOR3} [0, 0, 0] means no ambient light.`,
          bounds: '{} or { min: [x,y,z], max: [x,y,z] }: the region shadows should cover. When empty, use the scene\'s own bounding box.',
          directionalLights: 'Array of { direction: [x,y,z], color: [r,g,b], enabled, castsShadow }.',
          pointLights: 'Array of { position: [x,y,z], color: [r,g,b], enabled, castsShadow }.',
          environment: "null, or { map, format, intensity, rotation }: image based lighting from an equirectangular HDR image. map is its URL (possibly a data: URL), format 'hdr' or 'exr' (load it with three.js' HDRLoader or EXRLoader, mapping EquirectangularReflectionMapping, and set it as scene.environment). intensity scales its light (scene.environmentIntensity). The image's top row is the world's +Z and its center lies in the +X direction, turned around +Z by rotation degrees: set scene.environmentRotation from makeRotationZ(rotation) * makeRotationX(90°). While there is one, ignore ambientLightColor.",
        },
      },
    ],
  },

  numberOutput: {
    label: 'Number output',
    group: 'output',
    summary: 'A computed number to display (price, weight, area…).',
    usage: () => `label.textContent = \`\${detail.value} \${detail.unit}\`;`,
    events: lifecycle('numberOutput', outputHeaderFields({
      unit: 'Unit label (e.g. "kg"). May be empty.',
      value: 'Current computed value (float).',
    })),
  },

  stringOutput: {
    label: 'String output',
    group: 'output',
    summary: 'A computed text to display.',
    usage: () => `label.textContent = detail.value;`,
    events: lifecycle('stringOutput', outputHeaderFields({
      value: 'Current computed text.',
    })),
  },

  imageOutput: {
    label: 'Image output',
    group: 'output',
    summary: 'A computed 2D image (e.g. a drawing or preview).',
    usage: () => `img.src = detail.contents; // from imageOutputContentsChanged`,
    events: [
      ...lifecycle('imageOutput', outputHeaderFields()),
      {
        name: 'imageOutputContentsChanged',
        when: 'After Added and whenever the image is recomputed.',
        fields: {
          id: F.id,
          contents: 'The image as a data: URI (PNG), ready for an <img src>.',
        },
      },
    ],
  },

  binaryOutput: {
    label: 'Downloadable file output',
    group: 'output',
    summary: 'A computed file (e.g. STL, DXF, PDF) delivered when the product produces it, typically after a trigger. The demo starts a browser download automatically.',
    usage: () => [
      `const url = URL.createObjectURL(new Blob([detail.data]));`,
      `const a = document.createElement('a'); a.href = url; a.download = detail.filename; a.click();`,
      `URL.revokeObjectURL(url);`,
    ].join('\n'),
    events: [
      ...lifecycle('binaryOutput', {
        id: F.id, name: F.name, description: F.description, externalID: F.externalID,
        format: 'File format of the produced file, as its extension (e.g. "stl", "csv").',
      }),
      {
        name: 'binaryOutputContentsChanged',
        when: 'Whenever the product produces the file.',
        fields: {
          id: F.id,
          filename: 'Suggested file name for the download, including the format as extension.',
          format: 'File format of the data, as its extension (e.g. "stl", "csv").',
          data: 'Uint8Array with the raw file bytes (a copy, so it is safe to keep).',
        },
      },
    ],
  },
};

for (const [key, kind] of Object.entries(KINDS)) {
  kind.key = key;
  kind.addedEvent = `${key}Added`;
}

// ── Module-wide API (always present, regardless of product) ────────────────

export const GENERAL_FUNCTIONS = [
  { sig: 'load()', doc: 'Loads the product compiled into unsung.wasm. Call once, when the runtime is ready (Module.onRuntimeInitialized). Fires loadingStarted, then an …Added event for every parameter and output, then productLoaded. load() computes nothing: call execute() after productLoaded, deferred with setTimeout because commands sent from within that event are ignored. That first run also fills in the names, descriptions, external IDs and visibility of the parameters and outputs (as …Changed events).' },
  { sig: 'execute()', doc: 'Recomputes the product. Parameter setters already re-execute automatically; use this after resultsInvalidatedChanged reports invalidated = 1.' },
  { sig: 'cancelExecution()', doc: 'Cancels a running computation.' },
  { sig: 'saveConfiguration(filename)', doc: 'Serializes all current parameter values. The result arrives as a savedConfiguration event.' },
  { sig: 'loadConfiguration(contents)', doc: 'Restores parameter values from a string produced by saveConfiguration, then re-executes.' },
  { sig: 'sendMouseEvent(gesture, button, x, y, modifiers) → requestId', doc: 'Forwards a pointer event on the 3D view to the product. gesture: 0 press, 1 move, 2 release. button: 0 none, 1 left, 2 middle, 3 right. x/y in canvas pixels. modifiers: bit flags 1 Ctrl, 2 Alt, 4 Shift. The answer comes back as userEventHandled with the same id.' },
  { sig: 'sendWheelEvent(delta, modifiers) → requestId', doc: 'Forwards a mouse-wheel event. Answered by userEventHandled.' },
  { sig: 'sendCameraChange(px, py, pz, tx, ty, tz, ux, uy, uz, near, far, fov, lock)', doc: 'Reports the viewer\'s current camera (position, target, up, clipping, vertical fov in degrees, lock 0/1) to the product.' },
  { sig: 'sendDimensionsChange(width, height)', doc: 'Reports the 3D view size in pixels. Call on start-up and whenever the canvas resizes.' },
];

export const GENERAL_EVENTS = [
  { name: 'loadingStarted', when: 'At the start of load(). Clear any state from a previous load.', fields: {
    graph: '{ id, name } of the product\'s root graph.', nodes: 'Internal node list (editor use).', types: 'Internal type table (editor use).', assetFormats: 'File formats the product can read.',
  } },
  { name: 'meshGeometryChanged', when: 'The content of a mesh geometry id: before the first meshOutputGeometryChanged that refers to it, and again whenever it changes. Mesh outputs that show the same geometry (e.g. identical assembly parts) refer to one id, so keep one copy per id, and replace it for every output that shows the id when it changes.', fields: {
    geometry: 'Id (a number) of this geometry. Replace what you have for this id.',
    vertices: 'Float32Array of positions, 3 floats (x, y, z) per vertex. Non-indexed: every 3 consecutive vertices form one triangle.',
    normals: 'Float32Array of per-vertex normals, 3 floats per vertex (same count as vertices). May be empty.',
    uvs: 'Float32Array of texture coordinates, 2 floats (u, v) per vertex. May be empty.',
    colors: 'Float32Array of per-vertex colors, 3 floats (r, g, b in 0..1) per vertex, multiplied with the material color. May be empty.',
  } },
  { name: 'meshGeometryRemoved', when: 'When no mesh output shows the geometry anymore. Free it (e.g. geometry.dispose()).', fields: {
    geometry: 'Id of the geometry from meshGeometryChanged.',
  } },
  { name: 'meshMaterialChanged', when: 'The content of a mesh material id: before the first meshOutputMaterialChanged that refers to it, and again whenever it changes. Mesh outputs that show the same material refer to one id, so keep one copy per id (with its texture), and replace it for every output that shows the id when it changes.', fields: {
    material: 'Id (a number) of this material. Replace what you have for this id.',
    color: `Base color, ${COLOR3}`,
    roughness: 'PBR roughness, 0 (mirror) .. 1 (matte).',
    metallic: 'PBR metalness, 0 .. 1.',
    opacity: '0 (invisible) .. 1 (opaque). Enable blending when < 1.',
    doubleSided: 'Render back faces too (0/1).',
    texture: 'Texture image as a data: URI, or empty string when untextured. Map it with the geometry\'s `uvs`.',
    castsShadow: 'Whether meshes with this material should cast shadows (0/1).',
    glow: 'Whether to highlight meshes with this material with a glow in its color (0/1), e.g. selective bloom.',
    outline: 'Whether to highlight meshes with this material with an outline (0/1), around their silhouette and also where other objects hide them.',
    outlineColor: `Color of the outline, ${COLOR3}`,
    outlineThickness: 'Thickness of the outline in CSS pixels, 0 .. 32.',
  } },
  { name: 'meshMaterialRemoved', when: 'When no mesh output shows the material anymore. Free it and its texture.', fields: {
    material: 'Id of the material from meshMaterialChanged.',
  } },
  { name: 'polylineGeometryChanged', when: 'The content of a polyline geometry id: before the first polylineOutputGeometryChanged that refers to it, and again whenever it changes. Keep one copy per id, and replace it for every output that shows the id when it changes.', fields: {
    geometry: 'Id (a number) of this geometry. Replace what you have for this id.',
    segments: 'Float32Array of independent segments: 6 floats per segment (x0, y0, z0, x1, y1, z1), the same layout as THREE.LineSegments.',
  } },
  { name: 'polylineGeometryRemoved', when: 'When no polyline output shows the geometry anymore. Free it.', fields: {
    geometry: 'Id of the geometry from polylineGeometryChanged.',
  } },
  { name: 'polylineMaterialChanged', when: 'The content of a polyline material id: before the first polylineOutputMaterialChanged that refers to it, and again whenever it changes. Keep one copy per id, and replace it for every output that shows the id when it changes.', fields: {
    material: 'Id (a number) of this material. Replace what you have for this id.',
    color: `Line color, ${COLOR3}`,
    linewidth: 'Requested line width in pixels (WebGPU and most WebGL implementations only draw 1px lines).',
    opacity: '0 .. 1.',
    glow: 'Whether to highlight lines with this material with a glow in its color (0/1).',
    outline: 'Whether to highlight lines with this material with an outline (0/1), also where other objects hide them.',
    outlineColor: `Color of the outline, ${COLOR3}`,
    outlineThickness: 'Thickness of the outline in CSS pixels, 0 .. 32.',
  } },
  { name: 'polylineMaterialRemoved', when: 'When no polyline output shows the material anymore. Free it.', fields: {
    material: 'Id of the material from polylineMaterialChanged.',
  } },
  { name: 'productLoaded', when: 'After load() has announced all parameters and outputs. Compute the product and receive the metadata of its parameters and outputs with setTimeout(() => Module.execute()): commands sent from within this event are ignored, because the engine leaves its Setup status only after it.', fields: {} },
  { name: 'statusChanged', when: 'Whenever the engine state changes.', fields: {
    status: 'One of "Setup", "Idle", "HandlingUserInput", "CancelingExecution", "Unknown". Show a busy indicator for anything other than "Idle".',
  } },
  { name: 'executingChanged', when: 'When a computation starts or finishes.', fields: { executing: 'true while computing, false when done (a real boolean here).' } },
  { name: 'resultsInvalidatedChanged', when: 'When the shown results go stale or become current again.', fields: {
    invalidated: '1 when the results no longer match the inputs and execute() is needed, 0 when they are current again.',
  } },
  { name: 'pendingChangesChanged', when: 'When queued parameter changes appear or are processed.', fields: { pendingChanges: '1 while changes are waiting to be applied.' } },
  { name: 'userEventHandled', when: 'In reply to sendMouseEvent / sendWheelEvent.', fields: {
    id: 'The requestId returned by the send… call.',
    handled: '1 if a node in the product consumed the event. If 0, apply your own default behaviour (e.g. orbit the camera).',
  } },
  { name: 'savedConfiguration', when: 'In reply to saveConfiguration(filename).', fields: {
    contents: 'Serialized parameter values (text). Store it, or pass it to loadConfiguration later.',
    filename: 'The filename passed to saveConfiguration.',
  } },
];

function q(id) {
  return `'${String(id).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
