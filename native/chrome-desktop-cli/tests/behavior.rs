use copis_chrome::protocol::{Error, Result};
use copis_chrome::service::{Native, Service};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Desktop {
    calls: Arc<Mutex<Vec<Value>>>,
    moved: Arc<Mutex<bool>>,
    missing: Arc<Mutex<bool>>,
}
impl Native for Desktop {
    fn request(&mut self, request: Value) -> Result<Value> {
        self.calls.lock().unwrap().push(request.clone());
        let bounds = if *self.moved.lock().unwrap() {
            json!({"x":-200.0,"y":20.0,"width":800.0,"height":600.0})
        } else {
            json!({"x":-300.0,"y":20.0,"width":800.0,"height":600.0})
        };
        let window = json!({"windowId":42,"pid":123,"title":"Example","bounds":bounds});
        match request["action"].as_str().unwrap() {
            "permissions" => Ok(json!({"screenRecording":true,"accessibility":true})),
            "windows" => Ok(json!({"windows":[window]})),
            "window" if *self.missing.lock().unwrap() => {
                Err(Error::new("WINDOW_UNAVAILABLE", "目标窗口已关闭"))
            }
            "window" => Ok(json!({"window":window})),
            "cancel" => Ok(json!({"cancelled":true})),
            "observe" => {
                std::fs::write(
                    request["imagePath"].as_str().unwrap(),
                    [0xff, 0xd8, 0xff, 0xd9],
                )
                .unwrap();
                Ok(
                    json!({"imagePath":request["imagePath"],"width":1600,"height":1200,"bounds":bounds,"capturedAtMs":1}),
                )
            }
            _ => Ok(json!({"sent":true})),
        }
    }
}
fn setup() -> (Service<Desktop>, Desktop, std::path::PathBuf) {
    let desktop = Desktop::default();
    let path = std::env::temp_dir().join(format!(
        "chrome-behavior-{}-{}",
        std::process::id(),
        copis_chrome::protocol::random_id().unwrap()
    ));
    std::fs::create_dir(&path).unwrap();
    (Service::new(desktop.clone(), path.clone()), desktop, path)
}
fn connect(service: &mut Service<Desktop>) -> String {
    service
        .execute(json!({"action":"connect","windowId":42}))
        .unwrap()["connectionId"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn observe(service: &mut Service<Desktop>, connection: &str) -> String {
    service
        .execute(json!({"action":"observe","connectionId":connection}))
        .unwrap()["frameId"]
        .as_str()
        .unwrap()
        .to_owned()
}
#[test]
fn given_one_observation_when_reused_multiple_times_then_all_inputs_are_sent_without_age_limit() {
    let (mut service, desktop, path) = setup();
    let connection = connect(&mut service);
    let frame = observe(&mut service, &connection);
    for _ in 0..3 {
        service.execute(json!({"action":"click","connectionId":connection,"frameId":frame,"x":400,"y":300,"clickCount":1})).unwrap();
    }
    let calls = desktop.calls.lock().unwrap();
    let clicks: Vec<_> = calls.iter().filter(|v| v["action"] == "click").collect();
    assert_eq!(clicks.len(), 3);
    assert_eq!(clicks[0]["screenX"], -100.0);
    assert_eq!(clicks[0]["screenY"], 170.0);
    drop(calls);
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn given_two_frames_when_older_frame_is_reused_then_it_is_not_rejected_as_not_latest() {
    let (mut service, _, path) = setup();
    let connection = connect(&mut service);
    let frame = observe(&mut service, &connection);
    observe(&mut service, &connection);
    service
        .execute(json!({"action":"press","connectionId":connection,"frameId":frame,"key":"Enter"}))
        .unwrap();
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn given_window_moved_when_input_requested_then_no_native_input_is_sent() {
    let (mut service, desktop, path) = setup();
    let connection = connect(&mut service);
    let frame = observe(&mut service, &connection);
    *desktop.moved.lock().unwrap() = true;
    let error = service
        .execute(json!({"action":"click","connectionId":connection,"frameId":frame,"x":1,"y":1}))
        .unwrap_err();
    assert_eq!(error.code, "FRAME_GEOMETRY_CHANGED");
    assert!(!desktop
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|v| v["action"] == "click"));
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn given_connection_exists_when_another_agent_connects_then_connection_is_not_stolen_or_disclosed()
{
    let (mut service, _, path) = setup();
    let connection = connect(&mut service);
    assert_eq!(
        service
            .execute(json!({"action":"connect","windowId":42}))
            .unwrap_err()
            .code,
        "CONNECTION_BUSY"
    );
    let status = service.execute(json!({"action":"status"})).unwrap();
    assert!(!status.to_string().contains(&connection));
    assert_eq!(status["connected"], true);
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn given_invalid_credentials_or_parameters_then_input_is_never_sent() {
    let (mut service, desktop, path) = setup();
    let connection = connect(&mut service);
    let frame = observe(&mut service, &connection);
    for request in [
        json!({"action":"click","connectionId":"wrong","frameId":frame,"x":1,"y":1}),
        json!({"action":"click","connectionId":connection,"frameId":frame,"x":1600,"y":1}),
        json!({"action":"type","connectionId":connection,"frameId":frame,"text":"bad\ntext"}),
        json!({"action":"press","connectionId":connection,"frameId":frame,"key":"Cmd+Q"}),
        json!({"action":"scroll","connectionId":connection,"frameId":frame,"x":1,"y":1,"deltaY":0}),
    ] {
        assert!(service.execute(request).is_err());
    }
    assert!(!desktop
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|v| ["click", "type", "scroll", "press"].contains(&v["action"].as_str().unwrap())));
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn given_disconnect_when_old_credentials_are_used_then_connection_and_images_are_gone() {
    let (mut service, _, path) = setup();
    let connection = connect(&mut service);
    observe(&mut service, &connection);
    service
        .execute(json!({"action":"disconnect","connectionId":connection}))
        .unwrap();
    assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
    assert_eq!(
        service
            .execute(json!({"action":"observe","connectionId":connection}))
            .unwrap_err()
            .code,
        "CONNECTION_INVALID"
    );
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn given_33_frames_when_oldest_is_used_then_bounded_retention_is_explicit() {
    let (mut service, _, path) = setup();
    let connection = connect(&mut service);
    let oldest = observe(&mut service, &connection);
    for _ in 0..32 {
        observe(&mut service, &connection);
    }
    assert_eq!(std::fs::read_dir(&path).unwrap().count(), 32);
    assert_eq!(
        service
            .execute(
                json!({"action":"press","connectionId":connection,"frameId":oldest,"key":"Enter"})
            )
            .unwrap_err()
            .code,
        "FRAME_UNKNOWN"
    );
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn given_target_closed_when_observing_then_control_is_released() {
    let (mut service, desktop, path) = setup();
    let connection = connect(&mut service);
    *desktop.missing.lock().unwrap() = true;
    assert_eq!(
        service
            .execute(json!({"action":"observe","connectionId":connection}))
            .unwrap_err()
            .code,
        "WINDOW_UNAVAILABLE"
    );
    assert_eq!(
        service.execute(json!({"action":"status"})).unwrap()["connected"],
        false
    );
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn given_native_geometry_race_when_input_rejected_then_public_error_is_normalized_and_connection_kept(
) {
    struct GeometryRace(Desktop);
    impl Native for GeometryRace {
        fn request(&mut self, request: Value) -> Result<Value> {
            if request["action"] == "press" {
                Err(Error::new("IMAGE_GEOMETRY_CHANGED", "原生二次校验几何变化"))
            } else {
                self.0.request(request)
            }
        }
    }
    let (service, desktop, path) = setup();
    drop(service);
    let mut service = Service::new(GeometryRace(desktop), path.clone());
    let connection = service
        .execute(json!({"action":"connect","windowId":42}))
        .unwrap()["connectionId"]
        .clone();
    let frame = service
        .execute(json!({"action":"observe","connectionId":connection}))
        .unwrap()["frameId"]
        .clone();
    let error = service
        .execute(json!({"action":"press","connectionId":connection,"frameId":frame,"key":"Enter"}))
        .unwrap_err();
    assert_eq!(error.code, "FRAME_GEOMETRY_CHANGED");
    assert_eq!(
        service.execute(json!({"action":"status"})).unwrap()["connected"],
        true
    );
    assert!(service
        .execute(json!({"action":"observe","connectionId":connection}))
        .is_ok());
    drop(service);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn given_finite_but_overflowing_bounds_when_connecting_then_invalid_coordinate_mapping_is_rejected()
{
    struct InvalidBounds(Desktop);
    impl Native for InvalidBounds {
        fn request(&mut self, request: Value) -> Result<Value> {
            let mut response = self.0.request(request.clone())?;
            if request["action"] == "windows" {
                response["windows"][0]["bounds"] =
                    json!({"x":f64::MAX,"y":0,"width":f64::MAX,"height":600});
            }
            Ok(response)
        }
    }
    let (service, desktop, path) = setup();
    drop(service);
    let mut service = Service::new(InvalidBounds(desktop), path.clone());
    assert_eq!(
        service
            .execute(json!({"action":"connect","windowId":42}))
            .unwrap_err()
            .code,
        "HELPER_PROTOCOL"
    );
    drop(service);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn given_native_capture_backend_when_observing_then_only_known_backend_labels_are_exposed() {
    struct BackendInfo(Desktop, Value);
    impl Native for BackendInfo {
        fn request(&mut self, request: Value) -> Result<Value> {
            let mut result = self.0.request(request.clone())?;
            if request["action"] == "observe" {
                result["captureBackend"] = self.1.clone();
            }
            Ok(result)
        }
    }
    for backend in [
        json!("screencapture"),
        json!("screen-capture-kit"),
        json!("private-token arbitrary backend text"),
        json!({"secret": "private-token"}),
    ] {
        let (original, desktop, path) = setup();
        drop(original);
        let mut service = Service::new(BackendInfo(desktop, backend.clone()), path.clone());
        let connection = service
            .execute(json!({"action":"connect","windowId":42}))
            .unwrap()["connectionId"]
            .clone();
        let frame = service
            .execute(json!({"action":"observe","connectionId":connection}))
            .unwrap();
        if backend == "screencapture" || backend == "screen-capture-kit" {
            assert_eq!(frame["captureBackend"], backend);
        } else {
            assert!(frame.get("captureBackend").is_none());
            assert!(!frame.to_string().contains("private-token"));
        }
        drop(service);
        std::fs::remove_dir_all(path).unwrap();
    }
}
