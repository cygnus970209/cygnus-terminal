use super::*;
use serde_json::{json, Value};

fn valid() -> Value {
    json!({
        "schema":1,
        "cpu":[{"load":20,"logical":2},{"load":60,"logical":6}],
        "memory":{"total_kib":8192,"free_kib":2048},
        "disks":[{"name":"D:","total_bytes":2000,"free_bytes":500},{"name":"C:","total_bytes":1000,"free_bytes":500}],
        "uptime_seconds":90061,
        "processes":[{"pid":1,"name":"한글 서버.exe","memory_bytes":100},{"pid":2,"name":"w3wp.exe","memory_bytes":500}]
    })
}

fn parse(value: Value) -> Result<ServerStats, String> {
    normalize(
        serde_json::from_value(value).map_err(|_| "schema".to_string())?,
        "5.1.20348.1",
    )
}

#[test]
fn normalizes_weighted_cpu_kib_bytes_disks_and_processes() {
    let stats = parse(valid()).unwrap();
    assert_eq!(stats.platform, "windows");
    assert_eq!(stats.cpu_usage, Some(50.0));
    assert_eq!(stats.mem_total, Some(8388608));
    assert_eq!(stats.mem_usage, Some(75.0));
    assert_eq!(stats.disk_total, Some(3000));
    assert_eq!(stats.disk_used, Some(2000));
    assert_eq!(stats.disk_usage, Some(66.7));
    assert_eq!(stats.uptime.as_deref(), Some("1d 1h 1m"));
    assert_eq!(stats.load_avg, None);
    let details = stats.windows.unwrap();
    assert_eq!(details.disks.unwrap()[0].name, "C:");
    let processes = details.processes.unwrap();
    assert_eq!(processes[0].pid, 2);
    assert_eq!(processes[1].name, "한글 서버.exe");
}

#[test]
fn missing_permissions_are_nullable_without_losing_other_sections() {
    for field in ["cpu", "memory", "disks", "uptime_seconds", "processes"] {
        let mut data = valid();
        data[field] = Value::Null;
        let stats = parse(data).unwrap();
        let wire = serde_json::to_value(&stats).unwrap();
        let missing = match field {
            "cpu" => &wire["cpu_usage"],
            "memory" => &wire["mem_usage"],
            "disks" => &wire["disk_usage"],
            "uptime_seconds" => &wire["uptime"],
            _ => &wire["windows"]["processes"],
        };
        assert!(missing.is_null());
        if field != "memory" {
            assert_eq!(stats.mem_usage, Some(75.0));
        }
    }
    let stats = parse(json!({"schema":1,"cpu":null,"memory":null,"disks":null,"uptime_seconds":null,"processes":null})).unwrap();
    assert_eq!(stats.cpu_usage, None);
    assert_eq!(stats.mem_usage, None);
    assert_eq!(stats.disk_usage, None);
}

#[test]
fn distinguishes_empty_lists_and_rejects_missing_fields_or_scalar_lists() {
    let mut data = valid();
    data["processes"] = json!([]);
    data["disks"] = json!([]);
    data["cpu"] = json!([]);
    let stats = parse(data).unwrap();
    assert_eq!(stats.disk_usage, None);
    assert_eq!(stats.cpu_usage, None);
    assert!(stats.windows.unwrap().processes.unwrap().is_empty());
    for field in ["cpu", "memory", "disks", "uptime_seconds", "processes"] {
        let mut data = valid();
        data.as_object_mut().unwrap().remove(field);
        assert!(parse(data).is_err(), "missing {field}");
    }
    let mut data = valid();
    data["processes"] = data["processes"][0].clone();
    assert!(parse(data).is_err());
}

#[test]
fn rejects_invalid_numbers_duplicates_and_oversized_collections() {
    for (pointer, bad) in [
        ("/schema", json!(2)),
        ("/cpu/0/load", json!(101)),
        ("/cpu/0/load", json!(-1)),
        ("/cpu/0/logical", json!(0)),
        ("/memory/total_kib", json!(0)),
        ("/memory/total_kib", json!(u64::MAX)),
        ("/memory/free_kib", json!(9000)),
        ("/disks/0/name", json!("C:")),
        ("/disks/0/free_bytes", json!(5000)),
        ("/disks/0/total_bytes", json!(u64::MAX)),
        ("/processes/0/pid", json!(2)),
        ("/processes/0/name", json!("bad\nname")),
        ("/uptime_seconds", json!(-1)),
        ("/processes/0/memory_bytes", json!(-1)),
    ] {
        let mut data = valid();
        *data.pointer_mut(pointer).unwrap() = bad;
        assert!(parse(data).is_err(), "accepted {pointer}");
    }
    let mut data = valid();
    data["processes"] = json!(vec![data["processes"][0].clone(); 21]);
    assert!(parse(data).is_err());
    let mut data = valid();
    data["processes"][0]["command_line"] = json!("private-token");
    assert!(
        parse(data).is_err(),
        "unexpected process details must not pass through"
    );
}
