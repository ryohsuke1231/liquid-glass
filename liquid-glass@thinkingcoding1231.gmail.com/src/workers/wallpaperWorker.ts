// Finds what is near and what is the subject in a wallpaper, in a process of
// its own (gjs -m) with helpers for the arithmetic (kernelWorker.js). Answers
// {file, style, width, height, depthModel, subjectModel, cache} by writing the
// depth map of the picture as the monitor shows it to `cache` and saying
// {width, height, seconds}, with how far it has come meanwhile.
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
  type PictureStyle, encodeDepthMap, guidedFilter, mapSize, modelSize, normalized, packDepthMap, pictureRect, resizePlane
} from '../desktop/depthMap.js';
import { KernelPool } from '../inference/kernelPool.js';
import { parseModel } from '../inference/onnx.js';
import { runModel } from '../inference/runner.js';
import { serveRequests } from './workerProcess.js';

interface Request {
  file: string;
  style: PictureStyle;
  // The monitor's size.
  width: number;
  height: number;
  depthModel: string;
  // Empty to go without the subject.
  subjectModel: string;
  cache: string;
}

// The depth model's longer side and patch size, and the subject model's square input, px.
const DEPTH_LONG = 518;
const DEPTH_PATCH = 14;
const SUBJECT_SIZE = 320;
// What both models' inputs are normalized with.
const MEAN = [0.485, 0.456, 0.406];
const DEVIATION = [0.229, 0.224, 0.225];
// How far (in map px for a map as wide as the depth model's output) an edge is looked for, and how flat counts as flat.
const GUIDE_REACH = 3;
const GUIDE_EPSILON = 4e-4;
// The maps kept in the cache; the oldest go first.
const KEPT_MAPS = 40;
// How far the work has come once the picture is read and once both models have run, and the depth model's share
// of the time the two take.
const LOADED = 0.08;
const DONE = 0.97;
const DEPTH_SHARE = 0.66;

// The picture as a monitor of width x height shows it, at the map's size.
function monitorView(file: string, style: PictureStyle, width: number, height: number): GdkPixbuf.Pixbuf {
  const loaded = GdkPixbuf.Pixbuf.new_from_file(file);
  const picture = loaded.apply_embedded_orientation() ?? loaded;
  const [mw, mh] = mapSize(width, height);
  const view = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, mw, mh)!;
  view.fill(0x000000ff);
  const k = mw / width;
  const [x, y, w, h] = pictureRect(style, picture.width, picture.height, width, height).map(v => v * k);
  const x0 = Math.max(Math.floor(x), 0), y0 = Math.max(Math.floor(y), 0);
  const x1 = Math.min(Math.ceil(x + w), mw), y1 = Math.min(Math.ceil(y + h), mh);
  if (x1 > x0 && y1 > y0)
    picture.scale(view, x0, y0, x1 - x0, y1 - y0, x, y, w / picture.width, h / picture.height, GdkPixbuf.InterpType.BILINEAR);
  return view;
}

// The pixbuf's colours as three planes, each through `value`.
function planes(pixbuf: GdkPixbuf.Pixbuf, value: (v: number, channel: number) => number): Float32Array {
  const { width, height, rowstride, n_channels: channels } = pixbuf;
  const pixels = pixbuf.get_pixels();
  const out = new Float32Array(3 * width * height);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) out[(c * height + y) * width + x] = value(pixels[y * rowstride + x * channels + c], c);
    }
  }
  return out;
}

function modelInput(view: GdkPixbuf.Pixbuf, width: number, height: number) {
  const scaled = view.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR)!;
  return { dims: [1, 3, height, width], data: planes(scaled, (v, c) => (v / 255 - MEAN[c]) / DEVIATION[c]) };
}

// The model's first output for `view` resized to width x height, as a plane of that size in 0..1.
function infer(path: string, view: GdkPixbuf.Pixbuf, width: number, height: number, pool: KernelPool,
  progress: (fraction: number) => void): Float32Array {
  const model = parseModel(GLib.MappedFile.new(path, false).get_bytes().toArray());
  const outputs = runModel(model, { [model.inputs[0]]: modelInput(view, width, height) }, pool, progress);
  const out = outputs[model.outputs[0]];
  if (out.data.length !== width * height) throw new Error(`the model answered with [${out.dims}]`);
  return normalized(out.data as Float32Array);
}

function write(path: string, bytes: Uint8Array): void {
  GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
  Gio.File.new_for_path(path).replace_contents(bytes, null, false, Gio.FileCreateFlags.NONE, null);
}

// Deletes the oldest maps beyond KEPT_MAPS from the cache folder.
function prune(folder: string): void {
  const files: { path: string, modified: number }[] = [];
  const children = Gio.File.new_for_path(folder).enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
  for (let info = children.next_file(null); info; info = children.next_file(null))
    files.push({ path: GLib.build_filenamev([folder, info.get_name()]), modified: info.get_attribute_uint64('time::modified') });
  files.sort((a, b) => b.modified - a.modified);
  for (const { path } of files.slice(KEPT_MAPS)) GLib.unlink(path);
}

await serveRequests(async (request: Request, report) => {
  const started = GLib.get_monotonic_time();
  // Told in whole percents, each once.
  let told = -1;
  const reach = (from: number, to: number) => (fraction: number) => {
    const percent = Math.floor((from + (to - from) * fraction) * 100);
    if (percent === told) return;
    told = percent;
    report(percent / 100);
  };
  const depthShare = request.subjectModel ? DEPTH_SHARE : 1;
  const view = monitorView(request.file, request.style, request.width, request.height);
  const { width, height } = view;
  const guide = planes(view, v => v / 255);
  const plane = width * height;
  const luminance = new Float32Array(plane);
  for (let i = 0; i < plane; i++) luminance[i] = 0.299 * guide[i] + 0.587 * guide[plane + i] + 0.114 * guide[2 * plane + i];
  const radius = Math.max(Math.round(GUIDE_REACH * width / DEPTH_LONG), 1);
  const refine = (values: Float32Array, w: number, h: number) =>
    guidedFilter(resizePlane(values, w, h, width, height), luminance, width, height, radius, GUIDE_EPSILON);

  const [script] = GLib.filename_from_uri(import.meta.url);
  reach(0, LOADED)(1);
  const pool = new KernelPool(GLib.build_filenamev([GLib.path_get_dirname(script), 'kernelWorker.js']));
  try {
    const [dw, dh] = modelSize(width, height, DEPTH_LONG, DEPTH_PATCH);
    const depth = refine(infer(request.depthModel, view, dw, dh, pool, reach(LOADED, LOADED + (DONE - LOADED) * depthShare)), dw, dh);
    const subject = request.subjectModel
      ? refine(infer(request.subjectModel, view, SUBJECT_SIZE, SUBJECT_SIZE, pool, reach(LOADED + (DONE - LOADED) * depthShare, DONE)),
        SUBJECT_SIZE, SUBJECT_SIZE)
      : null;
    write(request.cache, encodeDepthMap(packDepthMap(depth, subject, width, height)));
    prune(GLib.path_get_dirname(request.cache));
  } finally {
    pool.destroy();
  }
  return { width, height, seconds: (GLib.get_monotonic_time() - started) / 1e6 };
});
