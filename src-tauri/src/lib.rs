// Riot Account Switcher — backend. Session-file swap, no stored passwords, no
// reverse engineering of the login protocol. See the project README.
use serde::{Deserialize, Serialize};
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::{thread, time::Duration};

const NO_WINDOW: u32 = 0x0800_0000; // CREATE_NO_WINDOW — no console flash
const DETACHED: u32 = 0x0000_0008; // DETACHED_PROCESS — launcher outlives us

const RIOT_PROCS: &[&str] = &[
    "RiotClientServices.exe", "RiotClientUx.exe", "RiotClientUxRender.exe",
    "RiotClientCrashHandler.exe", "RiotGamesServices.exe",
    "VALORANT.exe", "VALORANT-Win64-Shipping.exe",
    "LeagueClient.exe", "LeagueClientUx.exe", "LeagueClientUxRender.exe",
    "LeagueCrashHandler.exe", "League of Legends.exe",
];

fn local() -> PathBuf { PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()) }
fn programdata() -> PathBuf {
    PathBuf::from(std::env::var("PROGRAMDATA").unwrap_or_else(|_| r"C:\ProgramData".into()))
}
fn riot_data() -> PathBuf { local().join("Riot Games").join("Riot Client").join("Data") }
fn session_file() -> PathBuf { riot_data().join("RiotGamesPrivateSettings.yaml") }
fn app_dir() -> PathBuf { local().join("RiotSwitcher") }
fn sessions_dir() -> PathBuf { app_dir().join("sessions") }
fn accounts_file() -> PathBuf { app_dir().join("accounts.json") }
fn settings_file() -> PathBuf { app_dir().join("settings.json") }
fn configs_dir() -> PathBuf { app_dir().join("configs") }
fn principal_dir() -> PathBuf { configs_dir().join("principal") } // main account's saved config
fn backup_dir() -> PathBuf { configs_dir().join("backup") }       // per-account pre-import backup

// Game settings live in local config dirs, not in the account session. Same
// blunt whole-dir swap as the session file: save the main account's config,
// drop it onto whatever account is live, restore it on revert.
fn config_roots() -> Vec<(&'static str, PathBuf)> {
    [
        ("valorant", local().join("VALORANT").join("Saved").join("Config")),
        ("league", PathBuf::from(r"C:\Riot Games\League of Legends\Config")),
    ].into_iter().filter(|(_, p)| p.exists()).collect()
}

fn e2s<E: std::fmt::Display>(e: E) -> String { e.to_string() }

#[derive(Serialize, Deserialize, Clone)]
struct Account {
    id: String,
    name: String,
    #[serde(default)] riot_id: String,
    #[serde(default = "def_platform")] platform: String,
    #[serde(default)] has_2fa: bool,
}
fn def_platform() -> String { "br1".into() }

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    #[serde(default = "def_launch")] launch_target: String,
    #[serde(default)] active_id: String,
    #[serde(default)] principal_id: String, // the "main" account whose config we propagate
}
fn def_launch() -> String { "Valorant".into() }
impl Default for Settings {
    fn default() -> Self {
        Settings { launch_target: def_launch(), active_id: String::new(),
                   principal_id: String::new() }
    }
}

// ---- session validity: a real login carries a refresh_token ----
fn is_valid(p: &Path) -> bool {
    fs::read_to_string(p).map(|t| t.contains("refresh_token")).unwrap_or(false)
}

// ---- config commands ----
#[tauri::command]
fn list_accounts() -> Vec<Account> {
    fs::read_to_string(accounts_file()).ok()
        .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
#[tauri::command]
fn save_accounts(accounts: Vec<Account>) -> Result<(), String> {
    fs::create_dir_all(app_dir()).map_err(e2s)?;
    fs::write(accounts_file(), serde_json::to_string_pretty(&accounts).map_err(e2s)?).map_err(e2s)
}
#[tauri::command]
fn get_settings() -> Settings {
    fs::read_to_string(settings_file()).ok()
        .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
#[tauri::command]
fn save_settings(settings: Settings) -> Result<(), String> {
    fs::create_dir_all(app_dir()).map_err(e2s)?;
    fs::write(settings_file(), serde_json::to_string_pretty(&settings).map_err(e2s)?).map_err(e2s)
}
#[tauri::command]
fn session_valid(id: String) -> bool {
    is_valid(&sessions_dir().join(format!("{id}.yaml")))
}

// ---- identity: read Riot ID + MFA straight from the session's id_token JWT ----
// No network, no login protocol — the token is already sitting in the session
// file. `amr` lists the auth methods used at login, so "mfa" ⇒ 2FA was used.
#[derive(Serialize)]
struct Identity { riot_id: String, has_2fa: bool, platform: Option<String> }

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut buf, mut bits) = (0u32, 0u8);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            b'=' => break,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 { bits -= 8; out.push((buf >> bits) as u8); }
    }
    Some(out)
}

fn parse_identity(p: &Path) -> Option<Identity> {
    let text = fs::read_to_string(p).ok()?;
    let tok = text.lines().find_map(|l| {
        l.trim().strip_prefix("id_token:").map(|r| r.trim().trim_matches('"').to_string())
    })?;
    let payload = tok.split('.').nth(1)?;
    let v: serde_json::Value = serde_json::from_slice(&b64url_decode(payload)?).ok()?;
    let name = v.pointer("/acct/game_name").and_then(|x| x.as_str())?;
    let tag = v.pointer("/acct/tag_line").and_then(|x| x.as_str()).unwrap_or("");
    let riot_id = if tag.is_empty() { name.to_string() } else { format!("{name}#{tag}") };
    let has_2fa = v.get("amr").and_then(|a| a.as_array())
        .map(|a| a.iter().any(|x| x.as_str() == Some("mfa"))).unwrap_or(false);
    // region: LoL cpid (e.g. "BR1") lowercases straight into our platform list
    let platform = v.pointer("/lol_region/0/cpid").or_else(|| v.pointer("/lol/0/cpid"))
        .and_then(|x| x.as_str()).map(|s| s.to_lowercase());
    Some(Identity { riot_id, has_2fa, platform })
}

// Identity of whoever is currently logged into the live Riot Client. (A just-
// captured account's session is a copy of this file, so this covers both.)
#[tauri::command]
fn live_identity() -> Option<Identity> {
    parse_identity(&session_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_riot_id_and_mfa_from_jwt() {
        // {"acct":{"game_name":"aimstar","tag_line":"speed"},"amr":["password","mfa"]}
        let p = "eyJhY2N0Ijp7ImdhbWVfbmFtZSI6ImFpbXN0YXIiLCJ0YWdfbGluZSI6InNwZWVkIn0sImFtciI6WyJwYXNzd29yZCIsIm1mYSJdfQ";
        let v: serde_json::Value =
            serde_json::from_slice(&b64url_decode(p).unwrap()).unwrap();
        assert_eq!(v.pointer("/acct/game_name").unwrap().as_str(), Some("aimstar"));
        assert!(v["amr"].as_array().unwrap().iter().any(|x| x.as_str() == Some("mfa")));
    }
}

// ---- riot ops ----
fn find_launcher() -> Option<String> {
    let j = programdata().join("Riot Games").join("RiotClientInstalls.json");
    if let Ok(t) = fs::read_to_string(&j) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
            for k in ["rc_live", "rc_default", "rc_beta"] {
                if let Some(p) = v.get(k).and_then(|x| x.as_str()) {
                    if Path::new(p).exists() { return Some(p.to_string()); }
                }
            }
        }
    }
    let p = r"C:\Riot Games\Riot Client\RiotClientServices.exe";
    if Path::new(p).exists() { Some(p.into()) } else { None }
}

fn kill_riot() {
    for n in RIOT_PROCS {
        let _ = Command::new("taskkill").args(["/F", "/IM", n])
            .creation_flags(NO_WINDOW).output();
    }
}

fn launch(target: &str) -> Result<(), String> {
    let exe = find_launcher().ok_or("RiotClientServices.exe not found.")?;
    let mut c = Command::new(exe);
    match target {
        "Valorant" => { c.arg("--launch-product=valorant").arg("--launch-patchline=live"); }
        "League of Legends" => { c.arg("--launch-product=league_of_legends").arg("--launch-patchline=live"); }
        _ => {}
    }
    c.creation_flags(DETACHED);
    c.spawn().map_err(e2s)?;
    Ok(())
}

#[tauri::command]
fn capture(id: String) -> Result<(), String> {
    let sf = session_file();
    if !sf.exists() {
        return Err("Riot session not found. Open and log in to Riot Client first.".into());
    }
    if !is_valid(&sf) {
        return Err("Riot Client is logged out. Log in with 'Stay signed in' and try again.".into());
    }
    fs::create_dir_all(sessions_dir()).map_err(e2s)?;
    fs::copy(&sf, sessions_dir().join(format!("{id}.yaml"))).map_err(e2s)?;
    Ok(())
}

#[tauri::command]
fn switch(target_id: String, launch_target: String, active_id: String) -> Result<(), String> {
    let src = sessions_dir().join(format!("{target_id}.yaml"));
    if !is_valid(&src) {
        return Err("This account session is empty. Log in to it and click Recapture.".into());
    }
    let sf = session_file();
    // keep the departing account's rotated token fresh
    if !active_id.is_empty() && active_id != target_id && is_valid(&sf) {
        let _ = fs::copy(&sf, sessions_dir().join(format!("{active_id}.yaml")));
    }
    kill_riot();
    thread::sleep(Duration::from_millis(1500));
    fs::create_dir_all(riot_data()).map_err(e2s)?;
    fs::copy(&src, &sf).map_err(e2s)?;
    launch(&launch_target)
}

#[tauri::command]
fn logout_local(launch_target: String) -> Result<(), String> {
    kill_riot();
    thread::sleep(Duration::from_millis(1500));
    let _ = fs::remove_file(session_file());
    launch(&launch_target)
}

// ---- game config swap ----
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

fn snapshot(roots: &[(&str, PathBuf)], store: &Path) -> Result<(), String> {
    for (key, root) in roots {
        let dst = store.join(key);
        if dst.exists() { fs::remove_dir_all(&dst).map_err(e2s)?; }
        copy_dir_all(root, &dst).map_err(e2s)?;
    }
    Ok(())
}

fn restore(roots: &[(&str, PathBuf)], store: &Path) -> Result<(), String> {
    for (key, root) in roots {
        let src = store.join(key);
        if !src.exists() { continue; }
        if root.exists() { fs::remove_dir_all(root).map_err(e2s)?; }
        copy_dir_all(&src, root).map_err(e2s)?;
    }
    Ok(())
}

#[tauri::command]
fn save_principal_configs() -> Result<(), String> {
    let roots = config_roots();
    if roots.is_empty() {
        return Err("No game config folder found (Valorant/LoL).".into());
    }
    snapshot(&roots, &principal_dir())
}

#[tauri::command]
fn import_configs(active_id: String) -> Result<(), String> {
    if active_id.is_empty() {
        return Err("No active account. Switch to the account before importing.".into());
    }
    if !principal_dir().exists() {
        return Err("Save the main account's configs first.".into());
    }
    let roots = config_roots();
    if roots.is_empty() {
        return Err("No game config folder found (Valorant/LoL).".into());
    }
    kill_riot();
    thread::sleep(Duration::from_millis(1500));
    snapshot(&roots, &backup_dir().join(&active_id))?; // so revert can bring this account back
    restore(&roots, &principal_dir())                  // main's config over the live one
}

#[tauri::command]
fn revert_configs(active_id: String) -> Result<(), String> {
    let store = backup_dir().join(&active_id);
    if !store.exists() {
        return Err("No backup for this account. Nothing to revert.".into());
    }
    kill_riot();
    thread::sleep(Duration::from_millis(1500));
    restore(&config_roots(), &store)
}

// Relaunch elevated (UAC) once, so taskkill can stop the elevated Riot Client.
// No admin manifest — that conflicts with tauri-build's own manifest.
#[cfg(windows)]
fn ensure_elevated() {
    if std::env::args().any(|a| a == "--elevated") {
        return; // already the elevated instance
    }
    if let Ok(exe) = std::env::current_exe() {
        if runas::Command::new(exe).arg("--elevated").gui(true).status().is_ok() {
            std::process::exit(0); // elevated copy took over
        }
    }
    // UAC denied / failed: fall through and run unelevated (switch will error).
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    ensure_elevated();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_accounts, save_accounts, get_settings, save_settings,
            session_valid, live_identity, capture, switch, logout_local,
            save_principal_configs, import_configs, revert_configs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
