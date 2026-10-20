use crate::protocol::{fields, integer, random_id, string, Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::PathBuf;

pub trait Native: Send {
    fn request(&mut self, request: Value) -> Result<Value>;
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Bounds {
    fn valid(self) -> bool {
        [
            self.x,
            self.y,
            self.width,
            self.height,
            self.x + self.width,
            self.y + self.height,
        ]
        .iter()
        .all(|v| v.is_finite())
            && self.width >= 50.0
            && self.height >= 50.0
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub window_id: u32,
    pub pid: i32,
    pub title: String,
    pub bounds: Bounds,
}
#[derive(Clone)]
struct Frame {
    id: String,
    path: PathBuf,
    width: u32,
    height: u32,
    bounds: Bounds,
}
struct Connection {
    id: String,
    window: Window,
    frames: VecDeque<Frame>,
}
pub struct Service<N: Native> {
    native: N,
    frames_dir: PathBuf,
    connection: Option<Connection>,
}
impl<N: Native> Service<N> {
    pub fn new(native: N, frames_dir: PathBuf) -> Self {
        Self {
            native,
            frames_dir,
            connection: None,
        }
    }
    pub fn execute(&mut self, request: Value) -> Result<Value> {
        let action = string(&request, "action")?;
        let allowed: &[&str] = match action {
            "status" | "windows" => &["action"],
            "permissions" => &["action", "request"],
            "connect" => &["action", "windowId"],
            "observe" | "disconnect" => &["action", "connectionId"],
            "click" => &["action", "connectionId", "frameId", "x", "y", "clickCount"],
            "scroll" => &["action", "connectionId", "frameId", "x", "y", "deltaY"],
            "type" => &["action", "connectionId", "frameId", "text"],
            "press" => &["action", "connectionId", "frameId", "key"],
            _ => return Err(Error::invalid("不支持的命令")),
        };
        fields(&request, allowed)?;
        let result = match action {
            "status" => Ok(
                json!({"running":true,"connected":self.connection.is_some(),"window":self.connection.as_ref().map(|c| &c.window)}),
            ),
            "windows" => self.native.request(json!({"action":"windows"})),
            "permissions" => {
                if request.get("request").is_some_and(|v| !v.is_boolean()) {
                    return Err(Error::invalid("request 必须为布尔值"));
                }
                self.native.request(json!({"action":"permissions","request":request["request"].as_bool().unwrap_or(false)}))
            }
            "connect" => self.connect(&request),
            _ => {
                self.require_connection(string(&request, "connectionId")?)?;
                match action {
                    "disconnect" => {
                        self.clear();
                        Ok(json!({"connected":false}))
                    }
                    "observe" => self.observe(),
                    _ => self.input(&request),
                }
            }
        };
        let result = result.map_err(|mut error| {
            if error.code == "IMAGE_GEOMETRY_CHANGED" {
                error.code = "FRAME_GEOMETRY_CHANGED".into();
            }
            error
        });
        if result.as_ref().err().is_some_and(|e| {
            matches!(
                e.code.as_str(),
                "WINDOW_UNAVAILABLE"
                    | "CHROME_WINDOW_UNAVAILABLE"
                    | "HELPER_EOF"
                    | "HELPER_TIMEOUT"
                    | "HELPER_PROTOCOL"
            )
        }) {
            self.clear();
        }
        result
    }
    fn require_connection(&self, id: &str) -> Result<&Connection> {
        self.connection
            .as_ref()
            .filter(|c| c.id == id)
            .ok_or_else(|| {
                Error::new(
                    "CONNECTION_INVALID",
                    "控制连接不存在或凭据不匹配，请显式 connect",
                )
            })
    }
    fn connect(&mut self, request: &Value) -> Result<Value> {
        let id = u32::try_from(integer(request, "windowId")?)
            .ok()
            .filter(|v| *v > 0)
            .ok_or_else(|| Error::invalid("windowId 必须为正整数"))?;
        if self.connection.is_some() {
            return Err(Error::new(
                "CONNECTION_BUSY",
                "已有控制连接；请先用原连接凭据 disconnect，或显式停止后台进程",
            ));
        }
        let permissions = self
            .native
            .request(json!({"action":"permissions","request":false}))?;
        if permissions["screenRecording"] != true {
            return Err(Error::new(
                "SCREEN_PERMISSION_REQUIRED",
                "请为原生 helper 授予屏幕录制权限；可运行 permissions --request",
            ));
        }
        let windows = self.native.request(json!({"action":"windows"}))?;
        let selected = windows["windows"]
            .as_array()
            .and_then(|items| items.iter().find(|v| v["windowId"] == id))
            .cloned()
            .ok_or_else(|| {
                Error::new(
                    "WINDOW_UNAVAILABLE",
                    "找不到指定 Chrome 窗口，请重新执行 windows",
                )
            })?;
        let window: Window = decode(selected)?;
        if !window.bounds.valid() || window.pid <= 0 {
            return Err(Error::new("HELPER_PROTOCOL", "原生窗口几何或身份无效"));
        }
        let id = random_id()?;
        let result =
            json!({"connectionId":id,"connected":true,"window":window,"permissions":permissions});
        self.connection = Some(Connection {
            id,
            window,
            frames: VecDeque::new(),
        });
        Ok(result)
    }
    fn current_window(&mut self) -> Result<Window> {
        let target = &self.connection.as_ref().expect("已校验连接").window;
        let response = self
            .native
            .request(json!({"action":"window","windowId":target.window_id,"pid":target.pid}))?;
        let window: Window = decode(response["window"].clone())?;
        if window.window_id != target.window_id
            || window.pid != target.pid
            || !window.bounds.valid()
        {
            return Err(Error::new(
                "WINDOW_UNAVAILABLE",
                "目标 Chrome 窗口身份或几何发生异常",
            ));
        }
        Ok(window)
    }
    fn observe(&mut self) -> Result<Value> {
        let window = self.current_window()?;
        let id = random_id()?;
        let path = self.frames_dir.join(format!("{id}.jpg"));
        let result = self.capture(&window, &id, &path);
        if result.is_err() {
            let _ = std::fs::remove_file(&path);
        }
        result
    }
    fn capture(&mut self, window: &Window, id: &str, path: &std::path::Path) -> Result<Value> {
        let image = self.native.request(json!({"action":"observe","windowId":window.window_id,"pid":window.pid,"imagePath":path,"maxEdge":1600}))?;
        let width = dimension(&image, "width")?;
        let height = dimension(&image, "height")?;
        let bounds: Bounds = decode(image["bounds"].clone())?;
        if !bounds.valid() || bounds != window.bounds {
            return Err(Error::new(
                "FRAME_GEOMETRY_CHANGED",
                "截图期间窗口几何变化，请重新观察",
            ));
        }
        if image["imagePath"].as_str() != path.to_str() || image["capturedAtMs"].as_u64().is_none()
        {
            return Err(Error::new("HELPER_PROTOCOL", "截图元数据无效"));
        }
        let metadata =
            std::fs::symlink_metadata(path).map_err(|e| Error::io("无法读取原生截图文件", e))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() >= 1024 * 1024 {
            return Err(Error::new("HELPER_PROTOCOL", "原生截图文件类型或大小无效"));
        }
        let connection = self.connection.as_mut().expect("已校验连接");
        connection.window = window.clone();
        connection.frames.push_back(Frame {
            id: id.into(),
            path: path.into(),
            width,
            height,
            bounds,
        });
        if connection.frames.len() > 32 {
            if let Some(oldest) = connection.frames.pop_front() {
                let _ = std::fs::remove_file(oldest.path);
            }
        }
        let mut result = json!({"connectionId":connection.id,"frameId":id,"imagePath":path,"width":width,"height":height,"bounds":bounds,"capturedAtMs":image["capturedAtMs"],"untrusted":true});
        if let Some(backend @ ("screen-capture-kit" | "screencapture")) =
            image["captureBackend"].as_str()
        {
            result["captureBackend"] = json!(backend);
        }
        Ok(result)
    }
    fn input(&mut self, request: &Value) -> Result<Value> {
        let frame_id = string(request, "frameId")?;
        let frame = self
            .connection
            .as_ref()
            .expect("已校验连接")
            .frames
            .iter()
            .find(|f| f.id == frame_id)
            .cloned()
            .ok_or_else(|| {
                Error::new(
                    "FRAME_UNKNOWN",
                    "找不到本连接的帧，或已超出最近 32 帧保留范围；请重新 observe",
                )
            })?;
        let action = string(request, "action")?;
        let mut native = json!({"action":action,"expectedBounds":frame.bounds});
        match action {
            "click" | "scroll" => {
                let x = integer(request, "x")?;
                let y = integer(request, "y")?;
                if x < 0 || y < 0 || x >= frame.width as i64 || y >= frame.height as i64 {
                    return Err(Error::invalid("坐标超出截图范围"));
                }
                native["screenX"] =
                    json!(frame.bounds.x + x as f64 / frame.width as f64 * frame.bounds.width);
                native["screenY"] =
                    json!(frame.bounds.y + y as f64 / frame.height as f64 * frame.bounds.height);
                if action == "click" {
                    let count = if request.get("clickCount").is_some() {
                        integer(request, "clickCount")?
                    } else {
                        1
                    };
                    if ![1, 2].contains(&count) {
                        return Err(Error::invalid("clickCount 只能为 1 或 2"));
                    }
                    native["clickCount"] = json!(count);
                } else {
                    let delta = integer(request, "deltaY")?;
                    if delta == 0 || !(-1200..=1200).contains(&delta) {
                        return Err(Error::invalid("deltaY 必须为 [-1200,1200] 内的非零整数"));
                    }
                    native["deltaY"] = json!(delta);
                }
            }
            "type" => {
                let text = string(request, "text")?;
                if text.chars().count() > 4096 || text.chars().any(char::is_control) {
                    return Err(Error::invalid(
                        "文本必须为 1–4096 个 Unicode 字符且不能包含控制字符",
                    ));
                }
                native["text"] = json!(text);
            }
            "press" => {
                let key = string(request, "key")?;
                if !KEYS.contains(&key) {
                    return Err(Error::invalid("按键不在允许的 21 个按键或组合键中"));
                }
                native["key"] = json!(key);
            }
            _ => return Err(Error::invalid("不支持的输入动作")),
        }
        // 帧不消费且没有时间硬过期；只检查连接、保留范围与几何。
        let window = self.current_window()?;
        if window.bounds != frame.bounds {
            return Err(Error::new(
                "FRAME_GEOMETRY_CHANGED",
                "窗口已移动或缩放，请重新 observe 后再输入",
            ));
        }
        native["windowId"] = json!(window.window_id);
        native["pid"] = json!(window.pid);
        let receipt = self.native.request(native)?;
        if receipt["sent"] != true {
            return Err(Error::new("HELPER_PROTOCOL", "原生输入未返回投递回执"));
        }
        Ok(
            json!({"sent":true,"connectionId":self.connection.as_ref().unwrap().id,"frameId":frame_id}),
        )
    }
    fn clear(&mut self) {
        if let Some(connection) = self.connection.take() {
            for frame in connection.frames {
                let _ = std::fs::remove_file(frame.path);
            }
        }
    }
}
impl<N: Native> Drop for Service<N> {
    fn drop(&mut self) {
        self.clear();
    }
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| Error::new("HELPER_PROTOCOL", "原生响应字段无效"))
}
fn dimension(image: &Value, key: &str) -> Result<u32> {
    image[key]
        .as_u64()
        .filter(|v| *v > 0 && *v <= 1600)
        .map(|v| v as u32)
        .ok_or_else(|| Error::new("HELPER_PROTOCOL", "原生截图尺寸无效"))
}
pub const KEYS: &[&str] = &[
    "Enter",
    "Tab",
    "Shift+Tab",
    "Escape",
    "Backspace",
    "Delete",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Cmd+L",
    "Cmd+A",
    "Cmd+R",
    "Cmd+T",
    "Cmd+W",
    "Alt+ArrowLeft",
    "Alt+ArrowRight",
];
