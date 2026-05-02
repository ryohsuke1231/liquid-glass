import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';

export const AdaptiveContrastConfig = {
    enabled: true,
    samplePerElement: false, // 要素ごとにサンプリングするか、全体をまとめてサンプリングするか　負荷を考慮してデフォルトはまとめてサンプリング
    sampleIntervalMs: 200, // 5Hz
    luminanceThreshold: 0.42,
    lightTextColor: '#f2f2f2',
    darkTextColor: '#1a1a1a',
};

function _clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

function _srgbToLinear(c) {
    const n = c / 255.0;
    if (n <= 0.04045)
        return n / 12.92;
    return Math.pow((n + 0.055) / 1.055, 2.4);
}

function _luminanceFromRgb(r, g, b) {
    const rl = _srgbToLinear(r);
    const gl = _srgbToLinear(g);
    const bl = _srgbToLinear(b);
    return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function _trimmedMean(values, trimRatio = 0.1) {
    if (values.length === 0)
        return null;

    const sorted = [...values].sort((a, b) => a - b);
    const trim = Math.floor(sorted.length * trimRatio);
    const start = _clamp(trim, 0, sorted.length - 1);
    const end = _clamp(sorted.length - trim, start + 1, sorted.length);

    let sum = 0.0;
    for (let i = start; i < end; i++)
        sum += sorted[i];

    return sum / (end - start);
}

function _getActorRect(actor) {
    if (!actor)
        return null;

    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_size();

    if ([x, y, w, h].some(Number.isNaN))
        return null;

    const width = Math.max(1, Math.floor(w));
    const height = Math.max(1, Math.floor(h));
    return {
        x: Math.floor(x),
        y: Math.floor(y),
        width,
        height,
    };
}

function _mergeRects(rects) {
    if (rects.length === 0)
        return null;

    let minX = rects[0].x;
    let minY = rects[0].y;
    let maxX = rects[0].x + rects[0].width;
    let maxY = rects[0].y + rects[0].height;

    for (let i = 1; i < rects.length; i++) {
        const r = rects[i];
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.width);
        maxY = Math.max(maxY, r.y + r.height);
    }

    return {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
    };
}

async function _captureAreaToFile(screenshot, rect, filePath) {
    return new Promise((resolve) => {
        try {
            // 1. 文字列のパスから Gio.File オブジェクトを生成
            const file = Gio.File.new_for_path(filePath);
            
            // 2. 上書きモードで書き込み用ストリーム (GOutputStream) を開く
            const stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

            // 3. パス文字列の代わりに、作成した stream を引数に渡す
            screenshot.screenshot_area(
                rect.x, rect.y, rect.width, rect.height, stream,
                (obj, res) => {
                    try {
                        // スクリーンショット処理の完了を待機
                        const success = obj.screenshot_area_finish(res);
                        
                        // ファイルがロックされたままになるのを防ぐためストリームを閉じる
                        stream.close(null); 
                        resolve(success);
                    } catch (e) {
                        console.error(`[Liquid Glass] Screenshot finish failed: ${e}`);
                        stream.close(null); // エラー時も確実に閉じる
                        resolve(false);
                    }
                }
            );
        } catch (e) {
            console.error(`[Liquid Glass] Screenshot API failed: ${e}`);
            resolve(false);
        }
    });
}

function _buildTempPath() {
    const token = `${GLib.get_monotonic_time()}-${Math.floor(Math.random() * 1000000)}`;
    return `${GLib.get_tmp_dir()}/liquid-glass-sample-${token}.png`;
}

export class StageContrastSampler {
    constructor() {
        this._screenshot = new Shell.Screenshot();
    }

    async sampleLuminance(rect) {
        if (!rect || rect.width <= 0 || rect.height <= 0)
            return null;

        const filePath = _buildTempPath();
        const captured = await _captureAreaToFile(this._screenshot, rect, filePath);
        if (!captured)
            return null;

        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file(filePath);
            if (!pixbuf)
                return null;

            const width = pixbuf.get_width();
            const height = pixbuf.get_height();
            const rowstride = pixbuf.get_rowstride();
            const channels = pixbuf.get_n_channels();
            const hasAlpha = pixbuf.get_has_alpha();
            const pixels = pixbuf.get_pixels();

            const step = Math.max(1, Math.floor(Math.min(width, height) / 48));
            const values = [];

            for (let y = 0; y < height; y += step) {
                for (let x = 0; x < width; x += step) {
                    const idx = y * rowstride + x * channels;
                    if (hasAlpha) {
                        const a = pixels[idx + 3];
                        if (a < 32)
                            continue;

                        if (a < 255) {
                            const scale = 255.0 / a;
                            const r = _clamp(Math.round(pixels[idx + 0] * scale), 0, 255);
                            const g = _clamp(Math.round(pixels[idx + 1] * scale), 0, 255);
                            const b = _clamp(Math.round(pixels[idx + 2] * scale), 0, 255);
                            values.push(_luminanceFromRgb(r, g, b));
                            continue;
                        }
                    }

                    const r = pixels[idx + 0];
                    const g = pixels[idx + 1];
                    const b = pixels[idx + 2];
                    values.push(_luminanceFromRgb(r, g, b));
                }
            }

            return _trimmedMean(values, 0.10);
        } catch (e) {
            console.error(`[Liquid Glass] Failed to analyze screenshot luminance: ${e}`);
            return null;
        } finally {
            try {
                GLib.unlink(filePath);
            } catch (_) {
                // Ignore cleanup errors.
            }
        }
    }

    decideTextColor(luminance, config = AdaptiveContrastConfig) {
        if (luminance === null || luminance === undefined)
            return null;

        return luminance > config.luminanceThreshold
            ? config.darkTextColor
            : config.lightTextColor;
    }

    async chooseColorsForActors(actors, config = AdaptiveContrastConfig) {
        const rects = [];
        const targets = [];

        for (const actor of actors) {
            const rect = _getActorRect(actor);
            if (!rect)
                continue;

            targets.push(actor);
            rects.push(rect);
        }

        const result = new Map();
        if (targets.length === 0)
            return result;

        if (!config.samplePerElement) {
            const merged = _mergeRects(rects);
            const luma = await this.sampleLuminance(merged);
            const color = this.decideTextColor(luma, config);
            if (!color)
                return result;

            for (const actor of targets)
                result.set(actor, color);
            return result;
        }

        for (let i = 0; i < targets.length; i++) {
            const luma = await this.sampleLuminance(rects[i]);
            const color = this.decideTextColor(luma, config);
            if (color)
                result.set(targets[i], color);
        }

        return result;
    }
}
