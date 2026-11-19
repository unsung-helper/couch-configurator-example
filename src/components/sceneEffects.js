import * as THREE from 'three/webgpu'
import {
  Fn, If, Loop, acesFilmicToneMapping, agxToneMapping, clamp, color, depth, equirectUV, float,
  getViewPosition, materialColor, max, mrt, neutralToneMapping, output, pass, pmremTexture, rtt,
  screenUV, select, sqrt, texture, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl'
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js'

// What the viewer draws besides the outputs themselves, on top of WebGPU's
// render pipeline: the product's background, a soft contact shadow on a ground
// plane, and highlights — glow and outlines — of the meshes and polylines whose
// material asks for them. Used by ThreeCanvas.jsx.

// Objects in these layers (besides the default one) are outlined or cast the
// contact shadow, see syncLayers
const OUTLINE_LAYER = 1
const CONTACT_SHADOW_LAYER = 2

// glow
const GLOW_STRENGTH = 0.8
const GLOW_RADIUS = 0.1
const GLOW_CUTOFF = 0.02
// outline thickness, in CSS pixels: the engine's default and the most there is
const OUTLINE_THICKNESS = 2
const MAX_OUTLINE_THICKNESS = 32
// contact shadow
const SHADOW_RESOLUTION = 512
const SHADOW_DARKNESS = 1.0
const SHADOW_OPACITY = 0.7
// blur radius, in shadow texels
const SHADOW_BLUR = 3.5
// margin around the covered region, so the blur doesn't get cut off, relative to its size
const SHADOW_PADDING = 0.15
// geometry up to this height above the plane, relative to the covered region's
// diagonal, counts as lying in the plane and casts no shadow
const SHADOW_EXCLUDED_HEIGHT = 1e-3
// how high above the plane geometry still casts a shadow, relative to the
// covered region's largest side: the shadow fades out with the height
const SHADOW_HEIGHT = 0.5
// The shadow shows on surfaces up to SHADOW_EXCLUDED_HEIGHT above the plane,
// plus this many steps of the scene's depth buffer (24 bit), so that a floor
// lying in the plane gets the shadow at any distance from the camera
const SHADOW_DEPTH_STEPS = 3
const DEPTH_STEP = 1 / (2 ** 24 - 1)

// ── Tone mapping ──────────────────────────────────────────────────────────────
// Only lit surfaces (see toneMapped) and the environment background are tone
// mapped: unlit materials, lines, the background color, glow and outlines keep
// their exact colors. The exposure multiplies their light first, also without a
// tone mapping. Tone mappings: 'none', 'neutral', 'aces' and 'agx', like
// three.js' curves of those names.
const TONE_MAPPINGS = { none: 0, neutral: 1, aces: 2, agx: 3 }
// shared by all lit materials, so changing them rebuilds no material
const toneMappingMode = uniform(0, 'int')
const toneMappingExposure = uniform(1)

const toneMap = Fn(([light]) => {
  const result = vec3(light).mul(toneMappingExposure).toVar()
  If(toneMappingMode.equal(1), () => {
    result.assign(neutralToneMapping(light, toneMappingExposure))
  }).ElseIf(toneMappingMode.equal(2), () => {
    result.assign(acesFilmicToneMapping(light, toneMappingExposure))
  }).ElseIf(toneMappingMode.equal(3), () => {
    result.assign(agxToneMapping(light, toneMappingExposure))
  })
  return result
})

/**
 * Sets how lit surfaces and the environment background are tone mapped.
 * Engines from before tone mapping send none: they keep their look.
 */
export function setToneMapping(toneMapping, exposure) {
  toneMappingMode.value = TONE_MAPPINGS[toneMapping ?? 'none'] ?? 0
  toneMappingExposure.value = exposure ?? 1
}

/**
 * Tone maps the light of a lit material (a MeshStandardNodeMaterial). Call
 * before it is first rendered.
 */
export function toneMapped(material) {
  material.outputNode = vec4(toneMap(output.rgb), output.a)
  return material
}

// ── Environment map ───────────────────────────────────────────────────────────
// The lighting's environment map: an equirectangular HDR image whose top row is
// the world's +Z (the engine is z-up, three.js maps are y-up) and whose center
// lies in the +X direction, turned around +Z by the rotation.

/**
 * The rotation from the environment map's directions to the world's, for a
 * rotation of the given degrees around +Z
 */
export function environmentToWorld(degrees) {
  return new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(degrees))
    .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
}

/**
 * Loads an environment map (.hdr or .exr) as an equirectangular texture
 */
export function loadEnvironmentMap(url, format, done, failed) {
  const loader = format.toLowerCase() === 'exr' ? new EXRLoader() : new HDRLoader()
  loader.setDataType(THREE.HalfFloatType)
  loader.load(url, map => {
    map.mapping = THREE.EquirectangularReflectionMapping
    done(map)
  }, undefined, failed)
}

/**
 * Makes a mesh or polyline material glow or get outlined, as its engine
 * material (the detail of its material event) says. Call before it is first
 * rendered.
 */
export function highlight(
  material,
  { glow, outline, outlineColor = [1, 0.5, 0], outlineThickness = OUTLINE_THICKNESS },
) {
  const thickness = outline ? Math.min(Math.max(outlineThickness, 0), MAX_OUTLINE_THICKNESS) : 0
  material.userData.glow = !!glow
  material.userData.outline = thickness > 0
  material.userData.outlineThickness = thickness
  // the glow buffer of the scene pass and the mask of the outline pass (see
  // createSceneEffects) get their colors; the mask's alpha is the thickness
  const outputs = {}
  if (glow) outputs.glow = vec4(materialColor, 1)
  if (thickness > 0) {
    outputs.mask = vec4(color(new THREE.Color(...outlineColor)), thickness / MAX_OUTLINE_THICKNESS)
  }
  if (Object.keys(outputs).length) material.mrtNode = mrt(outputs)
  return material
}

/**
 * Puts an instance of an output in the layers that make it outlined or cast the
 * contact shadow, after its material or castShadow changed. Lines and points
 * cast no contact shadow.
 */
export function syncLayers(object) {
  const material = object.material
  object.layers.set(0)
  if (material?.userData.outline) object.layers.enable(OUTLINE_LAYER)
  if (object.isMesh && !object.isInstancedMesh && object.castShadow) {
    object.layers.enable(CONTACT_SHADOW_LAYER)
  }
}

/**
 * Renders the scene with the effects. Call invalidate() whenever an output's
 * geometry, material, instances or visibility changed.
 * @param region what the contact shadow covers: the lighting's shadow bounds,
 *        else the scene's bounds
 */
export function createSceneEffects(renderer, scene, camera, region) {
  // The scene itself is rendered on a transparent background (the background is
  // added below), premultiplied, with a second buffer that only the glowing
  // materials draw into.
  scene.background = null
  renderer.setClearColor(0x000000, 0)
  const scenePass = pass(scene, camera)
  // (extra attachments are cleared to opaque black unless told otherwise)
  scenePass.setMRT(mrt({ output, glow: vec4(0) }).setClearColor('glow', 0x000000, 0))
  const sceneColor = scenePass.getTextureNode('output')
  const glow = bloom(scenePass.getTextureNode('glow'), GLOW_STRENGTH, GLOW_RADIUS, 0)

  // The outlined objects alone, in their outline color with their thickness
  // (see highlight), also where others hide them
  const outlineCamera = new THREE.PerspectiveCamera()
  const outlinePass = pass(scene, outlineCamera)
  outlinePass.setMRT(mrt({ output, mask: vec4(0) }).setClearColor('mask', 0x000000, 0))
  const mask = outlinePass.getTextureNode('mask')
  const texelSize = uniform(new THREE.Vector2())
  // mask alpha to thickness in device pixels
  const thicknessScale = uniform(MAX_OUTLINE_THICKNESS)
  // how far, in device pixels, the thickest outline reaches
  const outlineReach = uniform(0, 'int')

  // like material colors, 0..1 in the working (linear) color space
  const backgroundColor = uniform(new THREE.Vector3())
  const backgroundAlpha = uniform(0)
  // the environment map in the background, when there is one and the
  // background shows it
  let environmentMap = null
  let environmentBackground = false
  // world to environment map directions
  const worldToEnvironment = uniform(new THREE.Matrix3())
  const backgroundBlur = uniform(0)
  const backgroundIntensity = uniform(1)
  const cameraWorld = uniform(new THREE.Matrix4())

  // Pixels outside the outlined shapes that are within a shape's thickness of it
  // get its outline color. Separable, so it stays cheap for thick outlines: a
  // pixel is reached from a shape pixel (dx, dy) away when
  // (t + 0.5)² - dx² - dy² >= 0, so a horizontal pass keeps, per pixel, the
  // dx with the largest (t + 0.5)² - dx² in its row (as r = dx, g = its root,
  // or -1 when there's none) and the vertical pass then finds the largest
  // remainder after subtracting dy².
  const reachable = rtt(Fn(() => {
    const best = vec2(0, -1).toVar()
    Loop({ start: outlineReach.negate(), end: outlineReach, condition: '<=' }, ({ i }) => {
      const dx = float(i)
      const m = mask.sample(screenUV.add(vec2(dx, 0).mul(texelSize)))
      const budget = m.a.mul(thicknessScale).add(0.5).pow(2).sub(dx.mul(dx))
      If(m.a.greaterThan(0).and(budget.greaterThanEqual(0)).and(budget.greaterThan(best.y.mul(best.y)).or(best.y.lessThan(0))), () => {
        best.assign(vec2(dx, sqrt(budget)))
      })
    })
    return vec4(best, 0, 1)
  })(), null, null, { type: THREE.HalfFloatType })
  reachable.value.minFilter = reachable.value.magFilter = THREE.NearestFilter

  const outline = Fn(() => {
    const bestSlack = float(-1).toVar()
    const offset = vec2(0).toVar()
    Loop({ start: outlineReach.negate(), end: outlineReach, condition: '<=' }, ({ i }) => {
      const dy = float(i)
      const h = reachable.sample(screenUV.add(vec2(0, dy).mul(texelSize)))
      const slack = h.y.mul(h.y).sub(dy.mul(dy))
      If(h.y.greaterThanEqual(0).and(slack.greaterThan(bestSlack)), () => {
        bestSlack.assign(slack)
        offset.assign(vec2(h.x, dy))
      })
    })
    const source = mask.sample(screenUV.add(offset.mul(texelSize)))
    const coverage = clamp(source.a.mul(thicknessScale).add(0.5).sub(offset.length()), 0, 1)
    const inside = mask.sample(screenUV).a.greaterThan(0)
    const shown = bestSlack.greaterThanEqual(0).and(inside.not())
    return select(shown, vec4(source.rgb.mul(coverage), coverage), vec4(0))
  })

  // ── Contact shadow ──────────────────────────────────────────────────────────
  // Like three.js' webgl_shadow_contact example: the casters are rendered as
  // seen from the plane, brighter the closer they are to it, and blurred. The
  // result isn't drawn as a plane in the scene, though, but while compositing:
  // each pixel's view ray meets the plane, and the shadow shows there unless the
  // scene's surface at that pixel lies above the plane, on the camera's side.
  // (A plane pulled in front of the floor with a polygon offset darkened the
  // bottoms of objects near the plane, the more the farther from the camera.)
  const shadowTarget = new THREE.RenderTarget(SHADOW_RESOLUTION, SHADOW_RESOLUTION)
  const blurTarget = new THREE.RenderTarget(SHADOW_RESOLUTION, SHADOW_RESOLUTION)
  const shadowCamera = new THREE.OrthographicCamera()
  shadowCamera.layers.set(CONTACT_SHADOW_LAYER)
  const casterMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide })
  casterMaterial.colorNode = vec3(depth.oneMinus().mul(SHADOW_DARKNESS))

  const blurSource = texture(shadowTarget.texture)
  const blurOffset = uniform(new THREE.Vector2())
  const blurMaterial = new THREE.MeshBasicNodeMaterial()
  blurMaterial.colorNode = Fn(() => {
    const weights = [0.1633, 0.1531, 0.12245, 0.0918, 0.051]
    let sum = blurSource.sample(uv()).mul(weights[0])
    for (let i = 1; i < weights.length; ++i) {
      sum = sum.add(blurSource.sample(uv().add(blurOffset.mul(i))).mul(weights[i]))
      sum = sum.add(blurSource.sample(uv().sub(blurOffset.mul(i))).mul(weights[i]))
    }
    return sum
  })()
  const blurQuad = new THREE.QuadMesh(blurMaterial)

  // whether the shadow shows: it's enabled, rendered and the camera is above the plane
  const shadowShown = uniform(0)
  // from the camera's view space to (u, v, height above the plane) of the
  // shadow image. The shadow camera looks up from the plane, so its image is
  // mirrored: its top row (render targets are sampled top row first, at v = 0,
  // in three's node materials on WebGPU and WebGL alike) shows the plane's
  // lowest y, which is where v = 0 here too.
  const viewToShadow = uniform(new THREE.Matrix4())
  const projectionInverse = uniform(new THREE.Matrix4())
  const cameraNear = uniform(0.1)
  const cameraFar = uniform(1000)
  // the height above the plane up to which surfaces count as lying in it
  const shadowTolerance = uniform(0)
  const sceneDepth = scenePass.getTextureNode('depth')
  const shadowImage = texture(shadowTarget.texture)

  // the shadow's opacity at this pixel
  const shadow = Fn(() => {
    const amount = float(0).toVar()
    If(shadowShown.greaterThan(0), () => {
      // the view ray, from the camera (at the origin of view space) to the far plane
      const origin = viewToShadow.mul(vec4(0, 0, 0, 1)).xyz
      const farPoint = getViewPosition(screenUV, float(1), projectionInverse)
      const end = viewToShadow.mul(vec4(farPoint, 1)).xyz
      const drop = origin.z.sub(end.z)
      // the camera is above the plane, so the ray only meets it going down
      If(drop.greaterThan(0), () => {
        const t = origin.z.div(drop)
        const onPlane = origin.add(end.sub(origin).mul(t)).toVar()
        const d = sceneDepth.sample(screenUV).x
        const view = getViewPosition(screenUV, d, projectionInverse)
        const height = viewToShadow.mul(vec4(view, 1)).z
        // how far a step of the depth buffer moves the surface along the ray,
        // as a height above the plane
        const distance = view.z.negate()
        const step = distance.mul(distance).mul(cameraFar.sub(cameraNear))
          .div(cameraNear.mul(cameraFar)).mul(DEPTH_STEP)
        const tolerance = shadowTolerance.add(step.mul(drop).div(cameraFar).mul(SHADOW_DEPTH_STEPS))
        // nothing drawn here, or the surface lies in or below the plane
        const visible = d.greaterThanEqual(1).or(height.lessThanEqual(tolerance))
        const inside = onPlane.x.greaterThanEqual(0).and(onPlane.x.lessThanEqual(1))
          .and(onPlane.y.greaterThanEqual(0)).and(onPlane.y.lessThanEqual(1))
        If(t.lessThanEqual(1).and(visible).and(inside), () => {
          amount.assign(shadowImage.sample(onPlane.xy).r.mul(SHADOW_OPACITY))
        })
      })
    })
    return amount
  })

  // The environment map seen in this pixel's view direction, sharp or blurred
  // like the reflection of a surface of the blur's roughness, tone mapped
  const environmentSeen = map => Fn(() => {
    const view = getViewPosition(screenUV, float(1), projectionInverse)
    const direction = worldToEnvironment.mul(cameraWorld.mul(vec4(view, 0)).xyz.normalize()).toVar()
    const sharp = texture(map, equirectUV(direction)).rgb
    const blurred = pmremTexture(map, direction, backgroundBlur).rgb
    return toneMap(select(backgroundBlur.greaterThan(0), blurred, sharp).mul(backgroundIntensity))
  })()

  // All premultiplied: the scene with the contact shadow over it, the
  // background under that, then the glow added as light, then the outlines over it
  function composite(withGlow, withOutline, environment) {
    return Fn(() => {
      const rendered = sceneColor.toVar()
      const dark = shadow()
      const base = vec4(rendered.rgb.mul(dark.oneMinus()), dark.add(rendered.a.mul(dark.oneMinus()))).toVar()
      let color = environment
        ? vec4(base.rgb.add(environmentSeen(environment).mul(base.a.oneMinus())), 1)
        : vec4(
          base.rgb.add(backgroundColor.mul(backgroundAlpha).mul(base.a.oneMinus())),
          base.a.add(backgroundAlpha.mul(base.a.oneMinus())),
        )
      if (withGlow) {
        // the faintest glow is dropped: the bloom's coarsest levels would show
        // as rings far around the object
        const light = glow.rgb.sub(GLOW_CUTOFF).max(0).div(1 - GLOW_CUTOFF)
        color = vec4(color.rgb.add(light), clamp(color.a.add(max(light.r, max(light.g, light.b))), 0, 1))
      }
      if (withOutline) {
        const line = outline()
        color = vec4(line.rgb.add(color.rgb.mul(line.a.oneMinus())), line.a.add(color.a.mul(line.a.oneMinus())))
      }
      return color
    })()
  }

  const pipeline = new THREE.RenderPipeline(renderer)
  let hasGlow = false
  let hasOutline = false
  let shownEnvironment = null
  pipeline.outputNode = composite(false, false, null)

  // rebuilds the composite when what it combines changed
  function updateComposite() {
    const environment = environmentBackground ? environmentMap : null
    if (environment === shownEnvironment) return
    shownEnvironment = environment
    pipeline.outputNode = composite(hasGlow, hasOutline, shownEnvironment)
    pipeline.needsUpdate = true
  }

  let contactShadow = { enabled: false, orientation: new THREE.Matrix4().elements }
  const planeFrame = new THREE.Matrix4()
  // world to (u, v, height) of the shadow image
  const planeToShadow = new THREE.Matrix4()
  let shadowRendered = false
  let shadowDirty = true
  let highlightsDirty = true
  // of the thickest outline shown, in CSS pixels
  let outlineThickness = 0

  // The rotation and translation of the plane's transformation, without scaling
  function rigid(elements) {
    const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3()
    new THREE.Matrix4().fromArray(Array.from(elements)).decompose(position, rotation, scale)
    return new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(1, 1, 1))
  }

  function renderShadow() {
    shadowDirty = false
    shadowRendered = false
    if (!contactShadow.enabled) return
    const box = region()
    if (box.isEmpty()) return

    // the footprint of the region in the plane
    const toPlane = planeFrame.clone().invert()
    const footprint = new THREE.Box2()
    const corner = new THREE.Vector3()
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
      corner.applyMatrix4(toPlane)
      footprint.expandByPoint(new THREE.Vector2(corner.x, corner.y))
    }
    const size = footprint.getSize(new THREE.Vector2())
    const largest = Math.max(size.x, size.y)
    if (!(largest > 0)) return
    // a line-like footprint still gets a square-ish shadow
    size.set(Math.max(size.x, 0.1 * largest), Math.max(size.y, 0.1 * largest))
    const center = footprint.getCenter(new THREE.Vector2())
    const padded = size.clone().multiplyScalar(1 + 2 * SHADOW_PADDING)

    // looking up from the plane: camera x is the plane's x, camera y its -y.
    // Geometry in or below the plane is in front of the near plane, so clipped.
    shadowCamera.left = center.x - padded.x / 2
    shadowCamera.right = center.x + padded.x / 2
    shadowCamera.top = -(center.y - padded.y / 2)
    shadowCamera.bottom = -(center.y + padded.y / 2)
    shadowCamera.near = SHADOW_EXCLUDED_HEIGHT * size.length()
    shadowCamera.far = SHADOW_HEIGHT * largest
    shadowCamera.updateProjectionMatrix()
    new THREE.Matrix4().multiplyMatrices(planeFrame, new THREE.Matrix4().makeRotationX(Math.PI))
      .decompose(shadowCamera.position, shadowCamera.quaternion, shadowCamera.scale)
    shadowCamera.updateMatrixWorld(true)

    const previousTarget = renderer.getRenderTarget()
    const previousClear = renderer.getClearColor(new THREE.Color())
    const previousAlpha = renderer.getClearAlpha()
    renderer.setClearColor(0x000000, 1)
    scene.overrideMaterial = casterMaterial
    renderer.setRenderTarget(shadowTarget)
    renderer.render(scene, shadowCamera)
    scene.overrideMaterial = null

    // blur twice, the second time less, to smooth the first blur's artifacts
    for (const amount of [SHADOW_BLUR, 0.4 * SHADOW_BLUR]) {
      const offset = amount / SHADOW_RESOLUTION
      blurSource.value = shadowTarget.texture
      blurOffset.value.set(offset, 0)
      renderer.setRenderTarget(blurTarget)
      blurQuad.render(renderer)
      blurSource.value = blurTarget.texture
      blurOffset.value.set(0, offset)
      renderer.setRenderTarget(shadowTarget)
      blurQuad.render(renderer)
    }
    renderer.setRenderTarget(previousTarget)
    renderer.setClearColor(previousClear, previousAlpha)

    // plane coordinates to (u, v, height) of the shadow image
    planeToShadow.makeScale(1 / padded.x, 1 / padded.y, 1)
      .multiply(new THREE.Matrix4().makeTranslation(padded.x / 2 - center.x, padded.y / 2 - center.y, 0))
      .multiply(toPlane)
    shadowTolerance.value = SHADOW_EXCLUDED_HEIGHT * size.length()
    shadowRendered = true
  }

  // per frame: the camera moves
  function updateShadowView() {
    camera.updateMatrixWorld()
    cameraWorld.value.copy(camera.matrixWorld)
    viewToShadow.value.multiplyMatrices(planeToShadow, camera.matrixWorld)
    projectionInverse.value.copy(camera.projectionMatrixInverse)
    cameraNear.value = camera.near
    cameraFar.value = camera.far
    const cameraHeight = new THREE.Vector3().setFromMatrixPosition(viewToShadow.value).z
    shadowShown.value = shadowRendered && cameraHeight > 0 ? 1 : 0
  }

  function updateHighlights() {
    highlightsDirty = false
    let glowing = false, thickest = 0
    scene.traverseVisible(object => {
      const material = object.material
      if (!material?.userData) return
      glowing ||= !!material.userData.glow
      if (material.userData.outline) thickest = Math.max(thickest, material.userData.outlineThickness)
    })
    outlineThickness = thickest
    const outlined = thickest > 0
    if (glowing === hasGlow && outlined === hasOutline) return
    hasGlow = glowing
    hasOutline = outlined
    pipeline.outputNode = composite(hasGlow, hasOutline, shownEnvironment)
    pipeline.needsUpdate = true
  }

  return {
    // { mode: 'none' }: transparent, whatever is behind the canvas shows;
    // { mode: 'color', color: [r, g, b] }: 0..1, like the material colors;
    // { mode: 'environment', blur, intensity }: the lighting's environment map,
    // blurred as if reflected by a surface of roughness blur (0..1) and scaled
    // by intensity, transparent without one
    setBackground(background) {
      if (background.mode === 'color') {
        backgroundColor.value.set(background.color[0], background.color[1], background.color[2])
        backgroundAlpha.value = 1
      } else {
        backgroundAlpha.value = 0
      }
      environmentBackground = background.mode === 'environment'
      if (background.mode === 'environment') {
        backgroundBlur.value = Math.min(Math.max(background.blur ?? 0, 0), 1)
        backgroundIntensity.value = Math.max(background.intensity ?? 1, 0)
      }
      updateComposite()
    },
    /**
     * The environment map the background shows (when its mode says so), null
     * without one, and its rotation to world directions (see environmentToWorld)
     */
    setEnvironment(map, toWorld) {
      environmentMap = map
      worldToEnvironment.value.setFromMatrix4(toWorld).transpose()
      updateComposite()
    },
    // { enabled, orientation }: orientation is a column-major 4x4 placing the
    // shadow plane (z = 0 of its frame); only its rotation and translation count
    setContactShadow(shadow) {
      contactShadow = shadow
      planeFrame.copy(rigid(shadow.orientation))
      shadowDirty = true
    },
    invalidate() {
      shadowDirty = true
      highlightsDirty = true
    },
    render() {
      if (shadowDirty) renderShadow()
      updateShadowView()
      if (highlightsDirty) updateHighlights()
      if (hasOutline) {
        outlineCamera.copy(camera, false)
        outlineCamera.layers.set(OUTLINE_LAYER)
        const size = renderer.getDrawingBufferSize(new THREE.Vector2())
        texelSize.value.set(1 / size.x, 1 / size.y)
        const ratio = renderer.getPixelRatio()
        thicknessScale.value = MAX_OUTLINE_THICKNESS * ratio
        outlineReach.value = Math.ceil(outlineThickness * ratio + 0.5)
      }
      pipeline.render()
    },
    dispose() {
      for (const material of [casterMaterial, blurMaterial]) material.dispose()
      shadowTarget.dispose()
      blurTarget.dispose()
      reachable.dispose()
      pipeline.dispose()
    },
  }
}

