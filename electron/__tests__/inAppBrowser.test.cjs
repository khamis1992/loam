// Unit tests for the visibility state machine of electron/inAppBrowser.cjs
// (in-app browser floating over the app fix).
//
// The module under test does require("electron") for WebContentsView and
// BrowserWindow, which does not work under plain `node --test`, so "electron"
// is mocked through a Module._load hook. The module keeps its attachment and
// visibility in module-level lets, therefore every test loads a FRESH module
// instance against its own mock window. Run with:
//   node --test electron/__tests__/inAppBrowser.test.cjs
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const Module = require("node:module");

function makeMockView() {
  return {
    visible: false,
    bounds: null,
    webContents: {
      isDestroyed: () => false,
      getURL: () => "",
      getTitle: () => "",
      isLoading: () => false,
      canGoBack: () => false,
      canGoForward: () => false,
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
        goBack: () => undefined,
        goForward: () => undefined,
      },
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
    },
    setBackgroundColor: () => undefined,
    setBounds(rect) {
      this.bounds = rect;
    },
    setVisible(v) {
      this.visible = v;
    },
  };
}

class MockWindow {
  constructor() {
    this.destroyed = false;
    this.contentView = {
      children: [],
      addChildView(v) {
        this.children.push(v);
      },
      removeChildView(v) {
        const i = this.children.indexOf(v);
        if (i >= 0) this.children.splice(i, 1);
      },
    };
    this.webContents = { isDestroyed: () => false, send: () => undefined };
  }
  isDestroyed() {
    return this.destroyed;
  }
  on() {}
  once() {}
}

const mockElectron = {
  WebContentsView: class MockWebContentsView {
    constructor(_opts) {
      Object.assign(this, makeMockView());
    }
  },
  BrowserWindow: MockWindow,
};

/** Require a brand-new copy of the module while the electron mock is active. */
function loadFreshModule() {
  const modulePath = require.resolve("../inAppBrowser.cjs");
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "electron") return mockElectron;
    return originalLoad.apply(this, [request, ...rest]);
  };
  try {
    return require("../inAppBrowser.cjs");
  } finally {
    Module._load = originalLoad;
  }
}

function freshHost() {
  const win = new MockWindow();
  const iab = loadFreshModule();
  iab.init({ getWindow: () => win, openExternal: () => undefined, resolveHomepage: async () => "" });
  return { win, iab };
}

describe("inAppBrowser visibility state machine", () => {
  it("a fresh attach starts the view hidden and it shows only after setVisible(true)", () => {
    const { win, iab } = freshHost();

    iab.handlers.attach();
    assert.equal(iab.state().attached, true);
    assert.equal(win.contentView.children.length, 1);
    const view = win.contentView.children[0];
    assert.equal(view.visible, false, "attach() must start the view hidden");
    assert.equal(iab.state().visible, false);

    // The renderer opts in once it measured bounds and the pane is on screen.
    const st = iab.handlers.setVisible(null, true);
    assert.equal(view.visible, true);
    assert.equal(st.visible, true);
    assert.equal(iab.state().visible, true);

    iab.handlers.setVisible(null, false);
    assert.equal(view.visible, false);
  });

  it("setVisible(true) never shows a view that is not attached; detach removes the child view", () => {
    const { win, iab } = freshHost();

    // Nothing attached at all: the demand alone must not create or show a view.
    iab.handlers.setVisible(null, true);
    assert.equal(iab.state().attached, false);
    assert.equal(win.contentView.children.length, 0);
    assert.equal(iab.state().visible, false);

    // Attached -> shown -> detached: the view leaves the window and stays hidden.
    iab.handlers.attach();
    const view = win.contentView.children[0];
    iab.handlers.setVisible(null, true);
    assert.equal(view.visible, true);
    iab.handlers.detach();
    assert.equal(win.contentView.children.length, 0, "detach() removes the child view");
    assert.equal(iab.state().attached, false);
    assert.equal(view.visible, false, "detached view must be hidden");
    // Demanding visibility again while detached must not paint it.
    iab.handlers.setVisible(null, true);
    assert.equal(view.visible, false);
    assert.equal(iab.state().visible, false);
  });

  it("window blur/minimize hides the view even when the renderer wants it; focus restores", () => {
    const { win, iab } = freshHost();

    iab.handlers.attach();
    const view = win.contentView.children[0];
    iab.handlers.setVisible(null, true);
    assert.equal(view.visible, true);

    // blur/minimize/hide -> setWindowAllows(false) wins over the renderer
    // intent: the view is hidden but stays attached with its page kept.
    iab.setWindowAllows(false);
    assert.equal(view.visible, false);
    assert.equal(iab.state().visible, false);
    assert.equal(iab.state().attached, true, "hiding must not detach");
    assert.equal(win.contentView.children.length, 1);

    // focus/restore/show -> the window factor returns; the renderer still
    // wants the view, so it is painted again.
    iab.setWindowAllows(true);
    assert.equal(view.visible, true);
    assert.equal(iab.state().visible, true);
  });

  it("hide() force-hides without detaching and only a new setVisible(true) re-shows", () => {
    const { win, iab } = freshHost();

    iab.handlers.attach();
    const view = win.contentView.children[0];
    iab.handlers.setVisible(null, true);
    assert.equal(view.visible, true);

    iab.hide();
    assert.equal(view.visible, false);
    assert.equal(iab.state().attached, true, "hide() keeps the view attached");
    assert.equal(win.contentView.children.length, 1);

    // Window events coming back must not resurrect a force-hide that the
    // renderer (or host) has not re-requested yet.
    iab.setWindowAllows(false);
    iab.setWindowAllows(true);
    assert.equal(view.visible, false);

    iab.handlers.setVisible(null, true);
    assert.equal(view.visible, true);
  });
});
