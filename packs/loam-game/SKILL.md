---
name: loam-game
description: Build and verify a playable HTML5 Canvas game.
---

# Loam Game

1. Use plain HTML5 Canvas 2D and JavaScript with no external runtime dependency.
2. Include a game loop, input handling, collision/state, score and restart.
3. Keep `window.__errors` and `window.onerror` so verification can prove there are no runtime errors.
4. Serve the preview and check interaction when browser tools are available.
5. Finish with `game_present` only after `index.html` contains the canvas, loop, input and error capture.
