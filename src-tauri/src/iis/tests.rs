use super::*;
use serde_json::{json, Value};

fn site() -> Value {
    json!({"id":1,"name":"한글 $(whoami)","state":null,"bindings":[{"protocol":"https","address":"*:443:example.test"}],"applications":[{"path":"/","pool":"DefaultAppPool"}],"log_enabled":true})
}
fn overview_value() -> Value {
    json!({"schema":1,"status":"available","sites":[site()],"pools":[{"name":"DefaultAppPool","state":"Started","runtime":"","pipeline":"Integrated"}],"truncated":false})
}
fn overview_valid(value: Value) -> bool {
    serde_json::from_value::<Overview>(value).is_ok_and(|v| validate_overview(&v).is_ok())
}
fn log_valid(value: Value) -> bool {
    serde_json::from_value::<SiteLog>(value).is_ok_and(|v| validate_log(&v, 1).is_ok())
}
fn events_valid(value: Value) -> bool {
    serde_json::from_value::<Events>(value).is_ok_and(|v| validate_events(&v).is_ok())
}

#[test]
fn overview_keeps_missing_empty_and_partial_results_distinct() {
    assert!(overview_valid(overview_value()));
    for status in ["not_installed", "unavailable"] {
        assert!(overview_valid(
            json!({"schema":1,"status":status,"sites":null,"pools":null,"truncated":false})
        ));
    }
    for (sites, pools) in [
        (json!([]), json!([])),
        (json!(null), json!([])),
        (json!([]), json!(null)),
    ] {
        assert!(overview_valid(
            json!({"schema":1,"status":"available","sites":sites,"pools":pools,"truncated":false})
        ));
    }
}

#[test]
fn overview_rejects_unknown_missing_duplicate_and_unbounded_data() {
    let good = overview_value();
    for field in ["sites", "pools", "schema", "status"] {
        let mut bad = good.clone();
        bad.as_object_mut().unwrap().remove(field);
        assert!(!overview_valid(bad), "missing {field}");
    }
    let mut bad = good.clone();
    bad["sites"][0].as_object_mut().unwrap().remove("state");
    assert!(!overview_valid(bad));
    let mut bad = good.clone();
    bad["sites"] = json!([site(), site()]);
    assert!(!overview_valid(bad));
    let mut bad = good.clone();
    bad["sites"] = json!(vec![site(); 201]);
    assert!(!overview_valid(bad));
    let mut bad = good.clone();
    bad["status"] = json!("unavailable");
    assert!(!overview_valid(bad));
    let mut bad = good.clone();
    bad["sites"][0]["id"] = json!(0);
    assert!(!overview_valid(bad));
    let mut bad = good.clone();
    bad["sites"][0]["password"] = json!("PRIVATE");
    assert!(!overview_valid(bad));
    let mut bad = good.clone();
    bad["sites"][0]["name"] = json!("line\nbreak");
    assert!(!overview_valid(bad));
    let mut bad = good.clone();
    bad["sites"][0]["bindings"][0]["address"] = json!("x".repeat(4097));
    assert!(!overview_valid(bad));
    let mut bad = good.clone();
    bad["pools"][0]["pipeline"] = json!("unexpected");
    assert!(!overview_valid(bad));
    let mut bad = good.clone();
    bad["pools"] = json!([good["pools"][0], {"name":"defaultapppool","state":null,"runtime":"","pipeline":"Integrated"}]);
    assert!(!overview_valid(bad));
}

#[test]
fn log_response_must_match_site_and_cannot_expose_a_path() {
    let good = json!({"schema":1,"site_id":1,"status":"available","file":"u_ex261021.log","lines":["<script>한글</script>"],"truncated":false});
    assert!(log_valid(good.clone()));
    for field in ["file", "status", "site_id"] {
        let mut bad = good.clone();
        bad.as_object_mut().unwrap().remove(field);
        assert!(!log_valid(bad));
    }
    for filename in [
        "C:\\private.log",
        "../private.log",
        "u.log:secret",
        "private.txt",
        "",
    ] {
        let mut bad = good.clone();
        bad["file"] = json!(filename);
        assert!(!log_valid(bad));
    }
    let mut bad = good.clone();
    bad["site_id"] = json!(2);
    assert!(!log_valid(bad));
    let mut bad = good.clone();
    bad["lines"] = json!(vec!["line"; 51]);
    assert!(!log_valid(bad));
    let mut bad = good.clone();
    bad["lines"] = json!(["x".repeat(65537)]);
    assert!(!log_valid(bad));
    let mut bad = good.clone();
    bad["status"] = json!("unavailable");
    assert!(!log_valid(bad));
    for status in [
        "unavailable",
        "site_missing",
        "disabled",
        "unsupported_format",
        "unsupported_path",
        "no_logs",
        "too_many_files",
    ] {
        assert!(log_valid(
            json!({"schema":1,"site_id":1,"status":status,"file":null,"lines":[],"truncated":false})
        ));
    }
}

#[test]
fn events_preserve_partial_access_and_reject_malformed_records() {
    let event = json!({"record_id":10,"id":5002,"level":2,"provider":"WAS","time":"2026-10-21T10:00:00.0000000Z","message":"한글\n<script>","message_truncated":false});
    let good = json!({"schema":1,"logs":[{"name":"Application","events":[event]},{"name":"System","events":null}]});
    assert!(events_valid(good.clone()));
    assert!(events_valid(
        json!({"schema":1,"logs":[{"name":"Application","events":[]},{"name":"System","events":[]}]})
    ));
    for (field, value) in [
        ("record_id", json!(1u64 << 53)),
        ("level", json!(4)),
        ("time", json!("yesterday")),
        ("message", json!("x".repeat(4097))),
        ("provider", json!("")),
    ] {
        let mut bad = good.clone();
        bad["logs"][0]["events"][0][field] = value;
        assert!(!events_valid(bad));
    }
    let mut bad = good.clone();
    bad["logs"][0]["events"] = json!([event, event]);
    assert!(!events_valid(bad));
    let mut bad = good.clone();
    bad["logs"][1]["name"] = json!("Security");
    assert!(!events_valid(bad));
    let mut bad = good.clone();
    bad["logs"][1]["name"] = json!("Application");
    assert!(!events_valid(bad));
    let mut bad = good.clone();
    bad["logs"][1].as_object_mut().unwrap().remove("events");
    assert!(!events_valid(bad));
    let mut bad = good;
    bad["logs"][0]["events"][0]
        .as_object_mut()
        .unwrap()
        .remove("message");
    assert!(!events_valid(bad));
}
