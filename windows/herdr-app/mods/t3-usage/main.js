import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec, layout, nextCommand, run, theme } from "herdr";

const EVERY = 5 * 60 * 1000;
const STALE_AFTER = 60 * 60 * 1000;
// The collector may ask Codex (about 12 s at most) and, every 15 minutes, `ant` twice.
const EXEC_TIMEOUT = 60 * 1000;
const CACHE_KEY = "t3-usage:schema-2";
const LOCAL_STATES = new Set(["ok", "empty", "unavailable", "error"]);
const QUOTA_STATES = new Set(["ok", "stale", "unavailable", "error"]);
const CLAUDE_TOKENS = ["totalTokens", "inputTokens", "cacheCreationTokens", "cacheReadTokens", "outputTokens"];
const OPENAI_TOKENS = ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"];
const TOKEN_UNITS = ["", "K", "M", "B", "T", "Q"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function safeDate(value, allowEpoch = false) {
  let date;
  if (typeof value === "string") {
    date = new Date(value);
  } else if (allowEpoch && Number.isSafeInteger(value) && value > 0) {
    date = new Date(value < 1000000000000 ? value * 1000 : value);
  } else {
    return null;
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeLabel(value) {
  if (typeof value !== "string") return null;
  const label = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return label ? label.slice(0, 64) : null;
}

function safeTokens(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safePercent(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function sanitizeWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const windowMinutes = Number.isSafeInteger(value.windowMinutes) && value.windowMinutes > 0
    ? value.windowMinutes : null;
  const usedPercent = safePercent(value.usedPercent);
  const remainingPercent = safePercent(value.remainingPercent);
  const resetsAt = safeDate(value.resetsAt, true);
  if (windowMinutes == null || usedPercent == null || remainingPercent == null || !resetsAt) return null;
  if (Math.abs(usedPercent + remainingPercent - 100) > 0.001) return null;
  return { windowMinutes, usedPercent, remainingPercent, resetsAt };
}

function sanitizeQuota(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !QUOTA_STATES.has(value.state)) {
    return { state: "error", windows: [] };
  }

  const quota = { state: value.state, windows: [] };
  const observedAt = safeDate(value.observedAt);
  const plan = safeLabel(value.plan);
  if (observedAt) quota.observedAt = observedAt;
  if (plan) quota.plan = plan;
  if (Array.isArray(value.windows)) {
    const seen = new Set();
    for (const candidate of value.windows) {
      const window = sanitizeWindow(candidate);
      if (window && !seen.has(window.windowMinutes)) {
        seen.add(window.windowMinutes);
        quota.windows.push(window);
      }
    }
    quota.windows.sort((a, b) => a.windowMinutes - b.windowMinutes);
  }

  if ((quota.state === "ok" || quota.state === "stale")
      && (quota.windows.length === 0 || !quota.observedAt)) {
    return { state: "error", windows: [] };
  }
  if (quota.state === "unavailable" || quota.state === "error") quota.windows = [];
  return quota;
}

function sanitizeProvider(value, tokenFields, includeTier = false) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !LOCAL_STATES.has(value.state)) {
    return { state: "error", quota: { state: "error", windows: [] } };
  }

  const provider = { state: value.state, quota: sanitizeQuota(value.quota) };
  for (const field of tokenFields) {
    const count = safeTokens(value[field]);
    if (count != null) provider[field] = count;
  }
  const model = safeLabel(value.model);
  const sourceUpdatedAt = safeDate(value.sourceUpdatedAt);
  if (model) provider.model = model;
  if (sourceUpdatedAt) provider.sourceUpdatedAt = sourceUpdatedAt;
  if (includeTier) {
    const serviceTier = safeLabel(value.serviceTier);
    if (serviceTier) provider.serviceTier = serviceTier;
  }

  if (provider.state === "ok" && provider.totalTokens == null) provider.state = "error";
  return provider;
}

// The Claude card's "API cost" line (Usage and Cost Analytics API through `ant`, see collect-usage.ps1).
const API_COST_STATES = new Set(["ok", "unconfigured", "unavailable", "auth_failed", "org_required", "error"]);

function sanitizeApiCost(value) {
  if (!value || typeof value !== "object" || !API_COST_STATES.has(value.state)) return null;
  if (value.state !== "ok") return { state: value.state };
  const usd = (n) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);
  const todayUsd = usd(value.todayUsd);
  const monthUsd = usd(value.monthUsd);
  if (todayUsd == null || monthUsd == null) return { state: "error" };
  const apiCost = { state: "ok", todayUsd, monthUsd };
  const refreshedAt = safeDate(value.refreshedAt);
  if (refreshedAt) apiCost.refreshedAt = refreshedAt;
  return apiCost;
}

function sanitizeUsage(value) {
  const generatedAt = safeDate(value?.generatedAt);
  const periodStart = safeDate(value?.periodStart);
  const periodEnd = safeDate(value?.periodEnd);
  if (!value || value.schema !== 2 || !generatedAt || !periodStart || !periodEnd
      || new Date(periodEnd).getTime() <= new Date(periodStart).getTime()) {
    throw new Error("Invalid usage result");
  }
  return {
    schema: 2,
    generatedAt,
    periodStart,
    periodEnd,
    claude: { ...sanitizeProvider(value.claude, CLAUDE_TOKENS), apiCost: sanitizeApiCost(value.claude?.apiCost) },
    openai: sanitizeProvider(value.openai, OPENAI_TOKENS, true),
  };
}

function cachedUsage() {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    return cached == null ? null : sanitizeUsage(JSON.parse(cached));
  } catch (_error) {
    return null;
  }
}

// No Intl in Herdr's runtime: dollars and cents by hand, thousands grouped above $1,000.
function formatUsd(value) {
  if (value < 1000) return `$${value.toFixed(2)}`;
  return `$${String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function apiCostText(apiCost) {
  if (!apiCost || apiCost.state === "unavailable") return null;
  if (apiCost.state === "unconfigured") return "API cost: not set up (README: Claude API cost)";
  if (apiCost.state === "auth_failed") return "API cost: sign-in or Admin key rejected";
  if (apiCost.state === "org_required") return "API cost: needs a Console organization (README)";
  if (apiCost.state === "error") return "API cost unavailable";
  if (!apiCost.refreshedAt) return "API cost: no data yet";
  return `API cost today ${formatUsd(apiCost.todayUsd)} · month ${formatUsd(apiCost.monthUsd)} · through ${formatReset(apiCost.refreshedAt)}`;
}

function compactTokens(value) {
  let scaled = value;
  let unit = 0;
  while (scaled >= 1000 && unit < TOKEN_UNITS.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  let shown = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  if (shown >= 1000 && unit < TOKEN_UNITS.length - 1) {
    shown = 1;
    unit += 1;
  }
  return `${shown}${TOKEN_UNITS[unit]}`;
}

function clockText(date) {
  const hour = date.getHours();
  const minute = date.getMinutes();
  return `${hour % 12 || 12}:${minute < 10 ? "0" : ""}${minute} ${hour < 12 ? "AM" : "PM"}`;
}

function formatClock(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? clockText(date) : null;
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${MONTHS[date.getMonth()]} ${date.getDate()}, ${clockText(date)}` : null;
}

function formatReset(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
    ? clockText(date)
    : `${MONTHS[date.getMonth()]} ${date.getDate()}, ${clockText(date)}`;
}

function windowLabel(minutes) {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// The panel's layout node. Hiding it is Herdr's own `layout.hide`/`layout.toggle` on this id:
// the sidebar reflows with no gap, and Herdr keeps the choice across restarts (layouts/.state).
const NODE = "usage";

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

const panelHidden = () => Boolean(findNode(layout(), NODE)?.hidden);

function providerModel(provider) {
  const labels = [provider?.model, provider?.serviceTier, provider?.quota?.plan].filter(Boolean);
  return labels.filter((label, index) => labels.indexOf(label) === index).join(" · ");
}

export default class UsagePanel extends View {
  init(_props, cx) {
    this.data = cachedUsage();
    this.loading = false;
    this.failed = false;
    // Herdr keeps a hidden block's copy and its timers alive, so each tick checks first and
    // skips the collector while the panel is hidden; showing it again refreshes at once.
    this.skipped = false;
    cx.timer.every(EVERY, (cx) => this.poll(cx));
    cx.timer.after(0, (cx) => this.poll(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        if (await nextCommand() === "refresh") this.refresh(cx, true);
      }
    });
  }

  poll(cx) {
    if (panelHidden()) {
      this.skipped = true;
      return;
    }
    this.refresh(cx);
  }


  refresh(cx, manual = false) {
    if (this.loading) return;
    this.loading = true;
    if (manual) cx.notify();

    cx.spawn(async (cx) => {
      try {
        const result = await exec("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy", "Bypass",
          "-File", `${appHome()}/mods/t3-usage/collect-usage.ps1`,
        ], { timeout: EXEC_TIMEOUT });
        if (result.code !== 0) throw new Error("Collector failed");
        const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
        this.data = sanitizeUsage(parsed);
        this.failed = false;
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(this.data));
        } catch (_error) {
          // A storage failure must not discard fresh, sanitized usage.
        }
      } catch (_error) {
        // Collector details are intentionally never retained or rendered.
        this.failed = true;
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  headingStatus() {
    const updated = this.data && formatClock(this.data.generatedAt);
    if (this.failed) return updated ? `Update failed · Updated ${updated}` : "Update failed";
    if (this.loading) return updated ? `Updating · Updated ${updated}` : "Loading usage…";
    return updated ? `Updated ${updated}` : "Loading usage…";
  }

  progressBar(t, id, window, stale) {
    // Calm until the window is mostly spent: amber from 75%, red from 90%.
    const fill = stale ? t.muted
      : window.usedPercent >= 90 ? t.ansi1
      : window.usedPercent >= 75 ? t.ansi3
      : t.accent;
    return h_flex()
      .id(`usage-${id}-quota-progress`)
      .w_full().h(5).flex_none().overflow_hidden().rounded_full().bg(t.border)
      .accessibility_label(`${window.usedPercent}% used, ${window.remainingPercent}% left`)
      .when(window.usedPercent > 0, (el) => el.child(
        div().h_full().flex_grow(window.usedPercent).bg(fill),
      ))
      .when(window.remainingPercent > 0, (el) => el.child(
        div().h_full().flex_grow(window.remainingPercent),
      ));
  }

  providerCard(t, id, name, provider) {
    const now = Date.now();
    const localState = provider?.state ?? (this.failed ? "error" : "loading");
    const quota = provider?.quota;
    let quotaState = quota?.state ?? (this.failed ? "error" : "loading");
    const windows = quota?.windows?.filter((window) => new Date(window.resetsAt).getTime() > now) ?? [];
    if ((quotaState === "ok" || quotaState === "stale") && windows.length === 0) {
      quotaState = "unavailable";
    } else if (quotaState === "ok"
        && (this.failed || now - new Date(quota.observedAt).getTime() > STALE_AFTER)) {
      quotaState = "stale";
    }
    const trustedQuota = (quotaState === "ok" || quotaState === "stale") && windows.length > 0;
    const primaryWindow = trustedQuota ? windows[0] : null;
    const secondWindow = trustedQuota && windows.length > 1 ? windows[1] : null;
    const model = providerModel(provider);
    const periodEnd = this.data?.periodEnd && new Date(this.data.periodEnd).getTime();
    const previousLocalDay = Number.isFinite(periodEnd) && periodEnd <= now;
    const localReset = !previousLocalDay && this.data?.periodEnd && formatClock(this.data.periodEnd);
    const localText = previousLocalDay && localState === "ok"
      ? `Previous local day ${compactTokens(provider.totalTokens)} tokens · stale`
      : previousLocalDay && localState === "empty"
        ? "Previous local day 0 tokens · stale"
        : localState === "ok"
          ? `Today local ${compactTokens(provider.totalTokens)} tokens${localReset ? ` · resets ${localReset}` : ""}`
          : localState === "empty"
            ? `Today local 0 tokens${localReset ? ` · resets ${localReset}` : ""}`
            : localState === "unavailable" ? "Today local activity unavailable"
            : localState === "error" ? "Could not read Today local activity"
            : "Loading Today local activity…";
    const quotaText = trustedQuota
      ? `${primaryWindow.usedPercent}% used · ${primaryWindow.remainingPercent}% left`
      : quotaState === "unavailable"
        ? (id === "claude" ? "Quota appears after your next Claude reply" : "Provider quota unavailable")
      : quotaState === "error" ? "Could not read provider quota"
      : "Loading provider quota…";
    const quotaColor = quotaState === "error" ? t.ansi1
      : quotaState === "ok" ? t.foreground : t.muted;
    const localColor = localState === "error" ? t.ansi1 : t.dim;
    const costText = id === "claude" ? apiCostText(provider?.apiCost) : null;
    const costColor = provider?.apiCost?.state === "ok" ? t.muted
      : provider?.apiCost?.state === "auth_failed" ? t.ansi1 : t.dim;
    return v_flex()
      .id(`usage-${id}`)
      .flex_1().min_h(0)
      .px(12).py(4).gap(1)
      .border_t(1).border_color(t.border)
      .child(h_flex().min_w(0).items_center().text_size(11)
        .child(div().flex_none().font_medium().text_color(t.muted).child(name))
        .child(div().flex_1())
        .when(Boolean(model), (el) => el.child(
          div().min_w(0).max_w(210).truncate().text_color(t.dim).child(model),
        )))
      .when(quotaState === "stale", (el) => el.child(
        div().min_w(0).truncate().text_size(10).text_color(t.muted)
          .child(`Stale · last observed ${formatDateTime(quota.observedAt)}`),
      ))
      .child(div().min_w(0).truncate().text_size(11).font_medium().text_color(quotaColor).child(quotaText))
      .when(Boolean(primaryWindow), (el) => el.child(this.progressBar(t, id, primaryWindow, quotaState === "stale")))
      .when(Boolean(primaryWindow), (el) => el.child(
        div().min_w(0).truncate().text_size(10).text_color(t.dim)
          .child(`Resets ${formatReset(primaryWindow.resetsAt)} · ${windowLabel(primaryWindow.windowMinutes)}`),
      ))
      .when(Boolean(secondWindow), (el) => el.child(
        div().min_w(0).truncate().text_size(10).text_color(t.dim)
          .child(`${windowLabel(secondWindow.windowMinutes)} ${secondWindow.usedPercent}% used · ${secondWindow.remainingPercent}% left · resets ${formatReset(secondWindow.resetsAt)}`),
      ))
      .child(div().min_w(0).truncate().text_size(10).text_color(localColor).child(localText))
      .when(Boolean(costText), (el) => el.child(
        div().min_w(0).truncate().text_size(10).text_color(costColor).child(costText),
      ));
  }

  render(cx) {
    const t = theme();
    if (this.skipped && !panelHidden()) {
      this.skipped = false;
      cx.timer.after(0, (cx) => this.refresh(cx));
    }
    const claude = this.data?.claude;
    const openai = this.data?.openai;

    return v_flex()
      .id("t3-usage-root")
      .size_full().min_h(0)
      .bg(t.chrome)
      .border_t(1).border_color(t.border)
      .text_size(12)
      .child(h_flex()
        .id("usage-heading")
        .h(35).flex_none()
        .pl(16).pr(10).items_center()
        .child(v_flex().flex_1().min_w(0)
          .child(div().font_medium().text_color(t.muted).child("AI usage"))
          .child(div().min_w(0).truncate().text_size(10).text_color(this.failed ? t.ansi1 : t.dim).child(this.headingStatus())))
        .child(div()
          .id("usage-refresh")
          .size(26).flex_none().flex().items_center().justify_center().rounded(6)
          .role("button").accessibility_label("Refresh AI usage")
          .text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_event, cx) => { this.refresh(cx, true); })
          .child(svg("mods/t3-usage/refresh.svg").size(13).when(this.loading, (el) => el.spin(900))))
        .child(div()
          .id("usage-hide")
          .size(26).flex_none().flex().items_center().justify_center().rounded(6)
          .role("button").accessibility_label("Hide AI usage (Ctrl+Shift+U shows it again)")
          .tooltip("Hide AI usage · Ctrl+Shift+U or the sidebar footer shows it again")
          .text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("layout.hide", { id: NODE }))
          .child(svg("mods/workspace-chrome/x.svg").size(13))))
      .child(this.providerCard(t, "claude", "Claude Code", claude))
      .child(this.providerCard(t, "openai", "OpenAI", openai));
  }
}
