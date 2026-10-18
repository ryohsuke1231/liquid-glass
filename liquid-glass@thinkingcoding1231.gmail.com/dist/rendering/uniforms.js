import { setUniformArray } from '../shellVersion.js';

export class UniformState {
    _pipeline = null;

    get values() { return this._pendingUniforms; }

    attach(pipeline) {
        this._pipeline = pipeline;
        this._compUniforms.clear();
        this._compUniformArrays.clear();
        // A new pipeline holds none of the buffered values yet.
        this._appliedUniforms.clear();
        this._appliedUniformArrays.clear();
        if (pipeline)
            this.flush();
    }

    takeDirty() {
        const changed = this._uniformsDirty;
        this._uniformsDirty = false;
        return changed;
    }

    clear() {
        this.attach(null);
        this._pendingUniforms.clear();
        this._pendingUniformArrays.clear();
        this._uniformsDirty = false;
    }

    // Uniform locations in the current pipeline.
    _compUniforms = new Map();
    _compUniformArrays = new Map();
    // Every value set so far, kept so a new pipeline can be seeded with them.
    _pendingUniforms = new Map();
    _pendingUniformArrays = new Map();
    // What the pipeline currently holds, so flush() (every paint) writes only
    // changed values instead of about 60 scalars and 8 arrays.
    _appliedUniforms = new Map();
    _appliedUniformArrays = new Map();
    // Set when a value actually changed; the glass repaints only then.
    // Changes behind the glass arrive through the relays, not here.
    _uniformsDirty = false;

    // Sets a float uniform, buffered until attach() provides a pipeline.
    set(name, value) {
        if (this._pendingUniforms.get(name) === value)
            return;
        this._pendingUniforms.set(name, value);
        this._uniformsDirty = true;
        if (this._pipeline) {
            this._applyUniform(name, value);
        }
    }

    _applyUniform(name, value) {
        if (!this._pipeline)
            return;
        if (this._appliedUniforms.get(name) === value)
            return;
        let loc = this._compUniforms.get(name);
        if (loc === undefined) {
            loc = this._pipeline.get_uniform_location(name);
            this._compUniforms.set(name, loc);
        }
        this._pipeline.set_uniform_1f(loc, value);
        this._appliedUniforms.set(name, value);
    }

    flush() {
        for (const [name, value] of this._pendingUniforms) {
            this._applyUniform(name, value);
        }
        for (const [name, values] of this._pendingUniformArrays) {
            this._applyUniformArray(name, values);
        }
    }

    // Sets a float array uniform (e.g. region_x[16]), buffered like set().
    setArray(name, values) {
        const prev = this._pendingUniformArrays.get(name);
        if (prev && prev.length === values.length) {
            let same = true;
            for (let i = 0; i < values.length; i++) {
                if (prev[i] !== values[i]) {
                    same = false;
                    break;
                }
            }
            if (same)
                return;
        }
        // Callers reuse their arrays, so keep a copy to compare against.
        this._pendingUniformArrays.set(name, values.slice());
        this._uniformsDirty = true;
        if (this._pipeline) {
            this._applyUniformArray(name, values);
        }
    }

    _applyUniformArray(name, values) {
        if (!this._pipeline)
            return;
        const applied = this._appliedUniformArrays.get(name);
        if (applied && applied.length === values.length) {
            let same = true;
            for (let i = 0; i < values.length; i++) {
                if (applied[i] !== values[i]) {
                    same = false;
                    break;
                }
            }
            if (same)
                return;
        }
        let loc = this._compUniformArrays.get(name);
        if (loc === undefined) {
            loc = this._pipeline.get_uniform_location(name);
            this._compUniformArrays.set(name, loc);
        }
        setUniformArray(this._pipeline, loc, name, values);
        this._appliedUniformArrays.set(name, values.slice());
    }
}
