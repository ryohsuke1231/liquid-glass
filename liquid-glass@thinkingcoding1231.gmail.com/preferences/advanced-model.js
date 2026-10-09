export const SURFACE_OPTIONS = [
  ['dock', 'Dock', 'enable-dock-glass'],
  ['menu', 'Calendar', 'enable-menu-glass'],
  ['panel-menu', 'Other top bar menus', 'enable-extra-menu-glass',
    'Menus of the other top bar indicators: keyboard layout, accessibility, extensions'],
  ['notification', 'Notifications', 'enable-notification-glass'],
  ['quick-settings', 'Quick settings', 'enable-quick-settings-glass'],
  ['osd', 'Volume and brightness', 'enable-osd-glass'],
  ['application', 'Application windows', 'enable-application-glass'],
  ['desktop-menu', 'Desktop menu', 'enable-desktop-menu-glass'],
  ['top-bar', 'Top bar', null],
  ['desktop-widget', 'Desktop widgets', null],
  ['launcher', 'Launcher', null],
];

export const APPEARANCE = [
  ['blur-radius', 'Blur', 0, 30, 1],
  ['corner-radius', 'Corners', 0, 200, 1],
  ['tint-strength', 'Tint strength', 0, 1, 0.01],
  ['brightness', 'Brightness', 0.5, 1.5, 0.01],
  ['contrast', 'Contrast', 0.5, 1.5, 0.01],
  ['saturation', 'Saturation', 0, 2, 0.01],
];

export const LAYOUT = {
  dock: [['glass-expand', 'Glass expansion', 0, 50, 1], ['margin-bottom', 'Edge spacing', -5, 30, 1]],
  menu: [['glass-expand', 'Glass expansion', 0, 50, 1], ['x-offset', 'Horizontal offset', -200, 200, 1],
    ['y-offset', 'Vertical offset', -50, 100, 1], ['scale', 'Menu scale', 0.5, 1, 0.01]],
  'panel-menu': [['glass-expand', 'Glass expansion', 0, 50, 1], ['x-offset', 'Horizontal offset', -200, 200, 1],
    ['y-offset', 'Vertical offset', -50, 100, 1], ['scale', 'Menu scale', 0.5, 1, 0.01]],
  notification: [['glass-expand', 'Glass expansion', 0, 50, 1], ['y-offset', 'Vertical offset', 0, 100, 1]],
  'quick-settings': [['glass-expand', 'Glass expansion', 0, 50, 1], ['x-offset', 'Horizontal offset', -100, 100, 1],
    ['y-offset', 'Vertical offset', -100, 100, 1], ['toggle-tint-strength', 'Button base color', 0, 1, 0.01],
    ['toggle-corner-radius', 'Button corners', 0, 60, 1]],
  osd: [['glass-expand', 'Glass expansion', 0, 50, 1], ['y-offset', 'Vertical offset', -100, 100, 1]],
  application: [],
  'desktop-menu': [['content-opacity', 'Content opacity', 0, 1, 0.01]],
  'top-bar': [['margin-top', 'Margin top', 0, 50, 1], ['margin-bottom', 'Margin bottom', 0, 50, 1],
    ['margin-left', 'Margin left', 0, 50, 1], ['margin-right', 'Margin right', 0, 50, 1],
    ['padding-top', 'Padding top', 0, 50, 1], ['padding-bottom', 'Padding bottom', 0, 50, 1],
    ['padding-left', 'Padding left', 0, 50, 1], ['padding-right', 'Padding right', 0, 50, 1]],
  'desktop-widget': [],
  launcher: [],
};

export const SPRING = [
  ['spring-stiffness', 'Spring stiffness', 0, 1000, 0.1],
  ['spring-damping', 'Spring damping', 0, 1000, 0.1],
  ['spring-mass', 'Spring mass', 0, 1, 0.1],
  ['animation-interval-ms', 'Animation interval (ms)', 0, 50, 1],
];

export const OPTICS = [
  ['glass-max-z', 'Thickness', 0, 100, 1],
  ['glass-displacement-scale', 'Refraction', 0, 200, 1],
  ['glass-edge-smoothing', 'Edge smoothing', 0, 10, 0.1],
  ['glass-profile-shape-n', 'Surface curvature', 1, 20, 0.1],
  ['glass-ior', 'Index of refraction', 1, 4, 0.01],
  ['glass-chroma-strength', 'Color separation', 0, 1, 0.01],
  ['glass-corner-smoothing', 'Corner smoothing', 0, 1, 0.01],
];

export const LIGHTING = [
  ['glass-specular-intensity', 'Highlights', 0, 5, 0.1],
  ['glass-shininess', 'Shininess', 1, 200, 1],
  ['glass-rim-width', 'Edge light width', 0, 20, 0.1],
  ['glass-rim-intensity', 'Edge light', 0, 5, 0.1],
  ['glass-rim-directional-power', 'Edge directionality', 0, 10, 0.1],
  ['glass-rim-power', 'Edge falloff', 0, 20, 0.1],
  ['glass-rim-light-color-intensity', 'Edge color strength', 0, 5, 0.1],
  ['glass-sheen-intensity', 'Sheen', 0, 2, 0.01],
  ['glass-light-angle-deg', 'Light angle', 0, 360, 1],
];

export const SHADOWS = [
  ['shadow-radius', 'Shadow radius', 0, 100, 1],
  ['shadow-intensity', 'Shadow strength', 0, 1, 0.01],
  ['glass-ao-intensity', 'Inner shading', 0, 1, 0.01],
  ['glass-ao-radius', 'Inner shading radius', 0, 50, 0.5],
];
