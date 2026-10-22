//! Loam host bridge: lets the Loam page that embeds this app in an `<iframe>` drive it.
//!
//! Active only when the page URL carries `loam=1`. Messages are plain objects with a `type`:
//! - host -> app: `{type: "craft:call", id, method, params}` runs a control-channel method
//!   (`engine.execute`, `engine.commands`, `document.inspect`, `ui.inspect`, …) exactly as the
//!   desktop app's control server would; `{type: "craft:open", name, bytes: Uint8Array}` opens a
//!   file as if it was dropped on the window.
//! - app -> host: `{type: "craft:ready", app, version}`, `{type: "craft:result", id, ok, result?,
//!   error?}`, `{type: "craft:save", app, name, bytes}` (every save/export is handed to the host
//!   instead of being downloaded).
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::mpsc::{Receiver, Sender, TryRecvError};

use serde_json::Value;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast as _, JsValue};

pub type Opens = Rc<RefCell<Vec<(String, Vec<u8>)>>>;

pub fn embedded() -> bool {
    web_sys::window().and_then(|w| w.location().search().ok()).is_some_and(|q| q.contains("loam=1"))
}

fn post(fields: &[(&str, JsValue)]) -> bool {
    let Some(window) = web_sys::window() else { return false };
    let Ok(Some(parent)) = window.parent() else { return false };
    let msg = js_sys::Object::new();
    for (k, v) in fields {
        if js_sys::Reflect::set(&msg, &JsValue::from_str(k), v).is_err() {
            return false;
        }
    }
    parent.post_message(&msg, "*").is_ok()
}

fn to_js(v: &Value) -> JsValue {
    js_sys::JSON::parse(&v.to_string()).unwrap_or(JsValue::NULL)
}

/// Hands a save or export to the host. Returns `false` when not embedded (download as usual).
pub fn post_save(app: &str, path: &str, bytes: &[u8]) -> bool {
    if !embedded() {
        return false;
    }
    let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string());
    let buf = js_sys::Uint8Array::from(bytes);
    post(&[("type", "craft:save".into()), ("app", app.into()), ("name", name.as_str().into()), ("bytes", buf.into())])
}

pub struct Bridge {
    app: &'static str,
    version: &'static str,
    calls: Rc<RefCell<Vec<(JsValue, String, Value)>>>,
    pending: Vec<(JsValue, Receiver<Value>)>,
    pub opens: Opens,
    ready: bool,
}

impl Bridge {
    pub fn install(app: &'static str, version: &'static str, ctx: egui::Context) -> Option<Self> {
        if !embedded() {
            return None;
        }
        let window = web_sys::window()?;
        let calls: Rc<RefCell<Vec<(JsValue, String, Value)>>> = Rc::default();
        let opens: Opens = Rc::default();
        let (c, o) = (calls.clone(), opens.clone());
        let parent: Option<JsValue> = window.parent().ok().flatten().map(Into::into);
        let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |e: web_sys::MessageEvent| {
            if let (Some(p), Some(src)) = (&parent, e.source()) {
                let src: JsValue = src.into();
                if &src != p {
                    return;
                }
            }
            let data = e.data();
            let get = |k: &str| js_sys::Reflect::get(&data, &JsValue::from_str(k)).unwrap_or(JsValue::UNDEFINED);
            match get("type").as_string().as_deref() {
                Some("craft:call") => {
                    let method = get("method").as_string().unwrap_or_default();
                    let params = js_sys::JSON::stringify(&get("params")).ok().and_then(|s| s.as_string()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Object(Default::default()));
                    let params = if params.is_null() { Value::Object(Default::default()) } else { params };
                    c.borrow_mut().push((get("id"), method, params));
                }
                Some("craft:open") => {
                    let name = get("name").as_string().unwrap_or_else(|| "file".into());
                    let bytes = get("bytes").dyn_into::<js_sys::Uint8Array>().map(|a| a.to_vec()).unwrap_or_default();
                    o.borrow_mut().push((name, bytes));
                }
                _ => return,
            }
            ctx.request_repaint();
        });
        window.add_event_listener_with_callback("message", on_message.as_ref().unchecked_ref()).ok()?;
        on_message.forget();
        Some(Self { app, version, calls, pending: Vec::new(), opens, ready: false })
    }

    /// Files the host asked to open, to feed through the app's drop path.
    pub fn take_opens(&self) -> Vec<(String, Vec<u8>)> {
        std::mem::take(&mut *self.opens.borrow_mut())
    }

    /// Queue new calls on the app's control channel and post finished replies. Call every frame.
    pub fn poll<R>(&mut self, tx: &Sender<R>, make: impl Fn(String, Value) -> (R, Receiver<Value>), ctx: &egui::Context) {
        if !self.ready {
            self.ready = post(&[("type", "craft:ready".into()), ("app", self.app.into()), ("version", self.version.into())]);
        }
        let calls = std::mem::take(&mut *self.calls.borrow_mut());
        for (id, method, params) in calls {
            let (req, rx) = make(method, params);
            if tx.send(req).is_err() {
                post(&[("type", "craft:result".into()), ("id", id), ("ok", false.into()), ("error", "control channel closed".into())]);
                continue;
            }
            self.pending.push((id, rx));
        }
        let mut still = Vec::new();
        for (id, rx) in self.pending.drain(..) {
            match rx.try_recv() {
                Ok(v) => {
                    let err = v.get("error").filter(|e| !e.is_null()).map(|e| e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string()));
                    match err {
                        Some(e) => post(&[("type", "craft:result".into()), ("id", id), ("ok", false.into()), ("error", e.as_str().into()), ("result", to_js(&v))]),
                        None => post(&[("type", "craft:result".into()), ("id", id), ("ok", true.into()), ("result", to_js(&v))]),
                    };
                }
                Err(TryRecvError::Empty) => still.push((id, rx)),
                Err(TryRecvError::Disconnected) => {
                    post(&[("type", "craft:result".into()), ("id", id), ("ok", false.into()), ("error", "no reply".into())]);
                }
            }
        }
        self.pending = still;
        if !self.pending.is_empty() {
            ctx.request_repaint();
        }
    }
}
