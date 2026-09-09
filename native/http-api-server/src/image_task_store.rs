use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct ImageTaskStore(Mutex<Connection>);

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn expiry(data: &Value) -> u64 {
    let Some(url) = data["image_url"]
        .as_str()
        .and_then(|v| v.parse::<ureq::http::Uri>().ok())
    else {
        return 0;
    };
    if url.scheme_str() != Some("https") {
        return 0;
    }
    super::query_value(url.query().unwrap_or(""), "q-sign-time")
        .and_then(|value| value.split(';').nth(1).and_then(|v| v.parse().ok()))
        .unwrap_or(0)
}

impl ImageTaskStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref();
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS image_tasks (
            user_id INTEGER NOT NULL, task_id TEXT NOT NULL, request_id TEXT NOT NULL,
            session_id TEXT NOT NULL, status TEXT NOT NULL, image_url TEXT NOT NULL,
            url_expires_at INTEGER NOT NULL, response_json TEXT NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(user_id, task_id));
            CREATE INDEX IF NOT EXISTS image_tasks_session ON image_tasks(user_id, session_id, updated_at);")
            .map_err(|e| e.to_string())?;
        Ok(Self(Mutex::new(db)))
    }

    pub fn save(
        &self,
        user: u64,
        data: &Value,
        request: &str,
        session: &str,
    ) -> Result<(), String> {
        let id = data["task_id"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or("图片任务 ID 缺失")?;
        self.0.lock().unwrap().execute("INSERT INTO image_tasks
            (user_id,task_id,request_id,session_id,status,image_url,url_expires_at,response_json,created_at,updated_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
            ON CONFLICT(user_id,task_id) DO UPDATE SET
            request_id=CASE WHEN excluded.request_id='' THEN image_tasks.request_id ELSE excluded.request_id END,
            session_id=CASE WHEN excluded.session_id='' THEN image_tasks.session_id ELSE excluded.session_id END,
            status=excluded.status,image_url=excluded.image_url,url_expires_at=excluded.url_expires_at,
            response_json=excluded.response_json,updated_at=excluded.updated_at",
            params![i64::try_from(user).map_err(|e| e.to_string())?,id,request,session,data["status"].as_str().unwrap_or(""),data["image_url"].as_str().unwrap_or(""),expiry(data).min(i64::MAX as u64) as i64,data.to_string(),now() as i64])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn cached(&self, user: u64, id: &str, time: u64) -> Result<Option<Value>, String> {
        let raw: Option<String> = self.0.lock().unwrap().query_row(
            "SELECT response_json FROM image_tasks WHERE user_id=?1 AND task_id=?2 AND status='completed' AND url_expires_at>?3",
            params![i64::try_from(user).map_err(|e| e.to_string())?,id,time.saturating_add(60).min(i64::MAX as u64) as i64], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
        raw.map(|v| serde_json::from_str(&v).map_err(|e| e.to_string()))
            .transpose()
    }

    pub fn list(&self, user: u64, session: Option<&str>) -> Result<Vec<Value>, String> {
        let db = self.0.lock().unwrap();
        let mut stmt = db.prepare("SELECT task_id,request_id,session_id,status,created_at,updated_at FROM image_tasks
            WHERE user_id=?1 AND (?2 IS NULL OR session_id=?2) ORDER BY updated_at DESC,task_id LIMIT 100").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![i64::try_from(user).map_err(|e| e.to_string())?,session], |r| Ok(serde_json::json!({
            "task_id":r.get::<_,String>(0)?,"request_id":r.get::<_,String>(1)?,"session_id":r.get::<_,String>(2)?,
            "status":r.get::<_,String>(3)?,"created_at":r.get::<_,i64>(4)?,"updated_at":r.get::<_,i64>(5)?
        }))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
#[path = "image_task_store_test.rs"]
mod tests;
