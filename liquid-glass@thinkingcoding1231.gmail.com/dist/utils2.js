// utils.ts
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
/**
 * Looking Glassのピッカーを透過するClutter.Clone
 */
export const UnpickableClone = GObject.registerClass({
    GTypeName: 'LiquidGlassUnpickableClone',
}, class UnpickableClone extends Clutter.Clone {
    vfunc_pick(_pickContext) {
        // No-op
    }
});
/**
 * 自分自身と子要素すべてをLooking Glassのピッカーから透過するコンテナアクター
 * ※ St.WidgetのCSS余白干渉を排除するため、すべて純粋な Clutter.Actor を使用
 */
export const UnpickableActor = GObject.registerClass({
    GTypeName: 'LiquidGlassUnpickableActor',
}, class UnpickableActor extends Clutter.Actor {
    vfunc_pick(_pickContext) {
        // No-op
    }
});
/**
 * Looking Glassのピッカーを透過するSt.Widget
 */
export const UnpickableWidget = GObject.registerClass({
    GTypeName: 'LiquidGlassUnpickableWidget',
}, class UnpickableWidget extends St.Widget {
    vfunc_pick(_pickContext) {
        // No-op
    }
});
/**
 * 汎用UIレイヤーサンプラー
 */
export class UILayerSampler {
    _selfActor;
    _container;
    _extraExclusions;
    _selfRoot = null;
    _clones = new Map();
    constructor(selfActor, container, extraExclusions = []) {
        this._selfActor = selfActor;
        this._container = container;
        this._extraExclusions = new Set(extraExclusions);
        this._selfRoot = this._findUiGroupAncestor(selfActor);
    }
    _findUiGroupAncestor(actor) {
        const uiGroup = Main.layoutManager.uiGroup;
        let current = actor;
        while (current) {
            if (current.get_parent() === uiGroup)
                return current;
            current = current.get_parent();
        }
        return null;
    }
    rebindSelf() {
        this._selfRoot = this._findUiGroupAncestor(this._selfActor);
    }
    refresh() {
        if (!this._selfRoot)
            this._selfRoot = this._findUiGroupAncestor(this._selfActor);
        const uiGroup = Main.layoutManager.uiGroup;
        const children = uiGroup.get_children();
        const seen = new Set();
        for (const child of children) {
            if (child === this._selfActor || child === this._selfRoot)
                continue;
            if (child === Main.layoutManager._backgroundGroup)
                continue;
            if (this._extraExclusions.has(child))
                continue;
            if (!child.visible || !child.mapped)
                continue;
            seen.add(child);
            if (!this._clones.has(child)) {
                const clipper = new UnpickableActor();
                clipper.set_clip_to_allocation(true);
                clipper.set_name(`${child.name}-clipper`);
                // BMSのサンプリング座標系を正常化するためのFBO（キャンバス）を復活
                const wrapper = new UnpickableActor();
                wrapper.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
                wrapper.set_name(`${child.name}-wrapper`);
                clipper.add_child(wrapper);
                const sourceClone = new UnpickableClone({ source: child });
                wrapper.add_child(sourceClone);
                sourceClone.set_name(`${child.name}-sourceClone`);
                clipper._wrapper = wrapper;
                clipper._sourceClone = sourceClone;
                clipper.connect('destroy', () => {
                    this._clones.delete(child);
                });
                this._container.add_child(clipper);
                this._clones.set(child, clipper);
            }
        }
        for (const [actor, clipper] of this._clones) {
            if (!seen.has(actor)) {
                try {
                    clipper.destroy();
                }
                catch (_) { }
            }
        }
    }
    /**
     * ステージ座標 (stageX, stageY) をアクター actor のローカル座標に変換する。
     *
     * Clutter.Actor.transform_stage_point() を優先して使用する。
     * これはスケール・回転・平行移動を含むすべての祖先トランスフォームを正しく考慮する。
     * API が利用できない場合は get_transformed_position() による単純引き算にフォールバックする
     * （コンテナに変換がない場合のみ正確）。
     */
    static _stageToLocal(actor, stageX, stageY) {
        try {
            // transform_stage_point: ステージ座標 → actor ローカル座標（全トランスフォーム考慮）
            const res = actor.transform_stage_point(stageX, stageY);
            // GJS binding: [ok: boolean, x: number, y: number]
            if (Array.isArray(res) && res[0] === true) {
                return [res[1], res[2]];
            }
        }
        catch (_) { }
        // フォールバック: 平行移動のみのコンテナで有効
        try {
            const [cx, cy] = actor.get_transformed_position();
            return [
                stageX - (Number.isNaN(cx) ? 0 : cx),
                stageY - (Number.isNaN(cy) ? 0 : cy),
            ];
        }
        catch (_) {
            return [stageX, stageY];
        }
    }
    syncProperties(source, clipper, container, containerW = 0, containerH = 0) {
        if (!source || !clipper || !container)
            return;
        try {
            const [absX, absY] = source.get_transformed_position();
            const [w, h] = source.get_size();
            if (Number.isNaN(absX) || Number.isNaN(absY) || w <= 0 || h <= 0) {
                clipper.visible = false;
                return;
            }
            const scaleX = source.scale_x;
            const scaleY = source.scale_y;
            const scaledW = w * scaleX;
            const scaledH = h * scaleY;
            // Dockコンテナの絶対座標を取得
            const [contAbsX, contAbsY] = container.get_transformed_position();
            const cX = Number.isNaN(contAbsX) ? 0 : contAbsX;
            const cY = Number.isNaN(contAbsY) ? 0 : contAbsY;
            // clipper はコンテナサイズで固定し、枠外への描画漏れを防ぐ
            clipper.set_position(0, 0);
            clipper.set_size(containerW, containerH);
            clipper.opacity = source.opacity;
            const wrapper = clipper._wrapper;
            const sourceClone = clipper._sourceClone;
            if (wrapper && sourceClone) {
                const stage = global.stage;
                // 【最重要】wrapperの絶対座標が画面原点 (0, 0) になるように、コンテナの絶対座標分だけ逆オフセットする
                wrapper.set_position(-cX, -cY);
                wrapper.set_size(stage.width, stage.height);
                // sourceClone は画面原点 (0, 0) となった wrapper 内に置かれるため、本物の絶対座標をそのまま使う
                sourceClone.set_position(absX, absY);
                sourceClone.set_size(w, h);
                sourceClone.set_scale(scaleX, scaleY);
                const pX = source.pivot_point?.x ?? 0;
                const pY = source.pivot_point?.y ?? 0;
                sourceClone.set_pivot_point(pX, pY);
            }
            // 交差判定（カリング）用の相対座標計算（今まで通り）
            const [localX, localY] = UILayerSampler._stageToLocal(container, absX, absY);
            const isVisible = source.visible && source.mapped;
            if (isVisible && containerW > 0 && containerH > 0) {
                const isIntersecting = localX < containerW &&
                    (localX + scaledW) > 0 &&
                    localY < containerH &&
                    (localY + scaledH) > 0;
                clipper.visible = isIntersecting;
            }
            else {
                clipper.visible = isVisible;
            }
        }
        catch (_) { }
    }
    sync() {
        let contW = 0, contH = 0;
        try {
            const [cw, ch] = this._container.get_size();
            if (!Number.isNaN(cw))
                contW = cw;
            if (!Number.isNaN(ch))
                contH = ch;
        }
        catch (_) { }
        for (const [actor, clipper] of this._clones) {
            this.syncProperties(actor, clipper, this._container, contW, contH);
        }
    }
    destroy() {
        for (const [, clipper] of this._clones) {
            try {
                clipper.destroy();
            }
            catch (_) { }
        }
        this._clones.clear();
        this._selfRoot = null;
    }
}
