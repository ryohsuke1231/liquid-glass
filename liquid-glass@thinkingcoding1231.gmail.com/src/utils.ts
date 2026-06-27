// utils.ts
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

/**
 * Looking Glassのピッカー（ヒットテスト）を透過するClutter.Clone
 */
export const UnpickableClone = GObject.registerClass(
  {
    GTypeName: 'LiquidGlassUnpickableClone',
  },
  class UnpickableClone extends Clutter.Clone {
    vfunc_pick(_pickContext: any): void {
      // No-op: このアクターへのヒットテストを完全にスルーする
    }
  }
);
/**
 * 自分自身と子要素すべてをLooking Glassのピッカーから透過するコンテナアクター
 */
export const UnpickableActor = GObject.registerClass(
  {
    GTypeName: 'LiquidGlassUnpickableActor',
  },
  class UnpickableActor extends Clutter.Actor {
    vfunc_pick(_pickContext: any): void {
      // No-op: 子要素も含めてヒットテストをスルーする
    }
  }
);

//Inverse rounded corners by overlaying the window corners with background actors
export const InverseCornerEffect = GObject.registerClass(
    {
        GTypeName: 'LiquidGlassInverseCornerEffect',
    },
    class InverseCornerEffect extends Clutter.ShaderEffect {
        private _radius: number = 0;
        private _inset: number = 0;

        setRadius(radius: number) {
            this._radius = radius;
            this._updateShader();
        }

        setInset(inset: number) {
            this._inset = inset;
            this._updateShader();
        }

        _updateShader() {
            const shader = `
                uniform sampler2D cogl_sampler;
                uniform float radius;
                uniform float inset;
                uniform float width;
                uniform float height;

                float sdRoundRect(vec2 p, vec2 b, float r) {
                    vec2 d = abs(p) - b + vec2(r);
                    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
                }

                void main() {
                    vec2 st = cogl_tex_coord_in[0].st;
                    vec2 resolution = vec2(width, height);
                    vec2 p = (st * resolution) - (resolution * 0.5);
                    vec2 innerHalf = max((resolution - vec2(inset * 2.0)) * 0.5, vec2(1.0));

                    float d = sdRoundRect(p, innerHalf, radius);

                    // Sharper transition for the corner cut to avoid dark fringes
                    float alpha = smoothstep(-0.5, 0.5, d);
                    
                    // Fade out at the very edges of the overlay actor to ensure it blends seamlessly
                    // with the background and hides any potential window shadow cutoff.
                    vec2 edgeDist = min(st, 1.0 - st) * resolution;
                    float edgeFade = smoothstep(0.0, 10.0, min(edgeDist.x, edgeDist.y));
                    alpha *= edgeFade;

                    cogl_color_out = texture2D(cogl_sampler, st) * alpha * cogl_color_in;
                }
            `;
            this.set_shader_source(shader);
            this._updateUniforms();
        }

        _setUniform(name: string, value: number) {
            let gval = new GObject.Value();
            gval.init(GObject.TYPE_FLOAT);
            gval.set_float(value);
            this.set_uniform_value(name, gval);
        }

        _updateUniforms() {
            let actor = (this as any).get_actor();
            if (!actor) return;

            let w = actor.width;
            let h = actor.height;

            if (Number.isNaN(w) || Number.isNaN(h) || w <= 0 || h <= 0) return;

            this._setUniform('radius', this._radius);
            this._setUniform('inset', this._inset);
            this._setUniform('width', w);
            this._setUniform('height', h);
        }

        vfunc_paint_target(node: any, paint_context: any): void {
            this._updateUniforms();
            super.vfunc_paint_target(node, paint_context);
        }
    }
);

/**
 * Safe helper to retrieve window actors, compatible with GNOME Shell pre-48 and 48+ (GNOME 50)
 * Ayudante seguro para obtener los actores de ventanas, compatible con versiones anteriores y posteriores a GNOME 48 (GNOME 50)
 */
export function getWindowActors(): any[] {
    if (global.compositor && typeof (global.compositor as any).get_window_actors === 'function') {
        return (global.compositor as any).get_window_actors();
    }
    if (typeof (global as any).get_window_actors === 'function') {
        return (global as any).get_window_actors();
    }
    return [];
}

/**
 * Safe helper to check if a Clutter Actor (GObject) is still valid and not disposed.
 * Ayudante seguro para comprobar si un actor de Clutter (GObject) sigue siendo válido y no ha sido destruido.
 */
export function isActorValid(actor: any): boolean {
    if (!actor) return false;
    try {
        let _v = actor.visible;
        return true;
    } catch (e) {
        return false;
    }
}

