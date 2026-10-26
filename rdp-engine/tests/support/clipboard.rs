use ironrdp::{
    cliprdr::{
        backend::{ClipboardMessage, CliprdrBackend, CliprdrBackendFactory},
        pdu::*,
    },
    core::AsAny,
};
use ironrdp_server::{CliprdrServerFactory, ServerEvent, ServerEventSender};
use std::{
    any::Any,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc::UnboundedSender;
#[derive(Clone, Default, Debug)]
pub struct ClipboardServer {
    pub sender: Arc<Mutex<Option<UnboundedSender<ServerEvent>>>>,
    pub received: Arc<Mutex<Vec<String>>>,
    pub requests: Arc<Mutex<usize>>,
}
impl ClipboardServer {
    pub fn send(&self, event: ClipboardMessage) {
        self.sender
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .send(ServerEvent::Clipboard(event))
            .unwrap();
    }
    pub fn offer(&self) {
        self.send(ClipboardMessage::SendInitiateCopy(vec![
            ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT),
        ]));
    }
}
impl AsAny for ClipboardServer {
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}
impl ServerEventSender for ClipboardServer {
    fn set_sender(&mut self, sender: UnboundedSender<ServerEvent>) {
        *self.sender.lock().unwrap() = Some(sender);
    }
}
impl CliprdrServerFactory for ClipboardServer {}
impl CliprdrBackendFactory for ClipboardServer {
    fn build_cliprdr_backend(&self) -> Box<dyn CliprdrBackend> {
        Box::new(self.clone())
    }
}
impl CliprdrBackend for ClipboardServer {
    fn temporary_directory(&self) -> &str {
        ""
    }
    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
    }
    fn on_ready(&mut self) {}
    fn on_request_format_list(&mut self) {}
    fn on_process_negotiated_capabilities(&mut self, _: ClipboardGeneralCapabilityFlags) {}
    fn on_remote_copy(&mut self, formats: &[ClipboardFormat]) {
        if formats
            .iter()
            .any(|f| f.id == ClipboardFormatId::CF_UNICODETEXT)
        {
            self.send(ClipboardMessage::SendInitiatePaste(
                ClipboardFormatId::CF_UNICODETEXT,
            ));
        }
    }
    fn on_format_data_request(&mut self, _: FormatDataRequest) {
        *self.requests.lock().unwrap() += 1;
        self.send(ClipboardMessage::SendFormatData(
            FormatDataResponse::new_unicode_string("서버🙂\r\nremote text"),
        ));
    }
    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if !response.is_error() {
            self.received
                .lock()
                .unwrap()
                .push(response.to_unicode_string().unwrap());
        }
    }
    fn on_file_contents_request(&mut self, _: FileContentsRequest) {
        panic!("file request must not be sent");
    }
    fn on_file_contents_response(&mut self, _: FileContentsResponse<'_>) {
        panic!("file response must not be sent");
    }
    fn on_lock(&mut self, _: LockDataId) {
        panic!("file lock must not be sent");
    }
    fn on_unlock(&mut self, _: LockDataId) {
        panic!("file unlock must not be sent");
    }
}
