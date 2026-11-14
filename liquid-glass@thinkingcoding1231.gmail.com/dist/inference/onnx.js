// Reads an ONNX model file: the protobuf wire format, as far as the graph,
// its nodes' attributes and the weights go.
const VARINT = 0, FIXED64 = 1, BYTES = 2, FIXED32 = 5;
const FLOAT = 1, UINT8 = 2, INT8 = 3, INT32 = 6, INT64 = 7, BOOL = 9, FLOAT16 = 10, DOUBLE = 11;

class Reader {
    bytes;
    end;
    pos;
    _view;

    constructor(bytes, start = 0, end = bytes.length) {
        this.bytes = bytes;
        this.end = end;
        this.pos = start;
        this._view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    get more() {
        return this.pos < this.end;
    }

    varint() {
        const b = this.bytes;
        let value = 0, scale = 1;
        const start = this.pos;
        for (let i = 0; i < 7; i++) {
            const byte = b[this.pos++];
            value += (byte & 0x7f) * scale;
            if (byte < 0x80)
                return value;
            scale *= 128;
        }
        // A long one: a negative number, or one past what a double holds exactly.
        this.pos = start;
        let big = 0n, shift = 0n;
        for (;;) {
            const byte = b[this.pos++];
            big |= BigInt(byte & 0x7f) << shift;
            if (byte < 0x80)
                break;
            shift += 7n;
        }
        return Number(BigInt.asIntN(64, big));
    }

    float() {
        const v = this._view.getFloat32(this.pos, true);
        this.pos += 4;
        return v;
    }

    // A length-delimited field's bytes, as a reader over them.
    sub() {
        const length = this.varint();
        const r = new Reader(this.bytes, this.pos, this.pos + length);
        this.pos += length;
        return r;
    }

    slice() {
        const length = this.varint();
        const out = this.bytes.subarray(this.pos, this.pos + length);
        this.pos += length;
        return out;
    }

    string() {
        return new TextDecoder().decode(this.slice());
    }

    skip(wire) {
        if (wire === VARINT)
            this.varint();
        else if (wire === FIXED64)
            this.pos += 8;
        else if (wire === BYTES)
            this.slice();
        else if (wire === FIXED32)
            this.pos += 4;
        else
            throw new Error(`unknown wire type ${wire}`);
    }

    // Calls `field` for every field; it returns false for the ones it leaves unread.
    each(field) {
        while (this.more) {
            const tag = this.varint();
            const wire = tag & 7;
            if (field(Math.floor(tag / 8), wire) === false)
                this.skip(wire);
        }
    }

    // A repeated number field's values, packed or one a field.
    numbers(wire, into) {
        if (wire !== BYTES) {
            into.push(this.varint());
            return;
        }
        const r = this.sub();
        while (r.more)
            into.push(r.varint());
    }
}

function halfToFloat(h) {
    const exponent = (h >> 10) & 0x1f;
    const fraction = h & 0x3ff;
    const sign = h & 0x8000 ? -1 : 1;
    if (exponent === 0)
        return sign * fraction * 2 ** -24;
    if (exponent === 31)
        return fraction ? NaN : sign * Infinity;
    return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

function readTensor(r) {
    const tensor = { dims: [], type: 0, raw: null, floats: [], ints: [] };
    let name = '';
    r.each((number, wire) => {
        if (number === 1) {
            r.numbers(wire, tensor.dims);
        }
        else if (number === 2) {
            tensor.type = r.varint();
        }
        else if (number === 4) {
            const f = r.sub();
            while (f.more)
                tensor.floats.push(f.float());
        }
        else if (number === 5 || number === 7) {
            r.numbers(wire, tensor.ints);
        }
        else if (number === 8) {
            name = r.string();
        }
        else if (number === 9) {
            tensor.raw = r.slice();
        }
        else {
            return false;
        }
    });
    return { name, tensor };
}

function decode(t) {
    const dims = t.dims;
    const size = dims.reduce((a, b) => a * b, 1);
    if (!t.raw) {
        if (t.type === FLOAT)
            return { dims, data: Float32Array.from(t.floats) };
        if (t.type === UINT8 || t.type === BOOL)
            return { dims, data: Uint8Array.from(t.ints) };
        return { dims, data: Float64Array.from(t.ints), int: true };
    }
    const raw = t.raw;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    switch (t.type) {
        case FLOAT: {
            // A copy, since the file's bytes are not aligned for a view of floats.
            return { dims, data: new Float32Array(raw.slice().buffer) };
        }
        case FLOAT16: {
            const data = new Float32Array(size);
            for (let i = 0; i < size; i++)
                data[i] = halfToFloat(view.getUint16(i * 2, true));
            return { dims, data };
        }
        case DOUBLE: {
            const data = new Float32Array(size);
            for (let i = 0; i < size; i++)
                data[i] = view.getFloat64(i * 8, true);
            return { dims, data };
        }
        case UINT8:
        case BOOL:
            return { dims, data: raw.slice() };
        case INT8: {
            const data = new Float64Array(size);
            for (let i = 0; i < size; i++)
                data[i] = view.getInt8(i);
            return { dims, data, int: true };
        }
        case INT32: {
            const data = new Float64Array(size);
            for (let i = 0; i < size; i++)
                data[i] = view.getInt32(i * 4, true);
            return { dims, data, int: true };
        }
        case INT64: {
            const data = new Float64Array(size);
            for (let i = 0; i < size; i++)
                data[i] = Number(view.getBigInt64(i * 8, true));
            return { dims, data, int: true };
        }
        default:
            throw new Error(`unsupported tensor type ${t.type}`);
    }
}

function readAttribute(r) {
    let name = '';
    let value = 0;
    const ints = [];
    const floats = [];
    r.each((number, wire) => {
        if (number === 1) {
            name = r.string();
        }
        else if (number === 2) {
            value = r.float();
        }
        else if (number === 3) {
            value = r.varint();
        }
        else if (number === 4) {
            value = r.string();
        }
        else if (number === 5) {
            value = decode(readTensor(r.sub()).tensor);
        }
        else if (number === 7) {
            if (wire === BYTES) {
                const f = r.sub();
                while (f.more)
                    floats.push(f.float());
            }
            else {
                floats.push(r.float());
            }
        }
        else if (number === 8) {
            r.numbers(wire, ints);
        }
        else {
            return false;
        }
    });
    if (ints.length)
        value = ints;
    else if (floats.length)
        value = floats;
    return [name, value];
}

function readNode(r) {
    const node = { op: '', inputs: [], outputs: [], attributes: {} };
    r.each(number => {
        if (number === 1) {
            node.inputs.push(r.string());
        }
        else if (number === 2) {
            node.outputs.push(r.string());
        }
        else if (number === 4) {
            node.op = r.string();
        }
        else if (number === 5) {
            const [name, value] = readAttribute(r.sub());
            node.attributes[name] = value;
        }
        else {
            return false;
        }
    });
    return node;
}

function readValueName(r) {
    let name = '';
    r.each(number => {
        if (number !== 1)
            return false;
        name = r.string();
    });
    return name;
}

/** The model in an .onnx file's bytes. The weights stay views into `bytes` until they are used. */
export function parseModel(bytes) {
    const nodes = [];
    const raw = new Map();
    const decoded = new Map();
    const inputs = [];
    const outputs = [];
    // The graph is the model's field 7.
    const top = new Reader(bytes);
    top.each((number, wire) => {
        if (number !== 7 || wire !== BYTES)
            return false;
        const graph = top.sub();
        graph.each(field => {
            if (field === 1) {
                nodes.push(readNode(graph.sub()));
            }
            else if (field === 5) {
                const { name, tensor } = readTensor(graph.sub());
                raw.set(name, tensor);
            }
            else if (field === 11) {
                inputs.push(readValueName(graph.sub()));
            }
            else if (field === 12) {
                outputs.push(readValueName(graph.sub()));
            }
            else {
                return false;
            }
        });
    });
    return {
        nodes,
        inputs: inputs.filter(name => !raw.has(name)),
        outputs,
        has: name => raw.has(name),
        initializer(name) {
            let tensor = decoded.get(name);
            if (!tensor) {
                const source = raw.get(name);
                if (!source)
                    return undefined;
                tensor = decode(source);
                decoded.set(name, tensor);
            }
            return tensor;
        },
        release: name => void decoded.delete(name),
    };
}
