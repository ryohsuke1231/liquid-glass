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

        setRadius(radius: number) {
            this._radius = radius;
            this._updateShader();
        }

        _updateShader() {
            const shader = `
                uniform sampler2D cogl_sampler;
                uniform float radius;
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
                    vec2 b = resolution * 0.5;
                    
                    float d = sdRoundRect(p, b, radius);
                    
                    // INVERTED LOGIC: 
                    // alpha is 1.0 (visible) when OUTSIDE the rounded rect (d > 0)
                    // alpha is 0.0 (transparent) when INSIDE the rounded rect (d < 0)
                    float alpha = smoothstep(-0.5, 0.5, d);
                    
                    cogl_color_out = texture2D(cogl_sampler, st) * alpha * cogl_color_in;
                }
            `;
            this.set_shader_source(shader);
            this._updateUniforms();
        }

        _updateUniforms() {
            let actor = (this as any).get_actor();
            if (!actor) return;
            
            let w = actor.width;
            let h = actor.height;

            if (Number.isNaN(w) || Number.isNaN(h) || w <= 0 || h <= 0) return;
            
            let gval_r = new GObject.Value();
            gval_r.init(GObject.TYPE_FLOAT);
            gval_r.set_float(this._radius);
            this.set_uniform_value('radius', gval_r);

            let gval_w = new GObject.Value();
            gval_w.init(GObject.TYPE_FLOAT);
            gval_w.set_float(w);
            this.set_uniform_value('width', gval_w);

            let gval_h = new GObject.Value();
            gval_h.init(GObject.TYPE_FLOAT);
            gval_h.set_float(h);
            this.set_uniform_value('height', gval_h);
        }

        vfunc_paint_target(node: any, paint_context: any): void {
            this._updateUniforms();
            super.vfunc_paint_target(node, paint_context);
        }
    }
);
