// A worker process (gjs -m) that answers requests one line of JSON at a time:
// each request carries an `id`, and the answer the same `id`. Started on the
// first request and again after it exits, a few times at most.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
const MAX_STARTS = 3;

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class WorkerProcess {
    _script;
    _name;
    _logger;
    _process = null;
    _output = null;
    _waiting = new Map();
    // Lines for the worker, written one after another.
    _lines = [];
    _writing = false;
    _nextId = 1;
    _starts = 0;
    _cancellable = new Gio.Cancellable();
    _encoder = new TextEncoder();

    /** @param _script The worker's module, run with gjs -m. */
    constructor(_script, _name, _logger) {
        this._script = _script;
        this._name = _name;
        this._logger = _logger;
    }

    /** Whether the worker runs or can be started. */
    get available() {
        return !!this._process || (this._starts < MAX_STARTS && !!GLib.find_program_in_path('gjs'));
    }

    /** Requests not answered yet. */
    get pending() {
        return this._waiting.size;
    }

    /** Rejects when the worker cannot be started, exits meanwhile or answers with an error. */
    request(message) {
        if (!this._process && !this._start())
            return Promise.reject(new Error(`the ${this._name} cannot start`));
        return new Promise((resolve, reject) => {
            const id = this._nextId++;
            this._waiting.set(id, { resolve, reject });
            this._lines.push(`${JSON.stringify({ ...message, id })}\n`);
            this._write();
        });
    }

    _start() {
        const gjs = GLib.find_program_in_path('gjs');
        if (!gjs || this._starts >= MAX_STARTS)
            return false;
        this._starts++;
        try {
            this._process = Gio.Subprocess.new([gjs, '-m', this._script], Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        }
        catch (e) {
            // It would fail the same way again.
            this._logger.log(`[Liquid Glass] Could not start the ${this._name}: ${e}`);
            this._process = null;
            this._starts = MAX_STARTS;
            return false;
        }
        this._output = new Gio.DataInputStream({ base_stream: this._process.get_stdout_pipe() });
        this._read();
        return true;
    }

    _write() {
        const process = this._process;
        if (this._writing || !process || !this._lines.length)
            return;
        this._writing = true;
        const bytes = new GLib.Bytes(this._encoder.encode(this._lines.shift()));
        process.get_stdin_pipe().write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
            this._writing = false;
            try {
                stream.write_bytes_finish(res);
            }
            catch (e) {
                if (!isCancelled(e))
                    this._lost(process, e);
                return;
            }
            this._write();
        });
    }

    _read() {
        const process = this._process;
        const output = this._output;
        output.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (_s, res) => {
            let line;
            try {
                [line] = output.read_line_finish_utf8(res);
            }
            catch (e) {
                if (!isCancelled(e))
                    this._lost(process, e);
                return;
            }
            if (line === null) {
                this._lost(process, new Error('the worker exited'));
                return;
            }
            this._answer(line);
            this._read();
        });
    }

    _answer(line) {
        let message;
        try {
            message = JSON.parse(line);
        }
        catch (e) {
            this._logger.log(`[Liquid Glass] The ${this._name} said something else: ${e}`);
            return;
        }
        const waiting = this._waiting.get(message.id);
        if (!waiting)
            return;
        this._waiting.delete(message.id);
        if (message.error)
            waiting.reject(new Error(message.error));
        else
            waiting.resolve(message);
    }

    // The worker exited or its pipes broke: what was asked of it fails, and the next request starts it again.
    _lost(process, error) {
        if (this._process !== process)
            return;
        this._logger.log(`[Liquid Glass] Lost the ${this._name}: ${error}`);
        process.force_exit();
        this._process = null;
        this._output = null;
        this._lines = [];
        this._writing = false;
        for (const waiting of this._waiting.values())
            waiting.reject(new Error(`the ${this._name} exited`));
        this._waiting.clear();
    }

    destroy() {
        this._cancellable.cancel();
        this._process?.force_exit();
        this._process = null;
        this._output = null;
        this._waiting.clear();
    }
}

/**
 * The worker's side: answers each line of JSON on stdin with what `handle`
 * returns, or with its error, until stdin closes. Call from the worker's
 * module and await.
 */
export async function serveRequests(handle) {
    const GioUnix = (await import('gi://GioUnix')).default;
    const input = new Gio.DataInputStream({ base_stream: new GioUnix.InputStream({ fd: 0, close_fd: false }) });
    const output = new GioUnix.OutputStream({ fd: 1, close_fd: false });
    const encoder = new TextEncoder();
    const loop = new GLib.MainLoop(null, false);
    const answer = (message) => output.write_all(encoder.encode(`${JSON.stringify(message)}\n`), null);
    // One request at a time, in order.
    let queue = Promise.resolve();
    const read = () => {
        input.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, res) => {
            let line = null;
            try {
                [line] = input.read_line_finish_utf8(res);
            }
            catch {
                // The shell is gone.
            }
            if (line === null) {
                loop.quit();
                return;
            }
            const text = line;
            queue = queue.then(async () => {
                let id = 0;
                try {
                    const { id: asked, ...request } = JSON.parse(text);
                    id = asked;
                    answer({ ...(await handle(request)), id });
                }
                catch (e) {
                    answer({ id, error: String(e) });
                }
            });
            read();
        });
    };
    read();
    // runAsync() keeps promises running, which run() blocks in a module still being evaluated.
    await loop.runAsync();
}
