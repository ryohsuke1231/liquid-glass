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
