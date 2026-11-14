import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

import { MODELS, hasModel, modelPath } from '../dist/desktop/depthModels.js';

const USER_AGENT = 'liquid-glass-gnome-extension';
const CHUNK = 1 << 18;

const STATUS = {
  '': 'Turn the clock on to see this',
  'off': 'Off',
  'no-model': 'The models are not downloaded',
  'unsupported': 'This wallpaper cannot be analysed (a slideshow, a tiled picture or none)',
  'waiting': 'Not analysed yet',
  'analysing': 'Analysing…',
  'ready': 'Analysed',
  'failed': 'The analysis failed',
};

function megabytes(bytes) {
  return `${Math.round(bytes / 1e6)} MB`;
}

function isCancelled(error) {
  return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function promise(start, finish) {
  return new Promise((resolve, reject) => start((_source, res) => {
    try {
      resolve(finish(res));
    } catch (error) {
      reject(error);
    }
  }));
}

// Downloads `model` to its place, checking it against its checksum. `progress` gets the bytes so far.
async function downloadModel(session, model, cancellable, progress) {
  const path = modelPath(model);
  GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
  const part = Gio.File.new_for_path(`${path}.part`);
  const message = Soup.Message.new('GET', model.url);
  const input = await promise(done => session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable, done),
    res => session.send_finish(res));
  if (message.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${message.get_status()}`);
  const output = await promise(done => part.replace_async(null, false, Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, done),
    res => part.replace_finish(res));
  const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);
  let received = 0;
  try {
    for (;;) {
      const bytes = await promise(done => input.read_bytes_async(CHUNK, GLib.PRIORITY_DEFAULT, cancellable, done),
        res => input.read_bytes_finish(res));
      if (bytes.get_size() === 0) break;
      checksum.update(bytes.toArray());
      await promise(done => output.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, cancellable, done),
        res => output.write_bytes_finish(res));
      received += bytes.get_size();
      progress(received);
    }
    await promise(done => output.close_async(GLib.PRIORITY_DEFAULT, cancellable, done), res => output.close_finish(res));
    if (checksum.get_string() !== model.sha256) throw new Error('the file is not the expected one');
    part.move(Gio.File.new_for_path(path), Gio.FileCopyFlags.OVERWRITE, null, null);
  } catch (error) {
    // Throws a GError when the part is already gone.
    try {
      part.delete(null);
    } catch {
    }
    throw error;
  }
}

/** The rows for the clock standing behind the wallpaper; returns them for the caller's branch. */
export function clockDepthRows(group, controls) {
  const settings = controls.settings;
  const enable = controls.toggle(group, 'Stand behind the wallpaper', 'glass-clock-depth',
    'Parts of the clock are hidden behind a mountain ridge, a building or the subject of the wallpaper, where there is one. ' +
    'The wallpaper is analysed on this computer.');

  const total = MODELS.reduce((sum, model) => sum + model.bytes, 0);
  const models = new Adw.ActionRow({ title: 'Models' });
  const fetch = new Gtk.Button({ label: 'Download', valign: Gtk.Align.CENTER });
  models.add_suffix(fetch);
  group.add(models);
  const showModels = (note = '') => {
    const have = MODELS.every(hasModel);
    fetch.visible = !have;
    models.subtitle = note || (have
      ? MODELS.map(model => model.title).join(' and ')
      : `${megabytes(total)}, from huggingface.co and github.com: ${MODELS.map(model => model.title).join(' and ')}`);
  };
  showModels();

  let cancellable = null;
  fetch.connect('clicked', async () => {
    cancellable = new Gio.Cancellable();
    fetch.sensitive = false;
    const session = new Soup.Session({ user_agent: USER_AGENT, timeout: 60 });
    try {
      let before = 0;
      for (const model of MODELS) {
        if (!hasModel(model)) {
          await downloadModel(session, model, cancellable,
            received => { models.subtitle = `Downloading… ${Math.floor((before + received) * 100 / total)} %`; });
        }
        before += model.bytes;
      }
      showModels();
      // The extension looks for the models again.
      settings.set_int('glass-clock-depth-request', settings.get_int('glass-clock-depth-request') + 1);
    } catch (error) {
      if (!isCancelled(error)) showModels(`The download failed: ${error.message ?? error}`);
    }
    fetch.sensitive = true;
  });
  controls.onClose(() => cancellable?.cancel());

  const auto = controls.toggle(group, 'Analyse new wallpapers automatically', 'glass-clock-depth-auto',
    'A few seconds after a wallpaper is set. Each one is analysed once and remembered.');
  const state = new Adw.ActionRow({ title: 'This wallpaper' });
  const analyse = new Gtk.Button({ label: 'Analyse Now', valign: Gtk.Align.CENTER });
  analyse.connect('clicked', () => {
    settings.set_int('glass-clock-depth-request', settings.get_int('glass-clock-depth-request') + 1);
  });
  state.add_suffix(analyse);
  group.add(state);
  controls.watch(['glass-clock-depth-status'], () => {
    const status = settings.get_string('glass-clock-depth-status');
    state.subtitle = STATUS[status] ?? status;
    analyse.sensitive = status === 'waiting' || status === 'failed';
  });
  controls.watch(['glass-clock-depth'], () => {
    for (const row of [models, auto, state]) row.sensitive = enable.active;
  });
  return [enable, models, auto, state];
}
