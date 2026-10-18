import type Gio from 'gi://Gio';
import Cogl from 'gi://Cogl';

import type { Logger } from '../logger.js';
import { MaterialSettings } from './material.js';
import { BlurRenderer, type BlurMethod } from './blur.js';
import { ShaderPipelines, configureSamplerLayer, SHAPE_LAYER } from './pipelines.js';
import { GlassGeometry } from './geometry.js';
import { UniformState } from './uniforms.js';
import { RenderPasses } from './passes.js';

// Must match glass.frag's `#define MAX_GLASS_REGIONS 16`.
export const MAX_GLASS_REGIONS = 16;

export interface GlassRegion {
  x: number; y: number; w: number; h: number;
  tintR: number; tintG: number; tintB: number;
  baseStrength?: number;
}

/**
 * What every glass draws with, whatever supplies its backdrop: the shader
 * pipelines, the blur, the uniforms and the settings bound to them. The owner
 * decides when to repaint (`repaint` is called when a uniform changed) and
 * where the backdrop texture comes from.
 */
export class GlassRenderer {
  readonly passes: RenderPasses;
  readonly pipelines: ShaderPipelines;
  readonly blur: BlurRenderer;
  readonly uniforms: UniformState;
  readonly geometry: GlassGeometry;
  readonly material: MaterialSettings;

  private _repaint: () => void;
  private _shapeTexture: Cogl.Texture | null = null;

  constructor(params: {
    settings?: Gio.Settings,
    logger?: Logger,
    repaint: () => void,
    setDiagnostics: (enabled: boolean) => void,
    shapeTexture?: boolean,
  }) {
    this._repaint = params.repaint;
    this.passes = new RenderPasses();
    this.pipelines = new ShaderPipelines(params.logger, params.shapeTexture ?? false);
    this.blur = new BlurRenderer(this.pipelines, this.passes, () => this._repaint());
    this.uniforms = new UniformState();
    this.geometry = new GlassGeometry(this.uniforms.values);
    this.material = new MaterialSettings(params.settings, this.uniforms, this.blur, params.setDiagnostics,
      () => this._repaintIfDirty());
    this.material.initialize();
  }

  // Compiles the pipelines on the first paint, once a Cogl context exists,
  // and a tap-count change from setBlurRadius() afterwards.
  prepare(ctx: Cogl.Context): void {
    if (!this.pipelines.composite) {
      this.pipelines.initialize(ctx);
      this.uniforms.attach(this.pipelines.composite);
    }
    if (this.blur.needsCompile)
      this.blur.compilePending(ctx);
  }

  /**
   * Binds the backdrop for glass.frag: the blurred one, or `unblurredTex`
   * when there is no blur. Both hold `blurRect`, the part of the glass the
   * backdrop was copied for, in shader space.
   */
  bindBackdrop(unblurredTex: Cogl.Texture, blurRect: number[]): void {
    const compPipeline = this.pipelines.composite!;
    const haveBlur = this.blur.passCount > 0 && this.blur.result !== null;

    this.uniforms.set('blur_rect_x', blurRect[0]);
    this.uniforms.set('blur_rect_y', blurRect[1]);
    this.uniforms.set('blur_rect_w', blurRect[2]);
    this.uniforms.set('blur_rect_h', blurRect[3]);
    // Both layers get the same texture, so one UV range fits both. glass.frag
    // samples only layer 1; if it ever read layer 0 separately, the layers
    // would need their own ranges.
    const layerTex = haveBlur ? this.blur.result! : unblurredTex;
    // The blur is magnified from half or quarter resolution; glass.frag needs
    // its real size to reconstruct it smoothly.
    this.uniforms.set('blur_tex_w', layerTex.get_width());
    this.uniforms.set('blur_tex_h', layerTex.get_height());
    compPipeline.set_layer_texture(0, layerTex);
    configureSamplerLayer(compPipeline, 0);
    compPipeline.set_layer_texture(1, layerTex);
    configureSamplerLayer(compPipeline, 1);
    if (this._shapeTexture) {
      compPipeline.set_layer_texture(SHAPE_LAYER, this._shapeTexture);
      configureSamplerLayer(compPipeline, SHAPE_LAYER);
    }

    // Uniforms set before the pipeline existed are written now.
    this.uniforms.flush();
  }

  /**
   * Queues glass.frag over `drawRect` [x1, y1, x2, y2]. glass.frag multiplies
   * its premultiplied output by the pipeline color, so fading means scaling
   * all four channels by the paint opacity (which already includes the
   * ancestors'); scaling alpha alone would wash the glass out.
   */
  addComposite(node: any, drawRect: number[], drawUV: number[], paintOpacity: number): void {
    const color = new Cogl.Color();
    const opacity = paintOpacity / 255;
    color.init_from_4f(opacity, opacity, opacity, opacity);
    this.pipelines.composite!.set_color(color);
    this.passes.composite(node, this.pipelines.composite!, drawRect, drawUV);
  }

  // Rebuilds the pipelines on the next paint, for shader development. The
  // buffered uniforms are kept and re-applied to the new pipeline.
  reloadShaders(): void {
    this.pipelines.clear();
    this.uniforms.attach(null);
    this.blur.reload();
    this._repaint();
  }

  cleanup(): void {
    this._shapeTexture = null;
    this.material.clear();
    // Dropping the references frees the textures and pipelines; GJS owns them.
    this.blur.clear();
    this.passes.clear();
    this.pipelines.clear();
    this.uniforms.clear();
  }

  private _repaintIfDirty(): void {
    if (this.uniforms.takeDirty()) this._repaint();
  }

  getResolution(): [number, number] {
    return [
      this.uniforms.values.get('resolution_x') ?? 0,
      this.uniforms.values.get('resolution_y') ?? 0,
    ];
  }

  setBlurRectEnabled(enabled: boolean): void {
    this.geometry.blurEnabled = enabled;
    // The pool is sized for the old rect.
    this.blur.invalidate();
    this._repaint();
  }

  setCompositeRectEnabled(enabled: boolean): void {
    this.geometry.compositeEnabled = enabled;
    this._repaint();
  }

  setEdgeTapsEnabled(enabled: boolean): void {
    this.uniforms.set('edge_taps_enabled', enabled ? 1.0 : 0.0);
    this._repaintIfDirty();
  }

  setEarlyExitEnabled(enabled: boolean): void {
    this.uniforms.set('early_exit_enabled', enabled ? 1.0 : 0.0);
    this._repaintIfDirty();
  }

  setDebugView(mode: number): void {
    this.uniforms.set('debug_view', mode);
    this._repaintIfDirty();
  }

  setIsDock(isDock: boolean): void {
    this.uniforms.set('isDock', isDock ? 1.0 : 0.0);
  }

  setSurfaceLightEnabled(enabled: boolean): void {
    this.uniforms.set('surface_light_enabled', enabled ? 1.0 : 0.0);
    this._repaintIfDirty();
  }

  setCornerSmoothingEnabled(enabled: boolean): void {
    this.uniforms.set('corner_smoothing_enabled', enabled ? 1.0 : 0.0);
    this._repaintIfDirty();
  }

  setPadding(pad: number): void {
    this.uniforms.set('padding', pad);
  }

  setShadowMaxRadius(radius: number): void {
    this.uniforms.set('shadow_max_radius', radius);
  }

  setBlurMethod(method: BlurMethod): void {
    this.blur.setBlurMethod(method);
  }

  setBlurRadius(radius: number): void {
    this.blur.setBlurRadius(radius);
  }

  setTintColor(r: number, g: number, b: number): void {
    this.uniforms.set('tint_r', r);
    this.uniforms.set('tint_g', g);
    this.uniforms.set('tint_b', b);
    this._repaintIfDirty();
  }

  setTintStrength(strength: number): void {
    this.uniforms.set('tint_strength', strength);
    this._repaintIfDirty();
  }

  setCornerRadius(radius: number): void {
    this.uniforms.set('corner_radius', radius);
    this._repaintIfDirty();
  }

  setAnimationScale(scale: number): void {
    if (this.material.setAnimationScale(scale)) this._repaintIfDirty();
  }

  setResolution(width: number, height: number): void {
    this.uniforms.set('resolution_x', width);
    this.uniforms.set('resolution_y', height);
    this._repaintIfDirty();
  }

  setGlassGeometry(x: number, y: number, w: number, h: number): void {
    this.uniforms.set('dock_x', x);
    this.uniforms.set('dock_y', y);
    this.uniforms.set('dock_w', w);
    this.uniforms.set('dock_h', h);
    this.geometry.rect[0] = x;
    this.geometry.rect[1] = y;
    this.geometry.rect[2] = w;
    this.geometry.rect[3] = h;
    this._repaintIfDirty();
  }

  /**
   * The distance field a shape-texture glass takes its outline from: it covers
   * the glass rect, holds `range` px each way, and the lens rises over `band`
   * px from the edge.
   */
  setShapeTexture(texture: Cogl.Texture | null, range: number, band: number): void {
    this._shapeTexture = texture;
    this.uniforms.set('shape_range', range);
    this.uniforms.set('shape_band', band);
    this.uniforms.takeDirty();
    this._repaint();
  }

  setMultiRegionMode(enabled: boolean): void {
    this.uniforms.set('multi_region_mode', enabled ? 1.0 : 0.0);
    this.geometry.multiRegion = enabled;
    this._repaintIfDirty();
  }

  setGlassRegions(regions: GlassRegion[]): void {
    const clamped = regions.slice(0, MAX_GLASS_REGIONS);

    const rx = Array.from({ length: MAX_GLASS_REGIONS }, () => 0.0);
    const ry = Array.from({ length: MAX_GLASS_REGIONS }, () => 0.0);
    const rw = Array.from({ length: MAX_GLASS_REGIONS }, () => 0.0);
    const rh = Array.from({ length: MAX_GLASS_REGIONS }, () => 0.0);
    const rTintR = Array.from({ length: MAX_GLASS_REGIONS }, () => 1.0);
    const rTintG = Array.from({ length: MAX_GLASS_REGIONS }, () => 1.0);
    const rTintB = Array.from({ length: MAX_GLASS_REGIONS }, () => 1.0);
    const rBaseStrength = Array.from({ length: MAX_GLASS_REGIONS }, () => 0.0);

    clamped.forEach((region, i) => {
      rx[i] = region.x;
      ry[i] = region.y;
      rw[i] = region.w;
      rh[i] = region.h;
      rTintR[i] = region.tintR;
      rTintG[i] = region.tintG;
      rTintB[i] = region.tintB;
      rBaseStrength[i] = Math.max(0.0, Math.min(1.0, region.baseStrength ?? 0.0));
    });

    this.geometry.regions = clamped.map(r => [r.x, r.y, r.w, r.h]);

    this.uniforms.set('region_count', clamped.length);
    this.uniforms.setArray('region_x', rx);
    this.uniforms.setArray('region_y', ry);
    this.uniforms.setArray('region_w', rw);
    this.uniforms.setArray('region_h', rh);
    this.uniforms.setArray('region_tint_r', rTintR);
    this.uniforms.setArray('region_tint_g', rTintG);
    this.uniforms.setArray('region_tint_b', rTintB);
    this.uniforms.setArray('region_base_strength', rBaseStrength);
    this._repaintIfDirty();
  }

  setBrightness(brightness: number): void {
    this.uniforms.set('brightness', brightness);
    this._repaintIfDirty();
  }

  setContrast(contrast: number): void {
    this.uniforms.set('contrast', contrast);
    this._repaintIfDirty();
  }

  setSaturation(saturation: number): void {
    this.uniforms.set('saturation', saturation);
    this._repaintIfDirty();
  }
}
