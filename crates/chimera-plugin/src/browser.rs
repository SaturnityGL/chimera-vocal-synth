//! The editor on Linux: the page in the user's web browser, served from 127.0.0.1 while the host's
//! window for the plugin is open. A webview inside that window would need GTK running on its thread
//! (docs/plugin.md, "Linux"); a browser needs nothing, and works on Wayland too. The host's window
//! stays small and empty.

use std::hash::{BuildHasher, RandomState};
use std::process::Command;
use std::sync::Arc;
use std::thread::JoinHandle;

use nih_plug::prelude::*;

use crate::ChimeraParams;
use crate::bridge::{Bridge, GuiHost};
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

/// Whether a request may reach the plugin. The page is opened with a token in its address, and sends
/// it back as a cookie, named for this port because cookies don't tell ports apart. And only to this
/// address by name: a page elsewhere that resolves its own name to 127.0.0.1 still says its own name.
pub fn allowed(url: &str, cookie: Option<&str>, host: Option<&str>, token: &str, port: u16) -> bool {
    if host != Some(format!("127.0.0.1:{port}").as_str()) {
        return false;
    }
    let in_url = url.split_once('?').is_some_and(|(_, query)| query.split('&').any(|kv| kv == format!("k={token}")));
    let in_cookie = cookie.is_some_and(|c| c.split(';').any(|kv| kv.trim() == format!("chimera{port}={token}")));
    in_url || in_cookie
}

/// The open editor: closing the host's window stops the server, and the page then says so.
struct Open {
    bridge: Arc<Bridge>,
    server: Arc<tiny_http::Server>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Open {
    fn drop(&mut self) {
        self.server.unblock();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.bridge.close();
    }
}

impl Editor for BrowserEditor {
    fn spawn(&self, _parent: ParentWindowHandle, context: Arc<dyn GuiContext>) -> Box<dyn std::any::Any + Send> {
        let bridge = Arc::new(Bridge::new(self.params.clone(), self.shared.clone(), Box::new(GuiHost::new(self.params.clone(), context))));
        let server = match tiny_http::Server::http("127.0.0.1:0") {
            Ok(server) => Arc::new(server),
            Err(err) => {
                nih_error!("CHIMERA: could not serve the editor: {err}");
                return Box::new(());
            }
        };
        let Some(port) = server.server_addr().to_ip().map(|a| a.port()) else { return Box::new(()) };
        let token = format!("{:016x}{:016x}", RandomState::new().hash_one(0u8), RandomState::new().hash_one(1u8));
        let url = format!("http://127.0.0.1:{port}/?k={token}");

        // the bridge's commands then come from this thread, as with nih-plug's own editors on Linux
        let thread = {
            let (server, bridge) = (server.clone(), bridge.clone());
            std::thread::spawn(move || {
                let shim = format!("{IPC_SHIM}{IN_BROWSER}");
                let cookie = format!("chimera{port}={token}; Path=/; HttpOnly; SameSite=Strict");
                for req in server.incoming_requests() {
                    let get = |name: &'static str| req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_owned());
                    if !allowed(req.url(), get("Cookie").as_deref(), get("Host").as_deref(), &token, port) {
                        let _ = req.respond(tiny_http::Response::empty(403));
                        continue;
                    }
                    answer(&bridge, req, &shim, Some(header("Set-Cookie", &cookie)));
                }
            })
        };

        nih_log!("CHIMERA's editor is at {url}");
        match Command::new("xdg-open").arg(&url).spawn() {
            // xdg-open returns once the browser has it: wait for it, so it doesn't linger as a zombie
            Ok(mut child) => drop(std::thread::spawn(move || child.wait())),
            Err(err) => nih_error!("CHIMERA: could not open a browser ({err}): open {url}"),
        }
        Box::new(Open { bridge, server, thread: Some(thread) })
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

    #[test]
    fn the_token_in_the_address_or_this_ports_cookie_lets_a_request_in() {
        assert!(allowed("/?k=abc123", None, Some("127.0.0.1:4000"), T, 4000));
        assert!(allowed("/poll", Some("x=1; chimera4000=abc123"), Some("127.0.0.1:4000"), T, 4000));
    }

    #[test]
    fn anything_else_is_refused() {
        // no token, or the wrong one
        assert!(!allowed("/poll", None, Some("127.0.0.1:4000"), T, 4000));
        assert!(!allowed("/?k=abc12", None, Some("127.0.0.1:4000"), T, 4000));
        // another instance's cookie, on another port
        assert!(!allowed("/poll", Some("chimera4001=abc123"), Some("127.0.0.1:4000"), T, 4000));
        // a page elsewhere whose name resolves to 127.0.0.1
        assert!(!allowed("/?k=abc123", None, Some("evil.example:4000"), T, 4000));
        assert!(!allowed("/?k=abc123", None, None, T, 4000));
    }
}
