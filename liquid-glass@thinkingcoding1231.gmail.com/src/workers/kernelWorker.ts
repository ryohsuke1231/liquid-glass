// A helper process (gjs -m) of the wallpaper analysis: computes the matrix
// products and convolutions kernelPool.ts asks for on stdin, a line of JSON
// each, writes the result to the file the request names and answers "done",
// until stdin closes.
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';

import { convolve, matmul } from '../inference/kernels.js';
import { type KernelRequest, mapFloats, writeFloats } from '../inference/kernelPool.js';

const input = new Gio.DataInputStream({ base_stream: new GioUnix.InputStream({ fd: 0, close_fd: false }) });
const output = new GioUnix.OutputStream({ fd: 1, close_fd: false });
const done = new TextEncoder().encode('done\n');

for (;;) {
  const [line] = input.read_line_utf8(null);
  if (line === null) break;
  const request = JSON.parse(line) as KernelRequest;
  let result: Float32Array;
  if (request.op === 'matmul') {
    result = new Float32Array(request.n * request.m);
    matmul(mapFloats(request.a), mapFloats(request.b), request.n, request.k, request.m, result);
  } else {
    const bias = request.bias ? mapFloats(request.bias) : new Float32Array(0);
    result = convolve(mapFloats(request.x), mapFloats(request.weights), bias, request.count, request.shape);
  }
  writeFloats(request.result, result);
  output.write_all(done, null);
}
