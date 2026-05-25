// utils.ts
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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

/**
 * 汎用UIレイヤーサンプラー
 * 
 * 指定した "自分自身" (selfActor) を含むサブツリーを除外しながら、
 * uiGroup 上の全 UI 要素を自動的にクローンする。
 * 
 * 使い方：
 *   const sampler = new UILayerSampler(this.bgActor, this.fboContainer);
 *   // フレームごとに呼ぶ
 *   sampler.refresh(); // クローンの追加・削除
 *   sampler.sync();    // 位置・サイズ同期
 */
export class UILayerSampler {
  private readonly _selfActor: Clutter.Actor;
  private readonly _container: Clutter.Actor;
  // ★修正①: 追加の除外対象（dockRoot, menuRoot など）
  private readonly _extraExclusions: Set<Clutter.Actor>;

  private _selfRoot: Clutter.Actor | null = null;
  private _clones: Map<Clutter.Actor, Clutter.Clone> = new Map();

  constructor(
    selfActor: Clutter.Actor,
    container: Clutter.Actor,
    extraExclusions: Clutter.Actor[] = []   // ← 追加引数
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
      // ★ 自己除外
      if (child === this._selfActor || child === this._selfRoot) continue;
      // ★修正②: 追加除外（dockRoot, menuRoot）
      if (this._extraExclusions.has(child)) continue;
      // ★修正③: 非表示・unmapped の子は生成しない（不要なクローン防止）
      if (!child.visible || !child.mapped) continue;

      seen.add(child);

      if (!this._clones.has(child)) {
        const clone = new UnpickableClone({ source: child });
        clone.connect('destroy', () => { this._clones.delete(child); });
        this._container.add_child(clone);
        this._clones.set(child, clone);
      }
    }

    for (const [actor, clone] of this._clones) {
      if (!seen.has(actor)) {
        try { clone.destroy(); } catch (_) { }
        this._clones.delete(actor);
      }
    }
  }

  sync() {
    let contX = 0, contY = 0;
    let contW = 0, contH = 0; // コンテナのサイズを追加で取得
    try {
      const [cx, cy] = this._container.get_transformed_position();
      const [cw, ch] = this._container.get_size();
      if (!Number.isNaN(cx)) contX = cx;
      if (!Number.isNaN(cy)) contY = cy;
      if (!Number.isNaN(cw)) contW = cw;
      if (!Number.isNaN(ch)) contH = ch;
    } catch (_) { }

    for (const [actor, clone] of this._clones) {
      // 幅と高さも渡すように変更
      UILayerSampler.syncProperties(actor, clone, contX, contY, contW, contH);
    }
  }

  // containerW, containerH を引数に追加
  static syncProperties(
    source: Clutter.Actor,
    clone: Clutter.Clone,
    containerX: number = 0,
    containerY: number = 0,
    containerW: number = 0,
    containerH: number = 0
  ) {
    if (!source || !clone) return;
    try {
      const [absX, absY] = source.get_transformed_position();
      const [w, h] = source.get_size();

      if (Number.isNaN(absX) || Number.isNaN(absY) || w <= 0 || h <= 0) {
        clone.visible = false;
        return;
      }

      // ★ 絶対座標 - コンテナ座標 = コンテナ内でのローカル座標
      const OFFSET = 0.125; // クローンのオフセット
      const localX = absX - containerX + OFFSET;
      const localY = absY - containerY + OFFSET;

      clone.set_position(localX, localY);
      clone.set_size(w, h);
      clone.set_scale(source.scale_x, source.scale_y);

      const pX = source.pivot_point?.x ?? 0;
      const pY = source.pivot_point?.y ?? 0;
      clone.set_pivot_point(pX, pY);

      // get_transformed_position() は translation 込みの値を返すため
      // クローン側は 0 にリセット（二重ズレ防止）
      clone.translation_x = 0;
      clone.translation_y = 0;
      clone.opacity = source.opacity;

      // ==========================================
      // ★ 追加: 手動カリング（AABB交差判定）
      // ==========================================
      const isVisible = source.visible && source.mapped;

      if (isVisible && containerW > 0 && containerH > 0) {
        // スケールを考慮した実際の描画サイズ
        const scaledW = w * source.scale_x;
        const scaledH = h * source.scale_y;

        // クローンがコンテナ（Dockのガラス領域）の矩形と交差しているかチェック
        const isIntersecting =
          localX < containerW &&
          (localX + scaledW) > 0 &&
          localY < containerH &&
          (localY + scaledH) > 0;

        // 交差していない（完全に外側にある）場合は非表示にして描画・Effectをスキップ
        clone.visible = isIntersecting;
      } else {
        clone.visible = isVisible;
      }

    } catch (_) { }
  }

  destroy() {
    for (const [, clone] of this._clones) {
      try { clone.destroy(); } catch (_) { }
    }
    this._clones.clear();
    this._selfRoot = null;
  }
}
