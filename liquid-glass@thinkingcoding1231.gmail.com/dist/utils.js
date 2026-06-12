// utils.ts
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
/**
 * Looking Glassのピッカーを透過するClutter.Clone
 */
export const UnpickableClone = GObject.registerClass(class UnpickableClone extends Clutter.Clone {
    vfunc_pick(_pickContext) {
        // No-op
    }
});
/**
 * 自分自身と子要素すべてをLooking Glassのピッカーから透過するコンテナアクター
 * ※ St.WidgetのCSS余白干渉を排除するため、すべて純粋な Clutter.Actor を使用
 */
export const UnpickableActor = GObject.registerClass(class UnpickableActor extends Clutter.Actor {
    vfunc_pick(_pickContext) {
        // No-op
    }
});
/**
 * Looking Glassのピッカーを透過するSt.Widget
 */
export const UnpickableWidget = GObject.registerClass(class UnpickableWidget extends St.Widget {
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
    // WindowCloneManager に見習った単一のクローン格納用コンテナ
    _uiClonesContainer;
    constructor(selfActor, container, extraExclusions = [], cloneContainer = null) {
        this._selfActor = selfActor;
        this._container = container;
        this._extraExclusions = new Set(extraExclusions);
        this._selfRoot = this._findUiGroupAncestor(selfActor);
        // 絶対座標 0,0 起点のコンテナを作成して追加
        if (!cloneContainer) {
            this._uiClonesContainer = new UnpickableActor();
            this._container.add_child(this._uiClonesContainer);
        }
        else {
            this._uiClonesContainer = cloneContainer;
        }
        // this._uiClonesContainer.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
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
                // clipper は廃止し、直接コンテナに UnpickableClone を追加する
                const sourceClone = new UnpickableClone({ source: child });
                sourceClone.set_name(`${child.name}-sourceClone`);
                sourceClone.connect('destroy', () => {
                    this._clones.delete(child);
                });
                this._uiClonesContainer.add_child(sourceClone);
                this._clones.set(child, sourceClone);
            }
        }
        for (const [actor, sourceClone] of this._clones) {
            if (!seen.has(actor)) {
                try {
                    sourceClone.destroy();
                }
                catch (_) { }
            }
        }
    }
    static _stageToLocal(actor, stageX, stageY) {
        try {
            const res = actor.transform_stage_point(stageX, stageY);
            if (Array.isArray(res) && res[0] === true) {
                return [res[1], res[2]];
            }
        }
        catch (_) { }
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
    syncProperties(source, sourceClone, containerW, containerH, cX, cY) {
        if (!source || !sourceClone)
            return;
        try {
            const [absX, absY] = source.get_transformed_position();
            const [w, h] = source.get_size();
            if (Number.isNaN(absX) || Number.isNaN(absY) || w <= 0 || h <= 0) {
                sourceClone.visible = false;
                return;
            }
            const scaleX = source.scale_x;
            const scaleY = source.scale_y;
            // クローンは元の絶対座標（absX, absY）にそのまま配置
            sourceClone.set_position(absX, absY);
            sourceClone.translation_x = 0;
            sourceClone.translation_y = 0;
            sourceClone.set_size(w, h);
            sourceClone.set_scale(scaleX, scaleY);
            const pX = source.pivot_point?.x ?? 0;
            const pY = source.pivot_point?.y ?? 0;
            sourceClone.set_pivot_point(pX, pY);
            sourceClone.opacity = source.opacity;
            // 交差判定（既存ロジックの維持）
            const localX = absX - cX;
            const localY = absY - cY;
            const scaledW = w * scaleX;
            const scaledH = h * scaleY;
            const isVisible = source.visible && source.mapped;
            if (isVisible && containerW > 0 && containerH > 0) {
                const isIntersecting = localX < containerW &&
                    (localX + scaledW) > 0 &&
                    localY < containerH &&
                    (localY + scaledH) > 0;
                sourceClone.visible = isIntersecting;
            }
            else {
                sourceClone.visible = isVisible;
            }
        }
        catch (_) { }
    }
    // dockManager.ts から渡される最新の絶対座標とサイズを受け取る
    sync(cX, cY, cW, cH) {
        let contW = cW ?? 0;
        let contH = cH ?? 0;
        let contAbsX = cX ?? 0;
        let contAbsY = cY ?? 0;
        if (cX === undefined || cY === undefined) {
            try {
                const [cw, ch] = this._container.get_size();
                if (!Number.isNaN(cw))
                    contW = cw;
                if (!Number.isNaN(ch))
                    contH = ch;
                const [tx, ty] = this._container.get_transformed_position();
                contAbsX = Number.isNaN(tx) ? 0 : tx;
                contAbsY = Number.isNaN(ty) ? 0 : ty;
            }
            catch (_) { }
        }
        if (this._uiClonesContainer.get_parent() === this._container) {
            this._container.set_child_above_sibling(this._uiClonesContainer, null);
        }
        // WindowCloneManager の setOffset(x, y) と正負が逆の cX, cY が渡るため、
        // ここでマイナスにしてコンテナの位置を設定する
        this._uiClonesContainer.set_position(-contAbsX, -contAbsY);
        for (const [actor, sourceClone] of this._clones) {
            this.syncProperties(actor, sourceClone, contW, contH, contAbsX, contAbsY);
        }
    }
    destroy() {
        if (this._uiClonesContainer) {
            try {
                this._uiClonesContainer.destroy();
            }
            catch (_) { }
        }
        this._clones.clear();
        this._selfRoot = null;
    }
}
export class WindowCloneManager {
    windowClonesContainer = null;
    _windowClones;
    bgClone = null;
    container = null;
    cloneContainer = null;
    constructor(container, cloneContainer = null) {
        this.container = container;
        this._windowClones = new Map();
        this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
        this.windowClonesContainer = new UnpickableActor();
        this.cloneContainer = cloneContainer;
        this.cloneContainer?.add_child(this.windowClonesContainer);
        // 【修正点】bgClone（壁紙）を「先」に、windowClonesContainer（ウィンドウ群）を「後」に追加する
        this.container.insert_child_at_index(this.bgClone, 0);
        this.container.insert_child_at_index(this.windowClonesContainer, 1);
    }
    rebuildClones() {
        if (!this.container)
            return;
        if (this.bgClone) {
            this.bgClone.destroy();
            this.bgClone = null;
        }
        if (this.windowClonesContainer) {
            this.windowClonesContainer.destroy();
            this.windowClonesContainer = null;
        }
        this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
        this.windowClonesContainer = new UnpickableActor();
        this.container.insert_child_at_index(this.bgClone, 0);
        this.container.insert_child_at_index(this.windowClonesContainer, 1);
        this._windowClones.clear();
        // クローン生成ロジックの重複を排除し、sync() に委譲
        this.sync();
    }
    setOffset(x, y) {
        this.windowClonesContainer?.set_position(x, y);
        this.bgClone?.set_position(x, y);
    }
    sync() {
        let windows = global.get_window_actors();
        let activeWindows = new Set();
        let zIndex = 0;
        for (let w of windows) {
            let metaWindow = w.get_meta_window();
            if (!metaWindow || metaWindow.minimized || !w.visible)
                continue;
            // 【修正点】重い行列計算(get_transformed_position)をやめ、プロパティを直接取得
            let width = w.width;
            let height = w.height;
            if (width <= 0 || height <= 0)
                continue;
            activeWindows.add(w);
            let clone;
            if (!this._windowClones.has(w)) {
                clone = new UnpickableClone({ source: w });
                this.windowClonesContainer?.add_child(clone);
                this._windowClones.set(w, clone);
            }
            else {
                clone = this._windowClones.get(w);
            }
            clone.remove_transition('position');
            clone.remove_transition('size');
            // 【修正点】直接 x, y をコピー
            clone.set_position(w.x, w.y);
            clone.set_size(width, height);
            clone.remove_transition('scale-x');
            clone.remove_transition('scale-y');
            clone.set_scale(w.scale_x, w.scale_y);
            // 【修正点】translationも直接コピーし、アニメーションの補間を即座に反映させる
            clone.translation_x = w.translation_x;
            clone.translation_y = w.translation_y;
            let pX = w.pivot_point ? w.pivot_point.x : 0;
            let pY = w.pivot_point ? w.pivot_point.y : 0;
            clone.set_pivot_point(pX, pY);
            this.windowClonesContainer?.set_child_at_index(clone, zIndex);
            zIndex++;
        }
        // 使われなくなったクローン（閉じたウィンドウ、またはOverview起動時の全ウィンドウ）を削除
        for (let [w, clone] of this._windowClones.entries()) {
            if (!activeWindows.has(w)) {
                clone.destroy();
                this._windowClones.delete(w);
            }
        }
    }
    destroy() {
        if (this.windowClonesContainer) {
            this.windowClonesContainer.destroy();
            this.windowClonesContainer = null;
        }
        this._windowClones.clear();
        if (this.bgClone) {
            this.bgClone.destroy();
            this.bgClone = null;
        }
        this.container = null;
    }
}
