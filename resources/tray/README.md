# Native tray assets

- `trayTemplate.svg`: editable monochrome mascot source. White areas are cutouts in the exported PNG alpha mask, not opaque white pixels.
- `trayTemplate.png`: 18 × 18 pixels, 72 dpi, transparent black template for the macOS menu bar.
- `trayTemplate@2x.png`: 36 × 36 pixels, 144 dpi. Keep the `Template` and `@2x` names so Electron loads both scale factors.
- `tray.ico`: the existing `app-icon.png` exported at 16, 20, 24, 32, 40, 48, 64 and 256 pixels for Windows taskbar scaling.

PNG and ICO assets are committed and copied unchanged to the packaged `tray` directory. No icon conversion is required on CI.
