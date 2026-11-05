# Loam Recorder third-party notices

These notices stay with the recorder package. The vendor fetch does not prune them.

- OpenScreen editor and capture code: MIT, Siddharth Vaddem and OpenScreen contributors. The full text ships inside the vendored dist when `npm run vendor:recorder` installs a build of upstream `8ecc76b`.
- FFmpeg shared libraries used by the compositor: LGPL-2.1. The DLLs stay outside the application archive so they can be replaced. A source offer for the exact FFmpeg build is included with that package.
- onnxruntime, when the optional speech pack is installed: MIT.

The capture helper and compositor ship with the Windows package.
