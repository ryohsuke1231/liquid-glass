import type Gio from 'gi://Gio';
import type { UniformState } from './uniforms.js';
import type { BlurRenderer } from './blur.js';

/** Owns material defaults, settings subscriptions and animation-scaled optics. */
export class MaterialSettings {
  private _settingsIds: number[] = [];

  constructor(
    private _settings: Gio.Settings | undefined, private _uniforms: UniformState,
    private _blur: BlurRenderer, private _setDiagnostics: (enabled: boolean) => void,
  ) {}

  initialize(): void {
    // ── Default values for the composite shader's uniforms ──
    // The pipeline doesn't exist yet at this point, so these are buffered
    // into _pendingUniforms and applied once the pipeline is created.

    this._uniforms.set('resolution_x', 0.0);
    this._uniforms.set('resolution_y', 0.0);
    this._uniforms.set('pointer_x', -100.0);
    this._uniforms.set('pointer_y', -100.0);
    this._uniforms.set('intensity', 0.0);
    this._uniforms.set('corner_radius', 60.0);
    this._uniforms.set('brightness', 1.0);
    this._uniforms.set('contrast', 1.0);
    this._uniforms.set('saturation', 1.0);
    this._uniforms.set('padding', 20.0);
    // Distinct from the small optical 'padding' uniform (20px, only
    // meant to give the refraction/blur shader room past the actor's strict
    // bounds). shadow_max_radius instead reflects how much room the drop
    // shadow actually has to render outward before it would run into the
    // bgActor's own clip in dockManager.ts (CLIP_PADDING). Previously the
    // shader reused 'padding' for this, capping shadow_radius at ~18px no
    // matter how high the 0-100 prefs.js slider was set. Overwritten by
    // setShadowMaxRadius() once dockManager starts syncing geometry; this
    // default only matters before the first sync.
    this._uniforms.set('shadow_max_radius', 180.0);
    this._uniforms.set('isDock', 0.0);
    // Rim/specular/sheen "glass surface glint" terms, gated together by
    // setSurfaceLightEnabled(). Defaults to enabled (1.0) so dock/menu/
    // notification/quick-settings/osd — which never call the setter — keep
    // their existing look unchanged. applicationManager.ts turns this off
    // for application windows, which should only show the outer drop
    // shadow and the inner AO darkening (both already independent of this
    // uniform — see the addedLight gating in glass.frag), not the
    // dock-style rim/specular/sheen highlight.
    this._uniforms.set('surface_light_enabled', 1.0);

    // Full-screen FBO mode: lets the shader know where the dock sits.
    this._uniforms.set('dock_x', 0.0);
    this._uniforms.set('dock_y', 0.0);
    this._uniforms.set('dock_w', 0.0);
    this._uniforms.set('dock_h', 0.0);

    // Multi-region compositing (Quick Settings "Toggles" apply-to mode).
    // Disabled by default so every other consumer (dock, menu, notification,
    // OSD, application, and Quick Settings' own "Background" mode) is
    // completely unaffected. See setMultiRegionMode()/setGlassRegions().
    this._uniforms.set('multi_region_mode', 0.0);
    this._uniforms.set('region_count', 0.0);

    // [PERF/DEBUG] An unset Cogl uniform reads 0.0, which would turn the two
    // early exits in glass.frag OFF. Seed it explicitly; global._lgGlass
    // .earlyExit(false) is the A/B switch.
    this._uniforms.set('early_exit_enabled', 1.0);
    this._uniforms.set('debug_view', 0.0);

    // [PERF] "Blur the whole actor" until the paint path computes a real
    // rect — see glass.frag's blur_rect_* uniforms.
    this._uniforms.set('blur_rect_x', 0.0);
    this._uniforms.set('blur_rect_y', 0.0);
    this._uniforms.set('blur_rect_w', 0.0);
    this._uniforms.set('blur_rect_h', 0.0);

    this._settingsIds = [];
    if (this._settings) {
      this._bindSettings();
    } else {
      // Fallback defaults used when no GSettings schema is available.
      this._uniforms.set('max_z', 25.0);
      this._uniforms.set('displacement_scale', 78.5);
      this._uniforms.set('edge_smoothing', 2.0);
      this._uniforms.set('profile_shape_n', 7.0);
      this._uniforms.set('ior', 2.40);
      this._uniforms.set('chroma_strength', 0.006);
      this._uniforms.set('specular_intensity', 0.0);
      this._uniforms.set('shininess', 42.0);
      this._uniforms.set('rim_width', 5.0);
      this._uniforms.set('rim_intensity', 0.6);
      this._uniforms.set('rim_directional_power', 2.7);
      this._uniforms.set('rim_power', 6.0);
      this._uniforms.set('rim_light_color_intensity', 1.4);
      this._uniforms.set('sheen_intensity', 0.32);
      this._uniforms.set('light_angle_deg', 0.0);
      this._uniforms.set('shadow_radius', 8.0);
      this._uniforms.set('shadow_intensity', 0.55);
      // Inner edge AO darkening (independent of rim_width/shadow_radius).
      // ~7.5px matches the old rim_width*1.5-derived falloff at the default
      // rim_width of 5.0, so the look is unchanged until the user retunes it.
      this._uniforms.set('ao_intensity', 0.25);
      this._uniforms.set('ao_radius', 7.5);
      this._uniforms.set('tint_strength', 0.0);
      this._uniforms.set('tint_r', 1.0);
      this._uniforms.set('tint_g', 1.0);
      this._uniforms.set('tint_b', 1.0);
    }
  }

  clear(): void {
    if (this._settings) this._settingsIds.forEach(id => this._settings?.disconnect(id));
    this._settingsIds = [];
  }


  // ─── GSettings bindings ───────────────────────────────────────────────────────

  private _bindSettings(): void {
    const mappings: { key: string; uniform: string }[] = [
      { key: 'glass-max-z', uniform: 'max_z' },
      { key: 'glass-displacement-scale', uniform: 'displacement_scale' },
      { key: 'glass-edge-smoothing', uniform: 'edge_smoothing' },
      { key: 'glass-profile-shape-n', uniform: 'profile_shape_n' },
      { key: 'glass-ior', uniform: 'ior' },
      { key: 'glass-chroma-strength', uniform: 'chroma_strength' },
      { key: 'glass-specular-intensity', uniform: 'specular_intensity' },
      { key: 'glass-shininess', uniform: 'shininess' },
      { key: 'glass-rim-width', uniform: 'rim_width' },
      { key: 'glass-rim-intensity', uniform: 'rim_intensity' },
      { key: 'glass-rim-directional-power', uniform: 'rim_directional_power' },
      { key: 'glass-rim-power', uniform: 'rim_power' },
      { key: 'glass-rim-light-color-intensity', uniform: 'rim_light_color_intensity' },
      { key: 'glass-sheen-intensity', uniform: 'sheen_intensity' },
      { key: 'glass-light-angle-deg', uniform: 'light_angle_deg' },
      { key: 'shadow-radius', uniform: 'shadow_radius' },
      { key: 'shadow-intensity', uniform: 'shadow_intensity' },
      // Inner edge AO darkening — independent of rim_width and of the
      // outer drop shadow's radius/intensity pair above.
      { key: 'glass-ao-intensity', uniform: 'ao_intensity' },
      { key: 'glass-ao-radius', uniform: 'ao_radius' },
    ];

    const settings = this._settings;
    if (!settings) return;

    mappings.forEach(map => {
      // Apply the initial value.
      this._uniforms.set(map.uniform, settings.get_double(map.key));
      // Watch for changes.
      const id = settings.connect(`changed::${map.key}`, () => {
        this._uniforms.set(map.uniform, settings.get_double(map.key));
      });
      this._settingsIds.push(id);
    });

    // ── glass-blur-downscale (int): 2 = half res, 4 = quarter res ─────────
    // [PERF] A quality/cost trade the user opts into: the blur runs on a
    // quarter-size buffer, so every pass touches a quarter of the pixels, at
    // the cost of a visibly coarser blur. Read before blur-method below,
    // because the Gaussian kernel is expressed in texels of the level this
    // chooses.
    const applyDownscale = () => {
      const factor = settings.get_int('glass-blur-downscale') >= 4 ? 4 : 2;
      this._blur.setDownscale(factor);
    };
    applyDownscale();
    const downscaleId = settings.connect('changed::glass-blur-downscale', applyDownscale);
    this._settingsIds.push(downscaleId);

    // ── blur-method (int): 0 = Gaussian, 1 = Dual Kawase ──────────────────
    // Assumes the GSettings schema defines this key as an int.
    const applyBlurMethod = () => {
      const raw = settings.get_int('blur-method');
      this._blur.setBlurMethod(raw === 0 ? 0 : 1);
    };
    applyBlurMethod();
    const blurMethodId = settings.connect('changed::blur-method', applyBlurMethod);
    this._settingsIds.push(blurMethodId);

    // ── glass-debug-diagnostics (bool) ────────────────────────────────────
    // Read into a plain field rather than calling get_boolean() from the
    // paint path: that call is a GSettings lookup, which is exactly the kind
    // of per-paint cost this flag exists to remove.
    const applyDiagFlag = () => {
      this._setDiagnostics(settings.get_boolean('glass-debug-diagnostics'));
    };
    applyDiagFlag();
    const diagId = settings.connect('changed::glass-debug-diagnostics', applyDiagFlag);
    this._settingsIds.push(diagId);
  }

  setAnimationScale(scale: number): boolean {
    const settings = this._settings;
    if (!settings) return false;
    this._uniforms.set('displacement_scale',
      settings.get_double('glass-displacement-scale') * scale);
    this._uniforms.set('max_z',
      settings.get_double('glass-max-z') * scale);
    this._uniforms.set('chroma_strength',
      settings.get_double('glass-chroma-strength') * scale);
    return true;
  }
}
