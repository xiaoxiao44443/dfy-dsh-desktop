window.__ModuleLoader__.load({
  id: "dsh-desktop-browser",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const Primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const SETTINGS_PATH = "/api/dsh-desktop/browser/settings";
    const HISTORY_PATH = "/api/dsh-desktop/browser/history";
    const CLEAR_DATA_PATH = "/api/dsh-desktop/browser/clear-data";
    const SCREENSHOTS_PATH = "/api/dsh-desktop/browser/screenshots";
    const REVEAL_SCREENSHOTS_PATH = "/api/dsh-desktop/browser/screenshots/reveal";
    const STYLE_ID = "dsh-desktop-browser-settings-styles";
    const DEFAULT_SETTINGS = Object.freeze({ enabled: true, agentOpenMode: "background", displayMode: "split" });

    function normalizeSettings(value) {
      const source = value !== null && typeof value === "object" ? value : {};
      return {
        enabled: typeof source.enabled === "boolean" ? source.enabled : true,
        agentOpenMode: source.agentOpenMode === "visible" ? "visible" : "background",
        displayMode: source.displayMode === "drawer" || source.displayMode === "floating" ? source.displayMode : "split"
      };
    }

    function revealScreenshotsLabel() {
      const platform = typeof navigator === "undefined" ? "" : navigator.platform;
      if (/^Mac/iu.test(platform)) return "在 Finder 中显示";
      if (/^Win/iu.test(platform)) return "在资源管理器中显示";
      return "在文件管理器中显示";
    }

    async function request(path, options) {
      const response = await fetch(path, { cache: "no-store", ...options });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
      return payload;
    }

    const SETTINGS_STYLES = `
        .dsh-desktop-browser-settings { width: 100%; color: var(--dsw-alias-label-primary); }
        .dsh-desktop-browser-settings h2 { margin: 0 0 22px; font-size: 18px; font-weight: 650; }
        .dsh-desktop-browser-feature { display: flex; align-items: center; gap: 16px; box-sizing: border-box; min-height: 68px; padding: 10px 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 86%, transparent); }
        .dsh-desktop-browser-feature-icon { display: grid; place-items: center; flex: 0 0 auto; width: 44px; height: 44px; color: var(--dsw-alias-label-primary); }
        .dsh-desktop-browser-feature-icon svg { width: 42px; height: 42px; }
        .dsh-desktop-browser-copy { flex: 1; min-width: 0; }
        .dsh-desktop-browser-title { font-size: 14px; line-height: 22px; font-weight: 550; color: var(--dsw-alias-label-primary); }
        .dsh-desktop-browser-description { font-size: 12px; line-height: 18px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
        .dsh-desktop-browser-row { display: flex; align-items: center; gap: 16px; min-height: 76px; padding: 16px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
        .dsh-desktop-browser-row:last-of-type { border-bottom: 0; }
        .dsh-desktop-browser-row .dsh-desktop-browser-copy { padding-right: 48px; }
        .dsh-desktop-browser-control { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
        .dsh-desktop-browser-menu-trigger { min-width: 146px; height: 36px; padding: 0 14px; border: 0; border-radius: 18px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-module-platform); font: inherit; font-size: 14px; cursor: pointer; display: inline-flex; align-items: center; justify-content: space-between; gap: 12px; transition: background 120ms ease; }
        .dsh-desktop-browser-menu-trigger:hover, .dsh-desktop-browser-menu-trigger[data-open="true"] { background: var(--dsw-alias-interactive-bg-hover); }
        .dsh-desktop-browser-menu-trigger:disabled { cursor: default; opacity: .55; }
        .dsh-desktop-browser-switch { width: 36px; height: 22px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-bg-module-platform); cursor: pointer; transition: background 120ms ease, opacity 120ms ease; }
        .dsh-desktop-browser-switch[aria-checked="true"] { background: var(--dsw-alias-state-business-primary); }
        .dsh-desktop-browser-switch:disabled { cursor: default; opacity: .55; }
        .dsh-desktop-browser-switch span { display: block; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.28); transform: translateX(0); transition: transform 120ms ease; }
        .dsh-desktop-browser-switch[aria-checked="true"] span { transform: translateX(14px); }
        .dsh-desktop-browser-action { min-height: 34px; padding: 0 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; color: var(--dsw-alias-label-primary); background: transparent; font: inherit; font-size: 13px; font-weight: 400; cursor: pointer; transition: background 120ms ease, color 120ms ease; }
        .dsh-desktop-browser-action:hover { background: var(--dsw-alias-interactive-bg-hover); }
        .dsh-desktop-browser-action[data-confirm="true"] { color: #ef6b73; }
        .dsh-desktop-browser-action:disabled { cursor: default; opacity: .5; }
        .dsh-desktop-browser-error { margin: 12px 0 0; color: #ef6b73; font-size: 12px; }
        [data-tool^="browser_"]:not([data-state="error"]):not([data-state="stopped"]) [class*="_leading"] > * { display: none !important; }
        [data-tool^="browser_"]:not([data-state="error"]):not([data-state="stopped"]) [class*="_leading"]::before {
          width: 14px;
          height: 14px;
          flex: none;
          background: currentColor;
          content: "";
          -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='4' width='18' height='16' rx='2'/%3E%3Cpath d='M3 8h18M9.5 11.5l7 5.4-4.1.5-1.9 3.4-1.7-.9 1.8-3.3-3.1-2.5Z'/%3E%3C/svg%3E") center / contain no-repeat;
          mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='4' width='18' height='16' rx='2'/%3E%3Cpath d='M3 8h18M9.5 11.5l7 5.4-4.1.5-1.9 3.4-1.7-.9 1.8-3.3-3.1-2.5Z'/%3E%3C/svg%3E") center / contain no-repeat;
        }
      `;

    function BrowserIcon() {
      return React.createElement("svg", { viewBox: "0 0 48 48", fill: "none", "aria-hidden": true },
        React.createElement("rect", { x: 5.5, y: 7.5, width: 32, height: 27, rx: 8, stroke: "currentColor", strokeWidth: 3 }),
        React.createElement("path", { d: "M6.5 15.5h30", stroke: "currentColor", strokeWidth: 3, strokeLinecap: "round" }),
        React.createElement("circle", { cx: 11, cy: 11.5, r: 1.5, fill: "currentColor" }),
        React.createElement("circle", { cx: 16, cy: 11.5, r: 1.5, fill: "currentColor" }),
        React.createElement("path", { d: "m25 24 15 7-7 2-3 7-5-16Z", fill: "var(--dsw-alias-bg-base)", stroke: "currentColor", strokeWidth: 2.6, strokeLinejoin: "round" })
      );
    }

    function Toggle({ checked, disabled, label, onChange }) {
      return React.createElement("button", {
        className: "dsh-desktop-browser-switch",
        type: "button",
        role: "switch",
        "aria-checked": checked,
        "aria-label": label,
        disabled,
        onClick: () => onChange(!checked)
      }, React.createElement("span", null));
    }

    function OpenModeMenu({ value, disabled, onChange }) {
      const [open, setOpen] = React.useState(false);
      const labels = { background: "在后台打开", visible: "显示浏览器" };
      const anchor = React.createElement("button", {
        className: "dsh-desktop-browser-menu-trigger",
        type: "button",
        "aria-label": "Agent 打开网页时",
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "data-open": String(open),
        disabled,
        onClick: () => setOpen((current) => !current)
      }, React.createElement("span", null, labels[value]), React.createElement(Primitives.IconChevronDownOutline14, { size: 14 }));
      return React.createElement(Primitives.Menu, {
        open,
        anchor,
        items: [
          { id: "background", label: labels.background },
          { id: "visible", label: labels.visible }
        ],
        selectedId: value,
        onSelect: (id) => { setOpen(false); onChange(id); },
        onClose: () => setOpen(false),
        align: "end",
        portal: true
      });
    }

    function DisplayModeMenu({ value, disabled, onChange }) {
      const [open, setOpen] = React.useState(false);
      const labels = { split: "分栏", drawer: "抽屉", floating: "独立窗口" };
      const anchor = React.createElement("button", {
        className: "dsh-desktop-browser-menu-trigger",
        type: "button",
        "aria-label": "浏览器显示方式",
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "data-open": String(open),
        disabled,
        onClick: () => setOpen((current) => !current)
      }, React.createElement("span", null, labels[value]), React.createElement(Primitives.IconChevronDownOutline14, { size: 14 }));
      return React.createElement(Primitives.Menu, {
        open,
        anchor,
        items: [
          { id: "split", label: labels.split },
          { id: "drawer", label: labels.drawer },
          { id: "floating", label: labels.floating }
        ],
        selectedId: value,
        onSelect: (id) => { setOpen(false); onChange(id); },
        onClose: () => setOpen(false),
        align: "end",
        portal: true
      });
    }

    function SettingRow({ title, description, children }) {
      return React.createElement("div", { className: "dsh-desktop-browser-row" },
        React.createElement("div", { className: "dsh-desktop-browser-copy" },
          React.createElement("div", { className: "dsh-desktop-browser-title" }, title),
          React.createElement("div", { className: "dsh-desktop-browser-description" }, description)
        ),
        React.createElement("div", { className: "dsh-desktop-browser-control" }, children)
      );
    }

    function BrowserSettingsSection() {
      const [settings, setSettings] = React.useState(DEFAULT_SETTINGS);
      const [loading, setLoading] = React.useState(true);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState("");
      const [confirmAction, setConfirmAction] = React.useState("");

      React.useEffect(() => {
        let active = true;
        void request(SETTINGS_PATH)
          .then((payload) => { if (active) setSettings(normalizeSettings(payload.settings)); })
          .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
          .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
      }, []);

      const update = React.useCallback(async (patch) => {
        const previous = settings;
        const next = { ...settings, ...patch };
        setSettings(next);
        setSaving(true);
        setError("");
        try {
          const payload = await request(SETTINGS_PATH, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(next)
          });
          setSettings(normalizeSettings(payload.settings));
        } catch (cause) {
          setSettings(previous);
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setSaving(false);
        }
      }, [settings]);

      const clear = React.useCallback(async (kind) => {
        if (confirmAction !== kind) { setConfirmAction(kind); return; }
        setSaving(true);
        setError("");
        try {
          await request(kind === "history" ? HISTORY_PATH : kind === "screenshots" ? SCREENSHOTS_PATH : CLEAR_DATA_PATH, {
            method: kind === "history" || kind === "screenshots" ? "DELETE" : "POST"
          });
          setConfirmAction("");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setSaving(false);
        }
      }, [confirmAction]);

      const revealScreenshots = React.useCallback(async () => {
        setSaving(true);
        setError("");
        try {
          await request(REVEAL_SCREENSHOTS_PATH, { method: "POST" });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setSaving(false);
        }
      }, []);

      const disabled = loading || saving;
      return React.createElement("section", { className: "dsh-desktop-browser-settings" },
        React.createElement("style", { id: STYLE_ID }, SETTINGS_STYLES),
        React.createElement("h2", null, "浏览器"),
        React.createElement("div", { className: "dsh-desktop-browser-feature" },
          React.createElement("div", { className: "dsh-desktop-browser-feature-icon" }, React.createElement(BrowserIcon)),
          React.createElement("div", { className: "dsh-desktop-browser-copy" },
            React.createElement("div", { className: "dsh-desktop-browser-title" }, "浏览器"),
            React.createElement("div", { className: "dsh-desktop-browser-description" }, "让 DFY DSH Desktop 控制内置浏览器")
          ),
          React.createElement(Toggle, {
            checked: settings.enabled,
            disabled,
            label: "启用内置浏览器",
            onChange: (enabled) => void update({ enabled })
          })
        ),
        React.createElement(SettingRow, { title: "Agent 打开网页时", description: "选择网页默认在后台运行，还是立即显示浏览器面板" },
          React.createElement(OpenModeMenu, {
            value: settings.agentOpenMode,
            disabled,
            onChange: (agentOpenMode) => void update({ agentOpenMode })
          })
        ),
        React.createElement(SettingRow, { title: "显示方式", description: "分栏会调整主界面宽度；抽屉覆盖主界面；独立窗口可自由移动和缩放" },
          React.createElement(DisplayModeMenu, {
            value: settings.displayMode,
            disabled,
            onChange: (displayMode) => void update({ displayMode })
          })
        ),
        React.createElement(SettingRow, { title: "浏览历史", description: "清除内置浏览器记录的访问历史" },
          React.createElement("button", {
            className: "dsh-desktop-browser-action",
            type: "button",
            disabled,
            "data-confirm": String(confirmAction === "history"),
            onClick: () => void clear("history")
          }, confirmAction === "history" ? "再次点击确认" : "清除历史记录")
        ),
        React.createElement(SettingRow, { title: "浏览器截图与临时附件", description: "只清理浏览器生成的临时 PNG；不会删除 Cookie、登录状态、历史或正式对话附件" },
          React.createElement("button", {
            className: "dsh-desktop-browser-action",
            type: "button",
            disabled,
            onClick: () => void revealScreenshots()
          }, revealScreenshotsLabel()),
          React.createElement("button", {
            className: "dsh-desktop-browser-action",
            type: "button",
            disabled,
            "data-confirm": String(confirmAction === "screenshots"),
            onClick: () => void clear("screenshots")
          }, confirmAction === "screenshots" ? "再次点击确认" : "清理临时截图")
        ),
        React.createElement(SettingRow, { title: "网站数据", description: "清除缓存、Cookie、站点存储和登录状态" },
          React.createElement("button", {
            className: "dsh-desktop-browser-action",
            type: "button",
            disabled,
            "data-confirm": String(confirmAction === "data"),
            onClick: () => void clear("data")
          }, confirmAction === "data" ? "再次点击确认" : "清除浏览数据")
        ),
        error ? React.createElement("p", { className: "dsh-desktop-browser-error", role: "alert" }, `浏览器操作失败：${error}`) : null
      );
    }

    exports.name = "desktop-browser-settings";
    exports.inject = ["slots"];
    exports.apply = function apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "desktop-browser",
        order: 25,
        label: "浏览器"
      }, BrowserSettingsSection));
    };
    return module.exports;
  }
});
