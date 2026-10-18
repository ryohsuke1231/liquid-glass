export class MaterialSettings {
    _settings;
    _uniforms;
    _blur;
    _setDiagnostics;
    _repaintIfDirty;
    _settingsIds = [];
    constructor(_settings, _uniforms, _blur, _setDiagnostics, _repaintIfDirty) {
        this._settings = _settings;
        this._uniforms = _uniforms;
        this._blur = _blur;
        this._setDiagnostics = _setDiagnostics;
        this._repaintIfDirty = _repaintIfDirty;
    }
    initialize() {
        // Buffered until the pipeline exists.
        this._uniforms.set('resolution_x', 0.0);
        this._uniforms.set('resolution_y', 0.0);
        this._uniforms.set('corner_radius', 60.0);
        this._uniforms.set('brightness', 1.0);
        this._uniforms.set('contrast', 1.0);
        this._uniforms.set('saturation', 1.0);
        this._uniforms.set('padding', 20.0);
        // How far the drop shadow can extend before the glass actor's clip,
        // unlike the small optical 'padding'. The managers set the real value.
        this._uniforms.set('shadow_max_radius', 180.0);
        this._uniforms.set('isDock', 0.0);
        // Rim, specular and sheen highlights. Application windows turn them off
        // and keep only the drop shadow and the inner AO.
        this._uniforms.set('surface_light_enabled', 1.0);
        // Application windows turn continuous corners off to match the window.
        this._uniforms.set('corner_smoothing_enabled', 1.0);
        // Where the glass sits inside the actor, which for the UI glass covers
        // the monitor.
        this._uniforms.set('dock_x', 0.0);
        this._uniforms.set('dock_y', 0.0);
        this._uniforms.set('dock_w', 0.0);
        this._uniforms.set('dock_h', 0.0);
        // One glass per region, for Quick Settings' toggle-button mode.
        this._uniforms.set('multi_region_mode', 0.0);
        this._uniforms.set('region_count', 0.0);
        // An unset uniform reads 0.0, which would disable these.
        this._uniforms.set('early_exit_enabled', 1.0);
        this._uniforms.set('debug_view', 0.0);
        // Zero means the whole actor until the paint path computes the rect.
        this._uniforms.set('blur_rect_x', 0.0);
        this._uniforms.set('blur_rect_y', 0.0);
        this._uniforms.set('blur_rect_w', 0.0);
        this._uniforms.set('blur_rect_h', 0.0);
        // Set on every paint, once layer 1's size is known.
        this._uniforms.set('blur_tex_w', 0.0);
        this._uniforms.set('blur_tex_h', 0.0);
        this._uniforms.set('edge_taps_enabled', 1.0);
        this._settingsIds = [];
        if (this._settings) {
            this._bindSettings();
        }
        else {
            // Without settings, the schema's defaults.
            this._uniforms.set('max_z', 88.0);
            this._uniforms.set('displacement_scale', 10.5);
            this._uniforms.set('edge_smoothing', 0.5);
            this._uniforms.set('profile_shape_n', 3.6);
            this._uniforms.set('ior', 2.40);
            this._uniforms.set('chroma_strength', 0.0);
            this._uniforms.set('corner_smoothing', 0.6);
            this._uniforms.set('highlight_backdrop_color', 1.0);
            this._uniforms.set('specular_intensity', 0.0);
            this._uniforms.set('shininess', 42.0);
            this._uniforms.set('rim_width', 2.3);
            this._uniforms.set('rim_intensity', 0.5);
            this._uniforms.set('rim_directional_power', 1.9);
            this._uniforms.set('rim_power', 3.0);
            this._uniforms.set('rim_light_color_intensity', 1.0);
            this._uniforms.set('sheen_intensity', 0.0);
            this._uniforms.set('light_angle_deg', 90.0);
            this._uniforms.set('shadow_radius', 50.0);
            this._uniforms.set('shadow_intensity', 0.22);
            this._uniforms.set('ao_intensity', 0.65);
            this._uniforms.set('ao_radius', 1.0);
            this._uniforms.set('tint_strength', 0.0);
            this._uniforms.set('tint_r', 1.0);
            this._uniforms.set('tint_g', 1.0);
            this._uniforms.set('tint_b', 1.0);
        }
    }
    clear() {
        if (this._settings)
            this._settingsIds.forEach(id => this._settings?.disconnect(id));
        this._settingsIds = [];
    }
    _bindSettings() {
        const mappings = [
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
            { key: 'glass-ao-intensity', uniform: 'ao_intensity' },
            { key: 'glass-ao-radius', uniform: 'ao_radius' },
            { key: 'glass-corner-smoothing', uniform: 'corner_smoothing' },
        ];
        const settings = this._settings;
        if (!settings)
            return;
        mappings.forEach(map => {
            this._uniforms.set(map.uniform, settings.get_double(map.key));
            // Without a repaint only the parts of the glass that something else
            // damaged would pick up the new value.
            const id = settings.connect(`changed::${map.key}`, () => {
                this._uniforms.set(map.uniform, settings.get_double(map.key));
                this._repaintIfDirty();
            });
            this._settingsIds.push(id);
        });
        const applyBackdropHighlights = () => {
            this._uniforms.set('highlight_backdrop_color', settings.get_boolean('glass-backdrop-highlights') ? 1.0 : 0.0);
        };
        applyBackdropHighlights();
        const highlightsId = settings.connect('changed::glass-backdrop-highlights', () => {
            applyBackdropHighlights();
            this._repaintIfDirty();
        });
        this._settingsIds.push(highlightsId);
        // 2 = half resolution, 4 = quarter. Read before blur-method, since the
        // Gaussian kernel is expressed in texels of that level.
        const applyDownscale = () => {
            const factor = settings.get_int('glass-blur-downscale') >= 4 ? 4 : 2;
            this._blur.setDownscale(factor);
        };
        applyDownscale();
        const downscaleId = settings.connect('changed::glass-blur-downscale', applyDownscale);
        this._settingsIds.push(downscaleId);
        // 0 = Gaussian, 1 = Dual Kawase.
        const applyBlurMethod = () => {
            const raw = settings.get_int('blur-method');
            this._blur.setBlurMethod(raw === 0 ? 0 : 1);
        };
        applyBlurMethod();
        const blurMethodId = settings.connect('changed::blur-method', applyBlurMethod);
        this._settingsIds.push(blurMethodId);
        // Cached, so the paint path does not query GSettings.
        const applyDiagFlag = () => {
            this._setDiagnostics(settings.get_boolean('glass-debug-diagnostics'));
        };
        applyDiagFlag();
        const diagId = settings.connect('changed::glass-debug-diagnostics', applyDiagFlag);
        this._settingsIds.push(diagId);
    }
    setAnimationScale(scale) {
        const settings = this._settings;
        if (!settings)
            return false;
        this._uniforms.set('displacement_scale', settings.get_double('glass-displacement-scale') * scale);
        this._uniforms.set('max_z', settings.get_double('glass-max-z') * scale);
        // The color separation is a fraction of the displacement, so it already
        // scales with it.
        return true;
    }
}
