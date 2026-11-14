// Spreads the heavy loops over helper processes (kernelWorker.js), since a
// gjs process computes on one core. The numbers travel as files in the
// runtime directory, which is memory, mapped by whoever reads them; the pipes
// only carry what to do, one line of JSON a request. The helpers are asked
// and read one after another with blocking I/O, at most one piece of work
// each at a time; this process works on a piece of its own meanwhile.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { convolve, matmul } from './kernels.js';
// Work smaller than this many multiplications is not worth sending.
const MIN_SHARED_WORK = 2e7;
const MAX_HELPERS = 14;
const FOLDER_PREFIX = 'liquid-glass-kernels-';

// Removes the shared files of a pool whose process was stopped before it could.
function removeLeftovers(runtime) {
    const dir = GLib.Dir.open(runtime, 0);
    for (let name = dir.read_name(); name; name = dir.read_name()) {
        if (!name.startsWith(FOLDER_PREFIX))
            continue;
        const folder = GLib.build_filenamev([runtime, name]);
        const files = GLib.Dir.open(folder, 0);
        for (let file = files.read_name(); file; file = files.read_name())
            GLib.unlink(GLib.build_filenamev([folder, file]));
        GLib.rmdir(folder);
    }
}

/** The floats `ref` points at, mapped; they stay valid after the file is deleted. */
export function mapFloats(ref) {
    const bytes = GLib.MappedFile.new(ref.file, false).get_bytes().toArray();
    return new Float32Array(bytes.buffer, bytes.byteOffset + ref.from * 4, ref.length);
}

export function writeFloats(path, data) {
    GLib.file_set_contents(path, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

export class KernelPool {
    _helpers = [];
    _dir = '';
    _files = 0;
    _encoder = new TextEncoder();

    /** @param script kernelWorker.js, run with gjs -m. */
    constructor(script) {
        const gjs = GLib.find_program_in_path('gjs');
        // One core is this process's, and one is left to the desktop.
        const wanted = Math.min(GLib.get_num_processors() - 2, MAX_HELPERS);
        if (!gjs || wanted < 1)
            return;
        try {
            removeLeftovers(GLib.get_user_runtime_dir());
            this._dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), `${FOLDER_PREFIX}${GLib.uuid_string_random()}`]);
            if (GLib.mkdir_with_parents(this._dir, 0o700) !== 0)
                throw new Error('no room for the shared files');
            for (let i = 0; i < wanted; i++) {
                const process = Gio.Subprocess.new([gjs, '-m', script], Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
                this._helpers.push({
                    process, input: process.get_stdin_pipe(), output: new Gio.DataInputStream({ base_stream: process.get_stdout_pipe() }),
                    result: `${this._dir}/result-${i}`,
                });
            }
        }
        catch {
            // Without helpers, or with the ones that started.
        }
    }

    get helpers() {
        return this._helpers.length;
    }

    _share(data, written) {
        const file = `${this._dir}/in-${this._files++}`;
        writeFloats(file, data);
        written.push(file);
        return { file, from: 0, length: data.length };
    }

    _ask(helper, request) {
        helper.input.write_all(this._encoder.encode(`${JSON.stringify(request)}\n`), null);
    }

    // The floats a helper answered with, once it says they are written.
    _answer(helper, length) {
        const [line] = helper.output.read_line_utf8(null);
        if (line !== 'done')
            throw new Error('a helper failed');
        return mapFloats({ file: helper.result, from: 0, length });
    }

    // A helper that fails takes the pool with it: the work is done here from then on.
    _shared(work, alone) {
        if (this._helpers.length === 0)
            return alone();
        const written = [];
        try {
            return work(written);
        }
        catch {
            this.destroy();
            return alone();
        }
        finally {
            for (const file of written)
                GLib.unlink(file);
        }
    }

    matmulAll(jobs) {
        const alone = () => {
            for (const j of jobs) {
                j.out.fill(0, j.offset, j.offset + j.n * j.m);
                matmul(j.a, j.b, j.n, j.k, j.m, j.out, j.offset);
            }
        };
        const work = jobs.reduce((sum, j) => sum + j.n * j.k * j.m, 0);
        if (work < MIN_SHARED_WORK) {
            alone();
            return;
        }
        this._shared(written => {
            const workers = this._helpers.length + 1;
            const parts = Math.max(Math.floor(workers / jobs.length), 1);
            const pieces = [];
            for (const job of jobs) {
                const rows = Math.ceil(job.n / parts);
                for (let from = 0; from < job.n; from += rows)
                    pieces.push({ job, from, rows: Math.min(rows, job.n - from) });
            }
            // Each matrix is written once, however many pieces read it.
            const shared = new Map();
            const ref = (data) => {
                let r = shared.get(data);
                if (!r)
                    shared.set(data, r = this._share(data, written));
                return r;
            };
            for (let first = 0; first < pieces.length; first += workers) {
                const round = pieces.slice(first, first + workers);
                const mine = round.pop();
                round.forEach(({ job, from, rows }, i) => {
                    const helper = this._helpers[i];
                    this._ask(helper, {
                        op: 'matmul', a: { ...ref(job.a), from: from * job.k, length: rows * job.k }, b: ref(job.b),
                        n: rows, k: job.k, m: job.m, result: helper.result,
                    });
                });
                matmul(mine.job.a.subarray(mine.from * mine.job.k), mine.job.b, mine.rows, mine.job.k, mine.job.m, mine.job.out, mine.job.offset + mine.from * mine.job.m);
                round.forEach(({ job, from, rows }, i) => {
                    job.out.set(this._answer(this._helpers[i], rows * job.m), job.offset + from * job.m);
                });
            }
        }, alone);
    }

    convolveAll(x, weights, bias, count, s) {
        const alone = () => convolve(x, weights, bias, count, s);
        const perFilter = s.channels * s.kh * s.kw;
        const outPlane = s.outHeight * s.outWidth;
        if (count * perFilter * outPlane < MIN_SHARED_WORK)
            return alone();
        return this._shared(written => {
            const workers = Math.min(this._helpers.length + 1, count);
            const each = Math.ceil(count / workers);
            const out = new Float32Array(count * outPlane);
            const chunks = [];
            for (let from = 0; from < count; from += each)
                chunks.push([from, Math.min(each, count - from)]);
            const mine = chunks.pop();
            const xRef = this._share(x, written);
            const weightsRef = this._share(weights, written);
            const biasRef = bias.length ? this._share(bias, written) : null;
            chunks.forEach(([from, filters], i) => {
                const helper = this._helpers[i];
                this._ask(helper, {
                    op: 'convolve', x: xRef, weights: { ...weightsRef, from: from * perFilter, length: filters * perFilter },
                    bias: biasRef && { ...biasRef, from, length: filters }, count: filters, shape: s, result: helper.result,
                });
            });
            const [from, filters] = mine;
            out.set(convolve(x, weights.subarray(from * perFilter, (from + filters) * perFilter), bias.length ? bias.subarray(from, from + filters) : bias, filters, s), from * outPlane);
            chunks.forEach(([at, n], i) => out.set(this._answer(this._helpers[i], n * outPlane), at * outPlane));
            return out;
        }, alone);
    }

    destroy() {
        for (const helper of this._helpers) {
            helper.process.force_exit();
            GLib.unlink(helper.result);
        }
        this._helpers = [];
        if (this._dir)
            GLib.rmdir(this._dir);
        this._dir = '';
    }
}
