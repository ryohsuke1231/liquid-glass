import './style.css';
import * as THREE from 'three';
import vertexShader from './shaders/vertex.glsl?raw';
import fragmentShader from './shaders/glass.frag?raw';
import gaussianBlurShader from './shaders/gaussianBlur.frag?raw';

const DEFAULTS = {
  max_z: 16.0,
  displacement_scale: 78.5,
  edge_smoothing: 2.4,
  profile_shape_n: 3.4,
  ior: 2.40,
  chroma_strength: 0.006,
  blur_strength: 0.30,
  tint_strength: 0.04,
    tint_r: 1.0,
    tint_g: 1.0,
    tint_b: 1.0,
  specular_intensity: 0.00,
  rim_width: 2.5,
  rim_intensity: 1.36,
  rim_directional_power: 1.7,
  rim_power: 8.0,
  rim_light_color_intensity: 2.5,
  sheen_intensity: 0.32,
  shininess: 42.0,
  light_angle_deg: 120.0,
  mouse_radius: 280.0,
  bg_glow_intensity: 0.0,
  shadow_radius: 50.0,
  shadow_intensity: 0.50,
};

const BLUR_RADIUS_MAX_PX = 28.0;
const MAX_GAUSS_PAIRS = 14;
const MAX_GAUSS_RADIUS = MAX_GAUSS_PAIRS * 2;
const DEFAULT_BACKGROUND_URL = '/reference-scene.svg';
const DEFAULT_STAGE_SHAPE = {
  widthPx: 480,
  heightPx: 230,
};
const FIXED_STAGE_RADIUS_PX = 115;

document.querySelector('#app').innerHTML = `
<main class="layout">
  <header class="hero">
    <p class="eyebrow">Liquid Glass / Three.js Sandbox</p>
    <h1>Capsule Refraction Playground</h1>
    <p class="subhead">4:1 capsule target with GNOME-compatible uniforms and pointer lighting.</p>
    <button type="button" class="controls-toggle" data-controls-toggle aria-expanded="true">Hide Controls</button>
  </header>

  <section class="stage" data-capsule-frame>
    <canvas data-canvas aria-label="Refraction sandbox canvas"></canvas>
    <div class="badge badge-left" data-resolution>resolution: -- x --</div>
    <div class="badge badge-right" data-pointer>pointer: off</div>
  </section>

  <section class="controls" data-controls-panel>
    <h2>Tuning</h2>
    <div class="control-grid">
      <label>UI Width (px)
        <input type="range" min="1" max="1" step="1" value="${DEFAULT_STAGE_SHAPE.widthPx}" data-shape="width" />
        <span class="range-hint" data-shape-info="width">value: --px (range: -- to --)</span>
      </label>
      <label>UI Height (px)
        <input type="range" min="1" max="1" step="1" value="${DEFAULT_STAGE_SHAPE.heightPx}" data-shape="height" />
        <span class="range-hint" data-shape-info="height">value: --px (range: -- to --)</span>
      </label>
      <label>Displacement
        <input type="range" min="8" max="128" step="0.1" value="${DEFAULTS.displacement_scale}" data-uniform="displacement_scale" />
      </label>
      <label>IOR
        <input type="range" min="1.0" max="2.4" step="0.01" value="${DEFAULTS.ior}" data-uniform="ior" />
      </label>
      <label>Thickness (max_z)
        <input type="range" min="8.0" max="56.0" step="0.5" value="${DEFAULTS.max_z}" data-uniform="max_z" />
      </label>
      <label>Chromatic
        <input type="range" min="0.0" max="0.06" step="0.001" value="${DEFAULTS.chroma_strength}" data-uniform="chroma_strength" />
      </label>
      <label>Edge Feather
        <input type="range" min="0.5" max="8.0" step="0.1" value="${DEFAULTS.edge_smoothing}" data-uniform="edge_smoothing" />
      </label>
      <label>Superellipse U
        <input type="range" min="2.0" max="12.0" step="0.1" value="${DEFAULTS.profile_shape_n}" data-uniform="profile_shape_n" />
      </label>
      <label>Specular
        <input type="range" min="0.0" max="1.5" step="0.01" value="${DEFAULTS.specular_intensity}" data-uniform="specular_intensity" />
      </label>
      <label>Rim
        <input type="range" min="0.0" max="3.0" step="0.01" value="${DEFAULTS.rim_intensity}" data-uniform="rim_intensity" />
      </label>
      <label>Rim Width
        <input type="range" min="0.8" max="6.0" step="0.1" value="${DEFAULTS.rim_width}" data-uniform="rim_width" />
      </label>
      <label>Rim Power
        <input type="range" min="1.0" max="8.0" step="0.1" value="${DEFAULTS.rim_power}" data-uniform="rim_power" />
      </label>
      <label>Rim Light Intensity
        <input type="range" min="0.0" max="2.5" step="0.01" value="${DEFAULTS.rim_light_color_intensity}" data-uniform="rim_light_color_intensity" />
      </label>
      <label>Sheen Intensity
        <input type="range" min="0.0" max="1.2" step="0.01" value="${DEFAULTS.sheen_intensity}" data-uniform="sheen_intensity" />
      </label>
      <label>Light Angle (deg)
        <input type="range" min="0" max="360" step="1" value="${DEFAULTS.light_angle_deg}" data-uniform="light_angle_deg" />
      </label>
      <label>Shininess
        <input type="range" min="4.0" max="128.0" step="1.0" value="${DEFAULTS.shininess}" data-uniform="shininess" />
      </label>
      <label>Blur
        <input type="range" min="0.0" max="1.2" step="0.01" value="${DEFAULTS.blur_strength}" data-uniform="blur_strength" />
      </label>
      <label>Tint Strength
        <input type="range" min="0.0" max="0.5" step="0.01" value="${DEFAULTS.tint_strength}" data-uniform="tint_strength" />
      </label>
      <label>Shadow Radius
        <input type="range" min="0.0" max="150.0" step="1.0" value="${DEFAULTS.shadow_radius}" data-uniform="shadow_radius" />
      </label>
      <label>Shadow Intensity
        <input type="range" min="0.0" max="3.5" step="0.01" value="${DEFAULTS.shadow_intensity}" data-uniform="shadow_intensity" />
      </label>
    </div>
  </section>
  <section class="controls controls-image" data-controls-panel>
    <h2>Background Image</h2>
    <div class="image-picker">
      <label class="image-picker-label" for="background-image-input">Open image file</label>
      <input id="background-image-input" type="file" accept="image/*,.png,.jpg,.jpeg" />
      <button type="button" class="image-picker-reset" data-bg-reset>Reset to default</button>
      <p class="image-picker-status" data-bg-status>Current: reference-scene.svg</p>
    </div>
  </section>
</main>
`;

const frameEl = document.querySelector('[data-capsule-frame]');
const canvasEl = document.querySelector('[data-canvas]');
const resolutionEl = document.querySelector('[data-resolution]');
const pointerEl = document.querySelector('[data-pointer]');
const sliders = document.querySelectorAll('input[data-uniform]');
const shapeSliders = document.querySelectorAll('input[data-shape]');
const shapeInfoEls = {
  width: document.querySelector('[data-shape-info="width"]'),
  height: document.querySelector('[data-shape-info="height"]'),
};
const bgImageInputEl = document.querySelector('#background-image-input');
const bgStatusEl = document.querySelector('[data-bg-status]');
const bgResetEl = document.querySelector('[data-bg-reset]');
const controlsToggleEl = document.querySelector('[data-controls-toggle]');
const controlsPanels = document.querySelectorAll('[data-controls-panel]');

const renderer = new THREE.WebGLRenderer({
    canvas: canvasEl,
    antialias: true,
    alpha: true,
    premultipliedAlpha: true,
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const uniforms = {
    cogl_sampler: { value: null },
  scene_blur: { value: null },
    resolution_x: { value: 0.0 },
    resolution_y: { value: 0.0 },
    pointer_x: { value: -1000.0 },
    pointer_y: { value: -1000.0 },
    intensity: { value: 0.0 },
    corner_radius: { value: 0.0 },
    viewport_x: { value: 0.0 },
    viewport_y: { value: 0.0 },
    viewport_w: { value: 1.0 },
    viewport_h: { value: 1.0 },
    ...Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, { value: v }])),
};

const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
});

scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const backgroundScene = new THREE.Scene();
const blurScene = new THREE.Scene();

const blurPairOffsets = new Float32Array(MAX_GAUSS_PAIRS);
const blurPairWeights = new Float32Array(MAX_GAUSS_PAIRS);
const blurKernelState = {
  radiusKey: -1,
};

const blurUniforms = {
  tInput: { value: null },
  uDirection: { value: new THREE.Vector2(1.0, 0.0) },
  uTexelSize: { value: new THREE.Vector2(1.0, 1.0) },
  uCenterWeight: { value: 1.0 },
  uPairCount: { value: 0 },
  uPairOffsets: { value: blurPairOffsets },
  uPairWeights: { value: blurPairWeights },
};

const blurMaterial = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader: gaussianBlurShader,
  uniforms: blurUniforms,
  depthTest: false,
  depthWrite: false,
});

blurScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMaterial));

const loader = new THREE.TextureLoader();
let objectUrlInUse = null;
const loadedImageSize = {
  width: DEFAULT_STAGE_SHAPE.widthPx,
  height: DEFAULT_STAGE_SHAPE.heightPx,
};
const shapeState = {
  widthPx: DEFAULT_STAGE_SHAPE.widthPx,
  heightPx: DEFAULT_STAGE_SHAPE.heightPx,
};
const shapeLimits = {
  widthMin: 1,
  widthMax: 1,
  heightMin: 1,
  heightMax: 1,
};
let controlsVisible = true;

function updateControlsVisibility() {
  controlsPanels.forEach(panel => {
    panel.classList.toggle('is-hidden', !controlsVisible);
  });

  if (!controlsToggleEl)
    return;

  controlsToggleEl.textContent = controlsVisible ? 'Hide Controls' : 'Show Controls';
  controlsToggleEl.setAttribute('aria-expanded', controlsVisible ? 'true' : 'false');
}

function getSliderPrecision(slider) {
  const stepText = `${slider.step ?? ''}`;

  if (!stepText || stepText === 'any')
    return 0;

  const dotIndex = stepText.indexOf('.');
  if (dotIndex === -1)
    return 0;

  return Math.max(stepText.length - dotIndex - 1, 0);
}

function formatSliderNumber(value, precision) {
  const parsed = Number.parseFloat(`${value}`);

  if (!Number.isFinite(parsed))
    return '--';

  return parsed.toFixed(precision);
}

function updateUniformSliderInfo(slider) {
  const key = slider.dataset.uniform;

  if (!key)
    return;

  const infoEl = document.querySelector(`[data-uniform-info="${key}"]`);

  if (!infoEl)
    return;

  const precision = getSliderPrecision(slider);
  const valueText = formatSliderNumber(slider.value, precision);
  const minText = formatSliderNumber(slider.min, precision);
  const maxText = formatSliderNumber(slider.max, precision);
  infoEl.textContent = `value: ${valueText} (range: ${minText} to ${maxText})`;
}

function setupUniformSliderInfo() {
  sliders.forEach(slider => {
    const key = slider.dataset.uniform;

    if (!key)
      return;

    const label = slider.closest('label');

    if (!label)
      return;

    let infoEl = label.querySelector(`[data-uniform-info="${key}"]`);

    if (!infoEl) {
      infoEl = document.createElement('span');
      infoEl.className = 'range-hint';
      infoEl.dataset.uniformInfo = key;
      label.append(infoEl);
    }

    updateUniformSliderInfo(slider);
  });
}

function toPositivePx(value, fallback = 1) {
  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed))
    return Math.max(Math.round(fallback), 1);

  return Math.max(Math.round(parsed), 1);
}

function getTextureIntrinsicSize(texture) {
  const source = texture?.source?.data;
  const image = texture?.image;
  const width = source?.naturalWidth ?? source?.videoWidth ?? source?.width ?? image?.naturalWidth ?? image?.videoWidth ?? image?.width;
  const height = source?.naturalHeight ?? source?.videoHeight ?? source?.height ?? image?.naturalHeight ?? image?.videoHeight ?? image?.height;

  if (!Number.isFinite(width) || !Number.isFinite(height))
    return null;

  return {
    width: Math.max(Math.round(width), 1),
    height: Math.max(Math.round(height), 1),
  };
}

function updateLoadedImageSize(texture) {
  const size = getTextureIntrinsicSize(texture);

  if (!size)
    return;

  loadedImageSize.width = size.width;
  loadedImageSize.height = size.height;
}

function rebuildShapeLimits() {
  shapeLimits.widthMax = toPositivePx(loadedImageSize.width, DEFAULT_STAGE_SHAPE.widthPx);
  shapeLimits.heightMax = toPositivePx(loadedImageSize.height, DEFAULT_STAGE_SHAPE.heightPx);
  const minSide = Math.max(toPositivePx(FIXED_STAGE_RADIUS_PX * 2, 1), 1);
  shapeLimits.widthMin = Math.min(shapeLimits.widthMax, minSide);
  shapeLimits.heightMin = Math.min(shapeLimits.heightMax, minSide);
}

function enforceShapeConstraints() {
  shapeState.widthPx = THREE.MathUtils.clamp(
    toPositivePx(shapeState.widthPx, shapeLimits.widthMax),
    shapeLimits.widthMin,
    shapeLimits.widthMax,
  );
  shapeState.heightPx = THREE.MathUtils.clamp(
    toPositivePx(shapeState.heightPx, shapeLimits.heightMax),
    shapeLimits.heightMin,
    shapeLimits.heightMax,
  );
}

function updateShapeInfoText() {
  const widthInfo = shapeInfoEls.width;
  const heightInfo = shapeInfoEls.height;

  if (widthInfo)
    widthInfo.textContent = `value: ${shapeState.widthPx}px (range: ${shapeLimits.widthMin} to ${shapeLimits.widthMax})`;

  if (heightInfo)
    heightInfo.textContent = `value: ${shapeState.heightPx}px (range: ${shapeLimits.heightMin} to ${shapeLimits.heightMax})`;
}

function syncShapeSliderUi() {
  shapeSliders.forEach(slider => {
    const key = slider.dataset.shape;

    if (key === 'width') {
      slider.min = `${shapeLimits.widthMin}`;
      slider.max = `${shapeLimits.widthMax}`;
      slider.value = `${shapeState.widthPx}`;
      return;
    }

    if (key === 'height') {
      slider.min = `${shapeLimits.heightMin}`;
      slider.max = `${shapeLimits.heightMax}`;
      slider.value = `${shapeState.heightPx}`;
    }
  });

  updateShapeInfoText();
}

function applyStageShape() {
  frameEl.style.width = `${shapeState.widthPx}px`;
  frameEl.style.height = `${shapeState.heightPx}px`;
  frameEl.style.borderRadius = `${FIXED_STAGE_RADIUS_PX}px`;
  updateResolution();
}

function syncShapeForCurrentImage() {
  rebuildShapeLimits();
  enforceShapeConstraints();
  syncShapeSliderUi();
  applyStageShape();
}

function configureBackgroundTexture(texture) {
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
}

async function loadBackgroundTexture(url) {
  const texture = await loader.loadAsync(url);
  configureBackgroundTexture(texture);
  return texture;
}

function setBackgroundStatus(message, isError = false) {
  if (!bgStatusEl)
    return;

  bgStatusEl.textContent = message;
  bgStatusEl.classList.toggle('is-error', isError);
}

function setPageBackgroundImage(url) {
  const safeUrl = url.replace(/"/g, '\\"');
  document.documentElement.style.setProperty('--scene-image', `url("${safeUrl}")`);
}

let backgroundTexture = await loadBackgroundTexture(DEFAULT_BACKGROUND_URL);
updateLoadedImageSize(backgroundTexture);
setPageBackgroundImage(DEFAULT_BACKGROUND_URL);
setBackgroundStatus('Current: reference-scene.svg');
const backgroundMaterial = new THREE.MeshBasicMaterial({ map: backgroundTexture });
backgroundScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), backgroundMaterial));

function swapBackgroundTexture(nextTexture) {
  const previousTexture = backgroundTexture;
  backgroundTexture = nextTexture;
  backgroundMaterial.map = nextTexture;
  backgroundMaterial.needsUpdate = true;

  if (previousTexture && previousTexture !== nextTexture)
    previousTexture.dispose();
}

function releaseObjectUrl() {
  if (!objectUrlInUse)
    return;

  URL.revokeObjectURL(objectUrlInUse);
  objectUrlInUse = null;
}

async function applyBackgroundFromFile(file) {
  if (!file.type.startsWith('image/')) {
    setBackgroundStatus('Unsupported file. Choose an image.', true);
    return;
  }

  const objectUrl = URL.createObjectURL(file);
  setBackgroundStatus(`Loading: ${file.name}`);

  try {
    const texture = await loadBackgroundTexture(objectUrl);
    swapBackgroundTexture(texture);
    updateLoadedImageSize(texture);
    setPageBackgroundImage(objectUrl);
    const previousObjectUrl = objectUrlInUse;
    objectUrlInUse = objectUrl;

    if (previousObjectUrl)
      URL.revokeObjectURL(previousObjectUrl);

    setBackgroundStatus(`Current: ${file.name}`);
    syncShapeForCurrentImage();
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    setBackgroundStatus('Failed to load image file.', true);
    console.error('Failed to load background image:', error);
  }
}

async function resetBackgroundTexture() {
  setBackgroundStatus('Loading: reference-scene.svg');

  try {
    const texture = await loadBackgroundTexture(DEFAULT_BACKGROUND_URL);
    swapBackgroundTexture(texture);
    updateLoadedImageSize(texture);
    setPageBackgroundImage(DEFAULT_BACKGROUND_URL);
    releaseObjectUrl();
    setBackgroundStatus('Current: reference-scene.svg');
    syncShapeForCurrentImage();
  } catch (error) {
    setBackgroundStatus('Failed to restore default image.', true);
    console.error('Failed to reset background image:', error);
  }
}

if (bgImageInputEl) {
  bgImageInputEl.addEventListener('change', async event => {
    const file = event.currentTarget.files?.[0];

    if (!file)
      return;

    await applyBackgroundFromFile(file);

    // Allow selecting the same file repeatedly.
    event.currentTarget.value = '';
  });
}

if (bgResetEl) {
  bgResetEl.addEventListener('click', () => {
    resetBackgroundTexture();
  });
}

if (controlsToggleEl) {
  controlsToggleEl.addEventListener('click', () => {
    controlsVisible = !controlsVisible;
    updateControlsVisibility();
  });
}

window.addEventListener('beforeunload', () => {
  releaseObjectUrl();
});

const renderTargetOptions = {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  format: THREE.RGBAFormat,
  depthBuffer: false,
  stencilBuffer: false,
};

const sharpTarget = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
const blurTempTarget = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);
const blurTarget = new THREE.WebGLRenderTarget(1, 1, renderTargetOptions);

sharpTarget.texture.colorSpace = THREE.SRGBColorSpace;
blurTarget.texture.colorSpace = THREE.SRGBColorSpace;
uniforms.cogl_sampler.value = sharpTarget.texture;
uniforms.scene_blur.value = blurTarget.texture;

const drawingSize = new THREE.Vector2();
const drag = {
  active: false,
  pointerId: null,
  startX: 0,
  startY: 0,
  originX: 0,
  originY: 0,
  x: 0,
  y: 0,
};

let viewportPixelWidth = 1;
let viewportPixelHeight = 1;

function updateRenderTargetSize() {
  const dpr = renderer.getPixelRatio();
  const nextWidth = Math.max(Math.round(window.innerWidth * dpr), 1);
  const nextHeight = Math.max(Math.round(window.innerHeight * dpr), 1);

  if (nextWidth === viewportPixelWidth && nextHeight === viewportPixelHeight)
    return;

  viewportPixelWidth = nextWidth;
  viewportPixelHeight = nextHeight;

  sharpTarget.setSize(nextWidth, nextHeight);
  blurTempTarget.setSize(nextWidth, nextHeight);
  blurTarget.setSize(nextWidth, nextHeight);

  blurUniforms.uTexelSize.value.set(1 / nextWidth, 1 / nextHeight);
}

function blurStrengthToRadiusPx(blurStrength) {
  const normalized = THREE.MathUtils.clamp(blurStrength / 1.2, 0.0, 1.0);
  const eased = Math.pow(normalized, 1.05);
  return eased * BLUR_RADIUS_MAX_PX;
}

function gaussianWeight(distance, sigma) {
  return Math.exp(-(distance * distance) / (2.0 * sigma * sigma));
}

function rebuildGaussianKernel(radiusPx) {
  const clampedRadius = THREE.MathUtils.clamp(radiusPx, 0.0, MAX_GAUSS_RADIUS);
  const radiusKey = Math.round(clampedRadius * 100);

  if (radiusKey === blurKernelState.radiusKey)
    return;

  blurKernelState.radiusKey = radiusKey;
  blurPairOffsets.fill(0.0);
  blurPairWeights.fill(0.0);

  const kernelRadius = Math.min(Math.ceil(clampedRadius), MAX_GAUSS_RADIUS);

  if (kernelRadius <= 0) {
    blurUniforms.uCenterWeight.value = 1.0;
    blurUniforms.uPairCount.value = 0;
    return;
  }

  const sigma = Math.max(clampedRadius * 0.5, 0.0001);
  const weights = new Array(kernelRadius + 1);
  let normalization = 0.0;

  for (let tap = 0; tap <= kernelRadius; tap += 1) {
    const weight = gaussianWeight(tap, sigma);
    weights[tap] = weight;
    normalization += tap === 0 ? weight : weight * 2.0;
  }

  blurUniforms.uCenterWeight.value = weights[0] / normalization;

  let pairCount = 0;
  for (let tap = 1; tap <= kernelRadius && pairCount < MAX_GAUSS_PAIRS; tap += 2) {
    const weightA = weights[tap];
    const weightB = tap + 1 <= kernelRadius ? weights[tap + 1] : 0.0;
    const pairWeight = (weightA + weightB) / normalization;
    const pairOffset = (weightA + weightB) > 0.0
      ? ((tap * weightA) + ((tap + 1) * weightB)) / (weightA + weightB)
      : tap;

    blurPairOffsets[pairCount] = pairOffset;
    blurPairWeights[pairCount] = pairWeight;
    pairCount += 1;
  }

  blurUniforms.uPairCount.value = pairCount;
}

function updateViewportMapping(rect) {
  const dpr = renderer.getPixelRatio();
  uniforms.viewport_x.value = rect.left * dpr;
  uniforms.viewport_y.value = rect.top * dpr;
  uniforms.viewport_w.value = Math.max(viewportPixelWidth, 1);
  uniforms.viewport_h.value = Math.max(viewportPixelHeight, 1);
}

function applyDragTransform() {
  frameEl.style.transform = `translate3d(${drag.x}px, ${drag.y}px, 0)`;
}

function updateResolution() {
  const rect = frameEl.getBoundingClientRect();
    const width = Math.max(rect.width, 1);
    const height = Math.max(rect.height, 1);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    updateRenderTargetSize();
    renderer.setSize(width, height, false);
    renderer.getDrawingBufferSize(drawingSize);

    uniforms.resolution_x.value = drawingSize.x;
    uniforms.resolution_y.value = drawingSize.y;
    uniforms.corner_radius.value = FIXED_STAGE_RADIUS_PX * renderer.getPixelRatio();
    updateViewportMapping(rect);
    resolutionEl.textContent = `resolution: ${Math.round(drawingSize.x)} x ${Math.round(drawingSize.y)}`;
}

function onDragStart(event) {
  if (event.button !== 0)
    return;

  drag.active = true;
  drag.pointerId = event.pointerId;
  drag.startX = event.clientX;
  drag.startY = event.clientY;
  drag.originX = drag.x;
  drag.originY = drag.y;

  frameEl.classList.add('is-dragging');
  frameEl.setPointerCapture(event.pointerId);
}

function onDragMove(event) {
  if (!drag.active || event.pointerId !== drag.pointerId)
    return;

  drag.x = drag.originX + (event.clientX - drag.startX);
  drag.y = drag.originY + (event.clientY - drag.startY);
  applyDragTransform();
  updateViewportMapping(frameEl.getBoundingClientRect());
}

function onDragEnd(event) {
  if (!drag.active || event.pointerId !== drag.pointerId)
    return;

  drag.active = false;
  drag.pointerId = null;
  frameEl.classList.remove('is-dragging');

  if (frameEl.hasPointerCapture(event.pointerId))
    frameEl.releasePointerCapture(event.pointerId);
}

frameEl.addEventListener('pointerdown', onDragStart);
frameEl.addEventListener('pointermove', onDragMove);
frameEl.addEventListener('pointerup', onDragEnd);
frameEl.addEventListener('pointercancel', onDragEnd);
window.addEventListener('blur', () => {
  drag.active = false;
  drag.pointerId = null;
  frameEl.classList.remove('is-dragging');
});
window.addEventListener('resize', updateResolution);
window.addEventListener('scroll', () => {
  updateViewportMapping(frameEl.getBoundingClientRect());
}, { passive: true });

new ResizeObserver(updateResolution).observe(frameEl);

function renderBackgroundBlur() {
  const blurStrength = Math.max(uniforms.blur_strength.value, 0.0);
  const blurRadiusPx = blurStrengthToRadiusPx(blurStrength);

  renderer.setRenderTarget(sharpTarget);
  renderer.render(backgroundScene, postCamera);

  if (blurRadiusPx < 0.25) {
    renderer.setRenderTarget(blurTarget);
    renderer.render(backgroundScene, postCamera);
    renderer.setRenderTarget(null);
    return;
  }

  rebuildGaussianKernel(blurRadiusPx);

  // Separable Gaussian blur pass: horizontal then vertical.
  blurUniforms.tInput.value = sharpTarget.texture;
  blurUniforms.uDirection.value.set(1.0, 0.0);
  renderer.setRenderTarget(blurTempTarget);
  renderer.render(blurScene, postCamera);

  blurUniforms.tInput.value = blurTempTarget.texture;
  blurUniforms.uDirection.value.set(0.0, 1.0);
  renderer.setRenderTarget(blurTarget);
  renderer.render(blurScene, postCamera);

  renderer.setRenderTarget(null);
}

function updateStageShadow() {
  const radius = uniforms.shadow_radius.value;
  const intensity = uniforms.shadow_intensity.value;
  frameEl.style.boxShadow = `
    inset 0 1px 0 rgba(255, 255, 255, 0.86),
    0 34px ${radius}px -35px rgba(3, 15, 24, ${intensity})
  `;
}

sliders.forEach(slider => {
    const key = slider.dataset.uniform;
    slider.addEventListener('input', event => {
    uniforms[key].value = Number.parseFloat(event.currentTarget.value);
    updateUniformSliderInfo(event.currentTarget);
    
    if (key === 'shadow_radius' || key === 'shadow_intensity') {
      updateStageShadow();
    }
    });
});

shapeSliders.forEach(slider => {
  const key = slider.dataset.shape;

  slider.addEventListener('input', event => {
    const nextValue = toPositivePx(event.currentTarget.value, 1);

    if (key === 'width')
      shapeState.widthPx = nextValue;
    else if (key === 'height')
      shapeState.heightPx = nextValue;

    rebuildShapeLimits();
    enforceShapeConstraints();
    syncShapeSliderUi();
    applyStageShape();
  });
});

syncShapeForCurrentImage();
setupUniformSliderInfo();
updateControlsVisibility();
updateStageShadow();

function renderLoop() {
  const rect = frameEl.getBoundingClientRect();
  updateViewportMapping(rect);

  renderBackgroundBlur();

  uniforms.pointer_x.value = -1000.0;
  uniforms.pointer_y.value = -1000.0;
  uniforms.intensity.value = 0.0;
  pointerEl.textContent = drag.active
    ? `drag: ${drag.x.toFixed(1)}, ${drag.y.toFixed(1)}`
    : `drag: ${drag.x.toFixed(1)}, ${drag.y.toFixed(1)}`;

    renderer.render(scene, camera);
    requestAnimationFrame(renderLoop);
}

requestAnimationFrame(renderLoop);
