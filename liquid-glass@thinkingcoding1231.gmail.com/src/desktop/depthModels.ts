// The models the wallpaper analysis runs, where they are downloaded from and
// where they are kept. Read by the shell and by the preferences.
import GLib from 'gi://GLib';

export interface ModelFile {
  title: string;
  file: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** Depth Anything V2 Small (Apache-2.0), as onnx-community publishes it in half floats. */
export const DEPTH_MODEL: ModelFile = {
  title: 'Depth Anything V2 Small',
  file: 'depth-anything-v2-small-fp16.onnx',
  url: 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_fp16.onnx',
  sha256: '2df6223f206b5164e21f664ace61dabeb9bb6a49b8b5a3e00510b4807d0f5b04',
  bytes: 49642442,
};

/** The small U²-Net (Apache-2.0), as the rembg project publishes it. */
export const SUBJECT_MODEL: ModelFile = {
  title: 'U²-Net (small)',
  file: 'u2netp.onnx',
  url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
  sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',
  bytes: 4574861,
};

export const MODELS = [DEPTH_MODEL, SUBJECT_MODEL];

export function modelPath(model: ModelFile): string {
  return GLib.build_filenamev([GLib.get_user_data_dir(), 'liquid-glass', 'models', model.file]);
}

export function hasModel(model: ModelFile): boolean {
  return GLib.file_test(modelPath(model), GLib.FileTest.IS_REGULAR);
}

/** Where the wallpapers' depth maps are kept. */
export function depthCacheDir(): string {
  return GLib.build_filenamev([GLib.get_user_cache_dir(), 'liquid-glass', 'wallpaper-depth']);
}
