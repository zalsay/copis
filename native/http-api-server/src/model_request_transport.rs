use std::io::{self, Read};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use ureq::unversioned::transport::{Buffers, ConnectionDetails, Connector, NextTimeout, Transport};

#[derive(Clone, Debug, Default)]
pub struct DisconnectPeer(Arc<Mutex<Option<TcpStream>>>);

impl DisconnectPeer {
    fn attach(&self, stream: &TcpStream) -> io::Result<()> {
        let peer = stream.try_clone()?;
        peer.set_read_timeout(Some(Duration::from_millis(1)))?;
        *self.0.lock().unwrap() = Some(peer);
        Ok(())
    }

    fn disconnected(&self) -> bool {
        let guard = self.0.lock().unwrap();
        let Some(peer) = guard.as_ref() else {
            return false;
        };
        match peer.peek(&mut [0]) {
            Ok(0) => true,
            Ok(_) => false,
            Err(error) => !matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
            ),
        }
    }
}

pub struct ModelBody {
    reader: Box<dyn Read + Send>,
    peer: DisconnectPeer,
}

impl ModelBody {
    pub fn new(reader: Box<dyn Read + Send>, peer: DisconnectPeer) -> Self {
        Self { reader, peer }
    }

    pub fn watch_client(&self, stream: &TcpStream) -> io::Result<()> {
        self.peer.attach(stream)
    }
}

impl Read for ModelBody {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.reader.read(buffer)
    }
}

#[derive(Debug)]
pub struct DisconnectConnector(pub DisconnectPeer);

impl<T: Transport> Connector<T> for DisconnectConnector {
    type Out = DisconnectTransport<T>;

    fn connect(
        &self,
        _: &ConnectionDetails,
        chained: Option<T>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        Ok(chained.map(|inner| DisconnectTransport {
            inner,
            peer: self.0.clone(),
        }))
    }
}

#[derive(Debug)]
pub struct DisconnectTransport<T> {
    inner: T,
    peer: DisconnectPeer,
}

impl<T: Transport> Transport for DisconnectTransport<T> {
    fn buffers(&mut self) -> &mut dyn Buffers {
        self.inner.buffers()
    }
    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.inner.transmit_output(amount, timeout)
    }
    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        let started = Instant::now();
        loop {
            if self.peer.disconnected() {
                return Err(
                    io::Error::new(io::ErrorKind::ConnectionAborted, "模型客户端已断开").into(),
                );
            }
            let remaining = timeout.after.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err(ureq::Error::Timeout(timeout.reason));
            }
            // 在 ureq 解析器下方轮询，不把短周期超时当作 SSE 或 TLS EOF。
            let poll = NextTimeout {
                after: remaining.min(Duration::from_millis(100)).into(),
                reason: timeout.reason,
            };
            match self.inner.await_input(poll) {
                Err(ureq::Error::Timeout(_)) => continue,
                Err(ureq::Error::Io(error))
                    if matches!(
                        error.kind(),
                        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                    ) =>
                {
                    continue
                }
                result => return result,
            }
        }
    }
    fn is_open(&mut self) -> bool {
        !self.peer.disconnected() && self.inner.is_open()
    }
    fn is_tls(&self) -> bool {
        self.inner.is_tls()
    }
}
