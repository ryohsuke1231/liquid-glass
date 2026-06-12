// utils.ts
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Shell from 'gi://Shell';
import St from 'gi://St';

/**
 * Looking Glassのピッカーを透過するClutter.Clone
 */
export const UnpickableClone = GObject.registerClass(

  class UnpickableClone extends Clutter.Clone {
    vfunc_pick(_pickContext: any): void {
      // No-op
    }
  }
);

/**
 * 自分自身と子要素すべてをLooking Glassのピッカーから透過するコンテナアクター
 * ※ St.WidgetのCSS余白干渉を排除するため、すべて純粋な Clutter.Actor を使用
 */
export const UnpickableActor = GObject.registerClass(

  class UnpickableActor extends Clutter.Actor {
    vfunc_pick(_pickContext: any): void {
      // No-op
    }
  }
);

/**
 * Looking Glassのピッカーを透過するSt.Widget
 */
export const UnpickableWidget = GObject.registerClass(

  class UnpickableWidget extends St.Widget {
    vfunc_pick(_pickContext: any): void {
      // No-op
    }
  }
);

/**
 * 汎用UIレイヤーサンプラー
 */
export class UILayerSampler {
  private readonly _selfActor: Clutter.Actor;
  private readonly _container: Clutter.Actor;
  private readonly _extraExclusions: Set<Clutter.Actor>;

  private _selfRoot: Clutter.Actor | null = null;
  private _clones: Map<Clutter.Actor, Clutter.Actor> = new Map();

  constructor(
    selfActor: Clutter.Actor,
    container: Clutter.Actor,
    extraExclusions: Clutter.Actor[] = []
  ) {
    this._selfActor = selfActor;
    this._container = container;
    this._extraExclusions = new Set(extraExclusions);
    this._selfRoot = this._findUiGroupAncestor(selfActor);
  }

  private _findUiGroupAncestor(actor: Clutter.Actor): Clutter.Actor | null {
    const uiGroup = Main.layoutManager.uiGroup;
    let current: Clutter.Actor | null = actor;
    while (current) {
      if (current.get_parent() === uiGroup) return current;
      current = current.get_parent();
    }
    return null;
  }

  rebindSelf() {
    this._selfRoot = this._findUiGroupAncestor(this._selfActor);
  }

  refresh() {
    if (!this._selfRoot) this._selfRoot = this._findUiGroupAncestor(this._selfActor);

    const uiGroup = Main.layoutManager.uiGroup;
    const children = uiGroup.get_children();
    const seen = new Set<Clutter.Actor>();

    for (const child of children) {
      if (child === this._selfActor || child === this._selfRoot) continue;
      if (child === Main.layoutManager._backgroundGroup) continue;
      if (this._extraExclusions.has(child)) continue;
      if (!child.visible || !child.mapped) continue;

      seen.add(child);
      if (!this._clones.has(child)) {
        const clipper = new UnpickableActor();
        clipper.set_clip_to_allocation(true);
        clipper.set_name(`${child.name}-clipper`);

        // sourceClone を直接 clipper に追加する
        const sourceClone = new UnpickableClone({ source: child });
        clipper.add_child(sourceClone);
        sourceClone.set_name(`${child.name}-sourceClone`);

        (clipper as any)._sourceClone = sourceClone;

        clipper.connect('destroy', () => {
          this._clones.delete(child);
        });

        this._container.add_child(clipper);
        this._clones.set(child, clipper);
      }
    }

    for (const [actor, clipper] of this._clones) {
      if (!seen.has(actor)) {
        try { clipper.destroy(); } catch (_) { }
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
  private static _stageToLocal(
    actor: Clutter.Actor,
    stageX: number,
    stageY: number
  ): [number, number] {
    try {
      // transform_stage_point: ステージ座標 → actor ローカル座標（全トランスフォーム考慮）
      const res = (actor as any).transform_stage_point(stageX, stageY);
      // GJS binding: [ok: boolean, x: number, y: number]
      if (Array.isArray(res) && res[0] === true) {
        return [res[1] as number, res[2] as number];
      }
    } catch (_) { }

    // フォールバック: 平行移動のみのコンテナで有効
    try {
      const [cx, cy] = actor.get_transformed_position();
      return [
        stageX - (Number.isNaN(cx) ? 0 : cx),
        stageY - (Number.isNaN(cy) ? 0 : cy),
      ];
    } catch (_) {
      return [stageX, stageY];
    }
  }

  syncProperties(
    source: Clutter.Actor,
    clipper: Clutter.Actor,
    container: Clutter.Actor,
    containerW: number,
    containerH: number,
    cX: number,
    cY: number
  ) {
    if (!source || !clipper || !container) return;
    try {
      const [absX, absY] = source.get_transformed_position();
      const [w, h] = source.get_size();

      if (Number.isNaN(absX) || Number.isNaN(absY) || w <= 0 || h <= 0) {
        clipper.visible = false;
        return;
      }

      const scaleX = source.scale_x;
      const scaleY = source.scale_y;

      // get_transformed_position() 等の1フレーム遅延する関数を捨て、
      // 渡された最新のコンテナ絶対座標からの純粋な引き算でローカル座標を算出
      const localX = absX - cX;
      const localY = absY - cY;

      // clipper はコンテナの左上原点(0, 0)に配置し、サイズをコンテナに合わせる
      clipper.set_position(0, 0);
      clipper.set_size(containerW, containerH);
      clipper.opacity = source.opacity;

      const sourceClone = (clipper as any)._sourceClone as Clutter.Clone;

      if (sourceClone) {
        // ハックを全廃止し、純粋なローカル座標に配置する
        sourceClone.set_position(localX, localY);
        sourceClone.translation_x = 0;
        sourceClone.translation_y = 0;

        sourceClone.set_size(w, h);
        sourceClone.set_scale(scaleX, scaleY);

        const pX = source.pivot_point?.x ?? 0;
        const pY = source.pivot_point?.y ?? 0;
        sourceClone.set_pivot_point(pX, pY);
      }

      // 交差判定（カリング）
      const scaledW = w * scaleX;
      const scaledH = h * scaleY;
      const isVisible = source.visible && source.mapped;

      if (isVisible && containerW > 0 && containerH > 0) {
        const isIntersecting =
          localX < containerW &&
          (localX + scaledW) > 0 &&
          localY < containerH &&
          (localY + scaledH) > 0;

        clipper.visible = isIntersecting;
      } else {
        clipper.visible = isVisible;
      }

    } catch (_) { }
  }

  // dockManager.ts から渡される最新の絶対座標とサイズを受け取る
  sync(cX?: number, cY?: number, cW?: number, cH?: number) {
    let contW = cW ?? 0;
    let contH = cH ?? 0;
    let contAbsX = cX ?? 0;
    let contAbsY = cY ?? 0;

    // 引数が渡されなかった場合のフォールバック
    if (cX === undefined || cY === undefined) {
      try {
        const [cw, ch] = this._container.get_size();
        if (!Number.isNaN(cw)) contW = cw;
        if (!Number.isNaN(ch)) contH = ch;

        const [tx, ty] = this._container.get_transformed_position();
        contAbsX = Number.isNaN(tx) ? 0 : tx;
        contAbsY = Number.isNaN(ty) ? 0 : ty;
      } catch (_) { }
    }

    for (const [actor, clipper] of this._clones) {
      this.syncProperties(actor, clipper, this._container, contW, contH, contAbsX, contAbsY);
    }
  }


  destroy() {
    for (const [, clipper] of this._clones) {
      try { clipper.destroy(); } catch (_) { }
    }
    this._clones.clear();
    this._selfRoot = null;
  }
}

export class WindowCloneManager {
  private windowClonesContainer: Clutter.Actor | null = null;
  private _windowClones: Map<Clutter.Actor, Clutter.Clone>;
  private bgClone: Clutter.Clone | null = null;

  private container: Clutter.Actor | null = null;

  constructor(container: Clutter.Actor) {
    this.container = container;
    this._windowClones = new Map();

    this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
    this.windowClonesContainer = new UnpickableActor();

    // 【修正点】bgClone（壁紙）を「先」に、windowClonesContainer（ウィンドウ群）を「後」に追加する
    this.container.add_child(this.bgClone);
    this.container.add_child(this.windowClonesContainer);
  }

  rebuildClones() {
    if (!this.container) return;

    if (this.bgClone) { this.bgClone.destroy(); this.bgClone = null; }
    if (this.windowClonesContainer) { this.windowClonesContainer.destroy(); this.windowClonesContainer = null; }

    this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
    this.windowClonesContainer = new UnpickableActor();

    this.container.add_child(this.bgClone);
    this.container.add_child(this.windowClonesContainer);

    this._windowClones.clear();

    // クローン生成ロジックの重複を排除し、sync() に委譲
    this.sync();
  }

  setOffset(x: number, y: number) {
    this.windowClonesContainer?.set_position(x, y);
    this.bgClone?.set_position(x, y);
  }

  sync() {
    let windows = global.get_window_actors();
    let activeWindows = new Set();
    let zIndex = 0;

    for (let w of windows) {
      let metaWindow = w.get_meta_window();
      if (!metaWindow || metaWindow.minimized || !w.visible) continue;

      // 【修正点】重い行列計算(get_transformed_position)をやめ、プロパティを直接取得
      let width = w.width;
      let height = w.height;

      if (width <= 0 || height <= 0) continue;

      activeWindows.add(w);

      let clone;
      if (!this._windowClones.has(w)) {
        clone = new UnpickableClone({ source: w });
        this.windowClonesContainer?.add_child(clone);
        this._windowClones.set(w, clone);
      } else {
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
