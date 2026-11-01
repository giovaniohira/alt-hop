// Fake Tauri backend for screenshots/demos. Fictional accounts, nothing touches
// Riot. `#scene` in the URL opens a view: add, configs, switching, remove, empty.
(() => {
  const scene = location.hash.slice(1);
  let accounts = scene === "empty" ? [] : [
    { id: "a1", name: "Main", riot_id: "NightOwl#BR1", platform: "br1", has_2fa: true },
    { id: "a2", name: "Smurf", riot_id: "PixelDrift#0042", platform: "br1", has_2fa: false },
    { id: "a3", name: "EU alt", riot_id: "QuietStorm#EUW", platform: "euw1", has_2fa: true },
    { id: "a4", name: "Duo", riot_id: "LemonTea#7777", platform: "na1", has_2fa: false },
  ];
  let settings = { launch_target: "Valorant", active_id: "a2", principal_id: scene === "empty" ? "" : "a1" };
  const live = { riot_id: "CobaltFox#BR1", has_2fa: true, platform: "br1" };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const cmds = {
    list_accounts: () => structuredClone(accounts),
    save_accounts: ({ accounts: a }) => { accounts = a; },
    get_settings: () => ({ ...settings }),
    save_settings: ({ settings: s }) => { settings = s; },
    session_valid: ({ id }) => id !== "a4",
    live_identity: () => live,
    capture: () => {},
    switch: () => wait(scene === "switching" ? 1e9 : 1200),
    logout_local: () => {},
    save_principal_configs: () => {},
    import_configs: () => {},
    revert_configs: () => {},
  };

  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => cmds[cmd](args || {}) },
    window: { getCurrentWindow: () => ({ close() {} }) },
  };

  const click = (s) => document.querySelector(s)?.click();
  addEventListener("load", () => setTimeout(() => {
    if (scene === "add") click("#btn-add");
    if (scene === "configs") click("#rail-configs");
    if (scene === "switching") click('[data-id="a3"] [data-act="switch"]');
    if (scene === "remove") click('[data-id="a4"] [data-act="delete"]');
  }, 300));
})();
