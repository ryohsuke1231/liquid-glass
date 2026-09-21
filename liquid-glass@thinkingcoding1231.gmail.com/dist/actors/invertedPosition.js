import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
export const InvertedPositionConstraint = GObject.registerClass({
    GTypeName: 'InvertedPositionConstraint',
    Properties: {
        'source': GObject.ParamSpec.object('source', 'Source', 'Source Actor', GObject.ParamFlags.READWRITE, Clutter.Actor.$gtype),
        'offset-x': GObject.ParamSpec.double('offset-x', 'Offset X', 'X Offset', GObject.ParamFlags.READWRITE, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0.0),
        'offset-y': GObject.ParamSpec.double('offset-y', 'Offset Y', 'Y Offset', GObject.ParamFlags.READWRITE, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0.0),
    },
}, class InvertedPositionConstraint extends Clutter.Constraint {
    _sourceXId = 0;
    _sourceYId = 0;
    _init(props) {
        super._init(props);
        // sourceプロパティ自体が変更されたときの監視
        this.connect('notify::source', this._onSourceChanged.bind(this));
        // [FIX] オフセット変更でもレイアウトを無効化する。
        //
        // vfunc_update_allocation() は「このアクターが allocate される」ときにしか
        // 走らない。以前はそれを促すトリガーが source の notify::x / notify::y
        // だけだった ＝ **ウィンドウが動いたときだけ**。
        //
        // ところが offset は毎フレーム作り直される動的な値で、しかも
        // ApplicationManager._syncStateInner() では
        //     offsetX = -(translation_x + pivot_px * (1 - scale)) - localX
        // と、**scale の関数**になっている。GNOME のウィンドウ開閉アニメーションは
        // 位置を一切変えず scale と pivot だけを動かすので、まさにオフセットが
        // 毎フレーム大きく変わる場面で notify::x / notify::y が一度も飛ばない。
        // その間 allocation は据え置かれ、ガラスの箱だけが縮み/伸びして、中身
        // （壁紙クローン・背後ウィンドウのクローン）は前の位置に取り残される。
        // これが「開く/閉じるアニメーション中にクローンの位置がズレる（オフセット
        // が遅れているように見える）」の正体。
        this.connect('notify::offset-x', () => this._queueRelayout());
        this.connect('notify::offset-y', () => this._queueRelayout());
        if (this.source) {
            this._onSourceChanged();
        }
    }
    _queueRelayout() {
        try {
            const actor = this.get_actor();
            if (actor)
                actor.queue_relayout();
        }
        catch (_) { /* noop */ }
    }
    /**
     * Assigns both offsets and invalidates the allocation exactly once.
     *
     * Preferred over writing `offset_x` / `offset_y` directly: it skips the
     * work entirely when nothing changed (the steady state, 60 times a second
     * per constrained actor) and guarantees the relayout even if GJS's
     * generated property setter ever stops emitting `notify` for an unchanged
     * value.
     */
    setOffset(x, y) {
        const nx = Number.isFinite(x) ? x : 0;
        const ny = Number.isFinite(y) ? y : 0;
        if (this.offset_x === nx && this.offset_y === ny)
            return;
        this.offset_x = nx;
        this.offset_y = ny;
        this._queueRelayout();
    }
    _onSourceChanged() {
        this._disconnectSignals();
        if (this.source) {
            const queueRelayout = () => {
                const actor = this.get_actor();
                if (actor) {
                    actor.queue_relayout(); // 変更があったら再割り当てを要求
                }
            };
            // sourceが移動した時にレイアウト再計算を走らせる
            this._sourceXId = this.source.connect('notify::x', queueRelayout);
            this._sourceYId = this.source.connect('notify::y', queueRelayout);
            // 登録時にも1度レイアウトを要求
            queueRelayout();
        }
    }
    _disconnectSignals() {
        if (!this.source)
            return;
        if (this._sourceXId) {
            this.source.disconnect(this._sourceXId);
            this._sourceXId = 0;
        }
        if (this._sourceYId) {
            this.source.disconnect(this._sourceYId);
            this._sourceYId = 0;
        }
    }
    vfunc_update_allocation(actor, allocation) {
        if (!this.source)
            return;
        // 1. 基準アクターの座標を取得
        const [x, y] = this.source.get_position();
        // 2. 追従アクターの現在の幅と高さを保持
        const width = allocation.get_width();
        const height = allocation.get_height();
        // 3. 反転座標にオフセットを加算
        const targetX = -x + (this.offset_x ?? 0.0);
        const targetY = -y + (this.offset_y ?? 0.0);
        // 4. allocation (Clutter.ActorBox) の領域を直接書き換える
        allocation.x1 = targetX;
        allocation.y1 = targetY;
        allocation.x2 = targetX + width;
        allocation.y2 = targetY + height;
    }
});
