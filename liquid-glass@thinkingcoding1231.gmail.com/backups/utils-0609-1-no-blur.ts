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
  /*
  {
    GTypeName: 'LiquidGlassUnpickableClone',
  },
  */
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
  /*
  {
    GTypeName: 'LiquidGlassUnpickableActor',
  },
  */
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
  /*
  {
    GTypeName: 'LiquidGlassUnpickableWidget',
  },
  */
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

  private _overlayContainer: Clutter.Actor;
  private _selfRoot: Clutter.Actor | null = null;
  private _clones: Map<Clutter.Actor, Clutter.Actor> = new Map();

  constructor(
    selfActor: Clutter.Actor,
    container: Clutter.Actor,
    extraExclusions: Clutter.Actor[] = []
  ) {
    this._selfActor = selfActor;
    this._container = container; // 元のDock clipBox
    this._extraExclusions = new Set(extraExclusions);
    this._selfRoot = this._findUiGroupAncestor(selfActor);

    // 【核心の修正】DockのFBOによる座標ズレバグを回避するため、独立したクリップ用コンテナを作成
    this._overlayContainer = new UnpickableActor();
    this._overlayContainer.set_clip_to_allocation(true);
    this._overlayContainer.set_name('UILayerSampler-OverlayContainer');

    // 画面階層に直結させつつ、ZオーダーをDockの真上（背景やウィンドウの上）に設定する
    const parent = this._selfActor.get_parent();
    if (parent) {
      parent.insert_child_above(this._overlayContainer, this._selfActor);
    } else {
      Main.layoutManager.uiGroup.add_child(this._overlayContainer);
    }
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
    // 親が変更された場合（再構築時など）に備えてZオーダーを維持
    const parent = this._selfActor.get_parent();
    if (parent && this._overlayContainer.get_parent() !== parent) {
      this._overlayContainer.get_parent()?.remove_child(this._overlayContainer);
      parent.insert_child_above(this._overlayContainer, this._selfActor);
    }

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

        // FBO（wrapper）を撤廃し、sourceCloneを直接配置
        const sourceClone = new UnpickableClone({ source: child });
        clipper.add_child(sourceClone);
        sourceClone.set_name(`${child.name}-sourceClone`);

        (clipper as any)._sourceClone = sourceClone;

        clipper.connect('destroy', () => {
          this._clones.delete(child);
        });

        // Dockの中ではなく、画面直結のoverlayContainerに配置する
        this._overlayContainer.add_child(clipper);
        this._clones.set(child, clipper);
      }
    }

    for (const [actor, clipper] of this._clones) {
      if (!seen.has(actor)) {
        try { clipper.destroy(); } catch (_) { }
      }
    }
  }

  sync() {
    let contW = 0, contH = 0;
    try {
      // Dockコンテナのサイズと絶対座標を取得し、overlayContainerを完全に追従させる
      const [cw, ch] = this._container.get_size();
      if (!Number.isNaN(cw)) contW = cw;
      if (!Number.isNaN(ch)) contH = ch;

      const [cX, cY] = this._container.get_transformed_position();
      if (!Number.isNaN(cX) && !Number.isNaN(cY)) {
        this._overlayContainer.set_position(cX, cY);
        this._overlayContainer.set_size(contW, contH);
      }
    } catch (_) { }

    for (const [actor, clipper] of this._clones) {
      // 基準コンテナとしてDockではなく _overlayContainer を渡す
      UILayerSampler.syncProperties(actor, clipper, this._overlayContainer, contW, contH);
    }
  }

  private static _stageToLocal(
    actor: Clutter.Actor,
    stageX: number,
    stageY: number
  ): [number, number] {
    try {
      const res = (actor as any).transform_stage_point(stageX, stageY);
      if (Array.isArray(res) && res[0] === true) {
        return [res[1] as number, res[2] as number];
      }
    } catch (_) { }
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

  static syncProperties(
    source: Clutter.Actor,
    clipper: Clutter.Actor,
    container: Clutter.Actor,
    containerW: number = 0,
    containerH: number = 0
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
      const scaledW = w * scaleX;
      const scaledH = h * scaleY;

      const [localX, localY] = UILayerSampler._stageToLocal(container, absX, absY);

      // clipperはコンテナ（Dockの表示領域）と同じサイズにして描画の漏れを防ぐ
      clipper.set_position(0, 0);
      clipper.set_size(containerW, containerH);
      clipper.opacity = source.opacity;

      const sourceClone = (clipper as any)._sourceClone as Clutter.Clone;
      if (sourceClone) {
        sourceClone.set_position(localX, localY);
        sourceClone.set_size(w, h);
        sourceClone.set_scale(scaleX, scaleY);

        const pX = source.pivot_point?.x ?? 0;
        const pY = source.pivot_point?.y ?? 0;
        sourceClone.set_pivot_point(pX, pY);
      }

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

  destroy() {
    for (const [, clipper] of this._clones) {
      try { clipper.destroy(); } catch (_) { }
    }
    this._clones.clear();
    this._selfRoot = null;

    // 独立したオーバーレイコンテナも確実に破棄する
    if (this._overlayContainer) {
      try { this._overlayContainer.destroy(); } catch (_) { }
    }
  }
}
