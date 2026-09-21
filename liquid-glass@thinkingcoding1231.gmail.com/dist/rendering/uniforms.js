/** Buffered shader parameters with change detection and pipeline-local caches. */
export class UniformState {
    _pipeline = null;
    get values() { return this._pendingUniforms; }
    attach(pipeline) {
        this._pipeline = pipeline;
        this._compUniforms.clear();
        this._compUniformArrays.clear();
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
    // ── Uniform location cache for the composite pipeline ──
    _compUniforms = new Map();
    // ── Uniforms set before the pipeline existed, applied once it's created ──
    _pendingUniforms = new Map();
    // ── Same as above, but for array uniforms (region_x[], region_tint_r[], etc.) ──
    _compUniformArrays = new Map();
    _pendingUniformArrays = new Map();
    // [PERF] What is ACTUALLY sitting in the composite pipeline right now, as
    // opposed to _pendingUniforms (the authoritative buffered state, which has
    // to stay complete so a freshly compiled pipeline can be seeded from it).
    //
    // _applyPendingUniforms() runs on every paint and used to push all ~60
    // scalars plus 8 sixteen-element arrays into Cogl unconditionally, even
    // though a steady-state frame changes none of them. Two costs came out of
    // that: Cogl re-hashing the pipeline's uniform state, and — larger in
    // practice — one throwaway JS array per call from
    // `set_uniform_float(loc, 1, 1, [value])`. With paint running twice per
    // frame per instance (measured), that was several thousand short-lived
    // allocations per second feeding a GC that runs on the compositor thread.
    //
    // Cleared whenever the pipeline object is replaced, since a new pipeline
    // starts with none of these values.
    _appliedUniforms = new Map();
    _appliedUniformArrays = new Map();
    // [PERF] Set by _setFloat()/_setFloatArray() whenever a value they were
    // handed actually differs from what is already buffered, and cleared by
    // _queueRepaintIfDirty(). This is what lets the uniform setters stop
    // requesting a repaint unconditionally.
    //
    // Why that is safe: queue_repaint() exists for "the actor's content is
    // unchanged but MY parameters changed". The opposite case — the content
    // behind the glass changed — never went through it. A damaged source
    // window queues a redraw, Clutter.Clone forwards it from the source's
    // queue-redraw signal, it propagates up to bgActor, and Clutter re-runs
    // the whole effect with CLUTTER_EFFECT_PAINT_ACTOR_DIRTY. So dropping the
    // unconditional call loses nothing except the repaints nobody asked for.
    //
    // Measured before this change: dock 0.99 paints/frame (already damage
    // driven, because dockManager only touches geometry when it moves), but
    // every application window well above 1.0 — applicationManager's
    // per-frame _syncState() called setResolution()/setGlassGeometry() with
    // identical values every single frame and each one queued a repaint.
    _uniformsDirty = false;
    // Reused scratch buffer for the 1-component set_uniform_float() calls, so
    // the common path allocates nothing at all. Cogl copies the values out
    // during the call, so handing it the same array every time is safe.
    _uniformScratch = [0];
    /**
     * Sets a float uniform on the composite pipeline. If the pipeline hasn't
     * been created yet, the value is buffered in _pendingUniforms and applied
     * later in _applyPendingUniforms().
     */
    set(name, value) {
        // [PERF] _pendingUniforms is the authoritative buffered state, so an
        // unchanged value needs no work at all: it is already in the map, and
        // (if the pipeline exists) already in the pipeline.
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
        // [PERF] Skip the write when the pipeline already holds this exact value.
        // See _appliedUniforms. NaN can never satisfy === so it would be written
        // every time, but no uniform here is ever legitimately NaN.
        if (this._appliedUniforms.get(name) === value)
            return;
        // Cache the uniform location to avoid a get_uniform_location() call every frame.
        let loc = this._compUniforms.get(name);
        if (loc === undefined) {
            loc = this._pipeline.get_uniform_location(name);
            this._compUniforms.set(name, loc);
        }
        // set_uniform_float(loc, 1 component, 1 element, [value])
        this._uniformScratch[0] = value;
        this._pipeline.set_uniform_float(loc, 1, 1, this._uniformScratch);
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
    /**
     * Sets a float ARRAY uniform on the composite pipeline (e.g.
     * `uniform float region_x[16];` in glass.frag). Same buffering behavior as
     * _setFloat(): if the pipeline hasn't been created yet, the value is
     * buffered and applied later in _applyPendingUniforms().
     */
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
        // Store a copy: callers reuse and mutate their arrays between frames, so
        // keeping the caller's object would make the comparison above compare a
        // value against itself and never see a change.
        this._pendingUniformArrays.set(name, values.slice());
        this._uniformsDirty = true;
        if (this._pipeline) {
            this._applyUniformArray(name, values);
        }
    }
    _applyUniformArray(name, values) {
        if (!this._pipeline)
            return;
        // [PERF] Same dedup as _applyUniform, elementwise. The copy kept here is
        // deliberately ours: callers hand us arrays they may mutate in place, so
        // comparing against the array object itself would miss changes.
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
        // set_uniform_float(loc, 1 component, count elements, values[])
        this._pipeline.set_uniform_float(loc, 1, values.length, values);
        this._appliedUniformArrays.set(name, values.slice());
    }
}
