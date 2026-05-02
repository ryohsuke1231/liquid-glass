// src/liquidEffect.js
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

// Register the custom shader effect class with GObject system.
export const LiquidEffect = GObject.registerClass({
    GTypeName: 'LiquidGlassEffect',
}, class LiquidEffect extends Clutter.ShaderEffect {
    
    _init(params = {}) {
        let extensionPath = params.extensionPath;
        delete params.extensionPath;
        
        super._init(params);
        
        this._extensionPath = extensionPath;
        
        console.log(`[Liquid Glass] Initing LiquidEffect. path: ${this._extensionPath}`);

        this._loadShader();

        // Initialize shader uniform variables.
        // These serve as default fallbacks until real values are supplied.
        this._setFloat('resolution_x', 0.0);
        this._setFloat('resolution_y', 0.0);
        this._setFloat('pointer_x', -100.0);
        this._setFloat('pointer_y', -100.0);
        this._setFloat('intensity', 0.0);
        
        // Matches the CSS border-radius value to ensure the glass perfectly covers the UI.
        this._setFloat('corner_radius', 60.0); 

        // Parameters controlling the physical appearance of the glass.
        // These are synchronized with standard PBR/Three.js material defaults.
        this._setFloat('max_z', 25.0);
        this._setFloat('displacement_scale', 78.5);
        this._setFloat('edge_smoothing', 2.0);
        this._setFloat('profile_shape_n', 7.0);
        this._setFloat('ior', 2.40); // Index of Refraction (glass is typically around 1.5 - 2.4)
        this._setFloat('chroma_strength', 0.006); // Chromatic aberration
        this._setFloat('blur_strength', 0.30);
        this._setFloat('tint_strength', 0.30);
        this._setFloat('tint_r', 1.0);
        this._setFloat('tint_g', 1.0);
        this._setFloat('tint_b', 1.0);
        this._setFloat('specular_intensity', 0.0);
        this._setFloat('rim_width', 5.0);
        this._setFloat('rim_intensity', 0.6);
        this._setFloat('rim_directional_power', 2.7);
        this._setFloat('rim_power', 6.0);
        this._setFloat('rim_light_color_intensity', 1.4);
        this._setFloat('sheen_intensity', 0.32);
        this._setFloat('shininess', 42.0);
        this._setFloat('light_angle_deg', 50.0);
        this._setFloat('mouse_radius', 280.0);
        this._setFloat('bg_glow_intensity', 0.0);
        this._setFloat('shadow_radius', 150.0);
        this._setFloat('shadow_intensity', 0.50);
        this._setFloat('padding', 20.0);
        this._setFloat('isDock', 0.0);
    }

    // Helper method to safely pass float values to the GLSL shader.
    _setFloat(name, value) {
        let gval = new GObject.Value();
        gval.init(GObject.TYPE_FLOAT);
        gval.set_float(value);
        this.set_uniform_value(name, gval);
    }

    setIsDock(isDock) {
        this._setFloat('isDock', isDock ? 1.0 : 0.0);
    }

    setPadding(pad) {
        this._setFloat('padding', pad);
    }

    setTintColor(r, g, b) {
        // RGB values normalized between 0.0 and 1.0
        this._setFloat('tint_r', r);
        this._setFloat('tint_g', g);
        this._setFloat('tint_b', b);
    }

    setTintStrength(strength) {
        // Controls the opacity of the tint color (0.0 to 1.0)
        this._setFloat('tint_strength', strength);
    }

    setCornerRadius(radius) {
        this._setFloat('corner_radius', radius);
    }

    setAnimationScale(scale) {
        // UIのスケールに合わせて、物理的な厚みや屈折の距離も比例して小さくする
        this._setFloat('displacement_scale', 78.5 * scale);
        this._setFloat('max_z', 25.0 * scale);
        this._setFloat('chroma_strength', 0.006 * scale); // 色収差もスケールに合わせる
    }

    // Loads the GLSL fragment shader file from the disk.
    _loadShader() {
        let shaderPath = this._extensionPath + '/shaders/glass.frag';
        let file = Gio.File.new_for_path(shaderPath);
        let [success, contents] = file.load_contents(null);

        if (success) {
            let shaderCode = new TextDecoder('utf-8').decode(contents);
            this.set_shader_source(shaderCode);
        } else {
            console.error('[Liquid Glass] Failed to load shader!');
        }
    }

    setPointerPosition(x, y, intensity) {
        this._setFloat('pointer_x', x);
        this._setFloat('pointer_y', y);
        this._setFloat('intensity', intensity);
    }

    // Synchronizes the exact actor dimensions with the shader's internal canvas.
    setResolution(width, height) {
        this._setFloat('resolution_x', width);
        this._setFloat('resolution_y', height);
    }

});