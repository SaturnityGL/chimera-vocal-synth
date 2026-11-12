//! The editor on Linux: the page in the user's web browser, served from 127.0.0.1 while the host's
//! window for the plugin is open. A webview inside that window would need GTK running on its thread
//! (docs/plugin.md, "Linux"); a browser needs nothing, and works on Wayland too. The host's window
//! stays small and empty.

use std::fs::File;
use std::io::Read;
use std::process::Command;
use std::sync::{Arc, Mutex};

use nih_plug::prelude::*;

use crate::ChimeraParams;
use crate::bridge::{Bridge, GripAction, GuiHost, ParamHost};
use crate::core::Shared;
use crate::http::{IPC_SHIM, answer, header};

/// The host's window, which only has to be there to be closed (logical pixels).
const WINDOW: (u32, u32) = (360, 60);
/// Tells the page it's in a browser: the browser's window is the one to resize, so no grip.
const IN_BROWSER: &str = "<script>document.documentElement.classList.add('in-browser')</script>";

pub struct BrowserEditor {
    params: Arc<ChimeraParams>,
    shared: Arc<Shared>,
}

impl BrowserEditor {
    pub fn new(params: Arc<ChimeraParams>, shared: Arc<Shared>) -> Self {
        Self { params, shared }
    }
}

/// Whether a request may reach the plugin. The page's own files may: they're the open-source site.
/// Anything about the plugin needs the token the page was opened with, which it keeps and sends as a
/// header (a cookie would go to every service on 127.0.0.1, whatever its port). And it has to name this
/// address: a page elsewhere that points a name of its own at 127.0.0.1 still says its own name.
pub fn allowed(path: &str, sent: Option<&str>, host: Option<&str>, token: &str, port: u16) -> bool {
    host == Some(format!("127.0.0.1:{port}").as_str()) && (Bridge::is_asset(path) || sent == Some(token))
}

/// 128 bits from the system.
fn new_token() -> Option<String> {
    let mut bytes = [0u8; 16];
    File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The host, until the window closes. The server's thread isn't waited for (a request half sent could
/// keep it, and the host's GUI thread with it), so nothing it does afterwards may reach the host.
struct Gate(Mutex<Option<GuiHost>>);

impl Gate {
    fn with(&self, f: impl FnOnce(&GuiHost)) {
        if let Some(host) = self.0.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            f(host);
        }
    }
}

struct Gated(Arc<Gate>);

impl ParamHost for Gated {
    fn begin(&self, id: &str) {
        self.0.with(|h| h.begin(id));
    }
    fn set(&self, id: &str, plain: f32) {
        self.0.with(|h| h.set(id, plain));
    }
    fn end(&self, id: &str) {
        self.0.with(|h| h.end(id));
    }
    fn values(&self) -> Vec<(String, f32)> {
        let mut values = Vec::new();
        self.0.with(|h| values = h.values());
        values
    }
    fn grip(&self, _action: GripAction) {}
}

/// The open editor: closing the host's window stops the server, and the page then says so.
struct Open {
    bridge: Arc<Bridge>,
    gate: Arc<Gate>,
    server: Arc<tiny_http::Server>,
}

impl Drop for Open {
    fn drop(&mut self) {
        // gestures still open end while the host can hear it, and then nothing more reaches it
        self.bridge.close();
        *self.gate.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.server.unblock();
    }
}

impl Editor for BrowserEditor {
    fn spawn(&self, _parent: ParentWindowHandle, context: Arc<dyn GuiContext>) -> Box<dyn std::any::Any + Send> {
        let gate = Arc::new(Gate(Mutex::new(Some(GuiHost::new(self.params.clone(), context)))));
        let bridge = Arc::new(Bridge::new(self.params.clone(), self.shared.clone(), Box::new(Gated(gate.clone()))));
        let server = match tiny_http::Server::http("127.0.0.1:0") {
            Ok(server) => Arc::new(server),
            Err(err) => {
                nih_error!("CHIMERA: could not serve the editor: {err}");
                return Box::new(());
            }
        };
        let (Some(port), Some(token)) = (server.server_addr().to_ip().map(|a| a.port()), new_token()) else { return Box::new(()) };
        let url = format!("http://127.0.0.1:{port}/?k={token}");

        // the bridge's calls into the host then come from this thread, as with nih-plug's own editors on Linux
        {
            let (server, bridge) = (server.clone(), bridge.clone());
            std::thread::spawn(move || {
                let shim = format!("{IPC_SHIM}{IN_BROWSER}");
                for req in server.incoming_requests() {
                    let get = |name: &'static str| req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_owned());
                    let path = req.url().split('?').next().unwrap_or("/").to_owned();
                    if !allowed(&path, get("X-Chimera-Token").as_deref(), get("Host").as_deref(), &token, port) {
                        let _ = req.respond(tiny_http::Response::empty(403));
                        continue;
                    }
                    // the page's address holds the token: no other site gets it as a referrer
                    answer(&bridge, req, &shim, Some(header("Referrer-Policy", "no-referrer")));
                }
            });
        }

        match Command::new("xdg-open").arg(&url).spawn() {
            // xdg-open returns once the browser has it: wait for it, so it doesn't linger as a zombie
            Ok(mut child) => drop(std::thread::spawn(move || child.wait())),
            Err(err) => nih_error!("CHIMERA: could not open a browser ({err}): open {url}"),
        }
        Box::new(Open { bridge, gate, server })
    }

    fn size(&self) -> (u32, u32) {
        WINDOW
    }

    fn set_scale_factor(&self, _factor: f32) -> bool {
        false
    }

    // the page polls the parameters, so host-side changes need no push
    fn param_value_changed(&self, _id: &str, _normalized_value: f32) {}
    fn param_modulation_changed(&self, _id: &str, _modulation_offset: f32) {}
    fn param_values_changed(&self) {}
}

#[cfg(test)]
mod tests {
    use super::allowed;

    const T: &str = "abc123";
    const HOST: Option<&str> = Some("127.0.0.1:4000");

    #[test]
    fn the_token_lets_a_request_about_the_plugin_in() {
        assert!(allowed("/poll", Some(T), HOST, T, 4000));
        assert!(allowed("/ipc", Some(T), HOST, T, 4000));
    }

    #[test]
    fn the_page_itself_needs_no_token() {
        assert!(allowed("/", None, HOST, T, 4000));
    }

    #[test]
    fn anything_else_is_refused() {
        // no token, or the wrong one
        assert!(!allowed("/poll", None, HOST, T, 4000));
        assert!(!allowed("/state", Some("abc12"), HOST, T, 4000));
        // a page elsewhere whose name resolves to 127.0.0.1, even with the token
        assert!(!allowed("/poll", Some(T), Some("evil.example:4000"), T, 4000));
        assert!(!allowed("/", None, Some("evil.example:4000"), T, 4000));
        assert!(!allowed("/poll", Some(T), None, T, 4000));
    }
}
