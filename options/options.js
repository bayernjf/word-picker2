import { sendMessage, clampNumber } from "../lib/utils.js";
import { DEFAULT_SYNC_BASE_URL, SETTINGS_LIMITS } from "../lib/constants.js";

const form = document.getElementById("settings-form");
const statusNode = document.getElementById("status");
const syncStatusNode = document.getElementById("sync-status");
const syncNowButton = document.getElementById("sync-now");
const authLoginButton = document.getElementById("auth-login");
const authRegisterButton = document.getElementById("auth-register");
const authLogoutButton = document.getElementById("auth-logout");
const authLoggedOut = document.getElementById("auth-logged-out");
const authLoggedIn = document.getElementById("auth-logged-in");
const authUserInfo = document.getElementById("auth-user-info");

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  form.addEventListener("submit", handleSubmit);
  syncNowButton?.addEventListener("click", handleSyncNow);
  authLoginButton?.addEventListener("click", handleAuthLogin);
  authRegisterButton?.addEventListener("click", handleAuthRegister);
  authLogoutButton?.addEventListener("click", handleAuthLogout);
  await refreshAuthStatus();
  await refreshSyncStatus();
});

async function loadSettings() {
  try {
    const response = await sendMessage({ type: "GET_SETTINGS" });
    const settings = response.settings || {};
    form.lookupKey.value = settings.lookupKey || "Control";
    form.hoverDelay.value = settings.hoverDelay || 100;
    form.translator.value = settings.translator || "free";
    form.autoSpeak.checked = Boolean(settings.autoSpeak);
    form.maxCacheSize.value = settings.maxCacheSize || 200;
    form.syncEnabled.checked = settings.syncEnabled !== false;
    form.rememberDevice7Days.checked = Boolean(settings.rememberDevice7Days);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "加载设置失败");
  }
}

async function refreshAuthStatus() {
  try {
    const response = await sendMessage({ type: "AUTH_STATUS" });
    if (response.isLoggedIn && response.user) {
      authLoggedOut.style.display = "none";
      authLoggedIn.style.display = "block";
      authUserInfo.textContent = `邮箱: ${response.user.email || "-"}`;
    } else {
      authLoggedOut.style.display = "block";
      authLoggedIn.style.display = "none";
    }
  } catch (error) {
    console.warn("[WordCatcher] 获取登录状态失败：", error);
    authLoggedOut.style.display = "block";
    authLoggedIn.style.display = "none";
  }
}

async function handleAuthLogin() {
  const email = String(form.authEmail.value || "").trim().toLowerCase();
  const password = String(form.authPassword.value || "");
  const baseUrl = DEFAULT_SYNC_BASE_URL;
  if (!email || !password) {
    setStatus("请填写邮箱和密码");
    return;
  }
  try {
    setStatus("正在登录...");
    const response = await sendMessage({ type: "AUTH_LOGIN", email, password, baseUrl });
    if (response.ok) {
      setStatus("登录成功，开始同步...");
      await refreshAuthStatus();
      await refreshSyncStatus();
    } else {
      setStatus(`登录失败: ${response.error || "unknown"}`);
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "登录失败");
  }
}

async function handleAuthRegister() {
  const email = String(form.authEmail.value || "").trim().toLowerCase();
  const password = String(form.authPassword.value || "");
  const baseUrl = DEFAULT_SYNC_BASE_URL;
  if (!email || !password) {
    setStatus("请填写邮箱和密码");
    return;
  }
  if (password.length < 6) {
    setStatus("密码至少需要6个字符");
    return;
  }
  try {
    setStatus("正在注册...");
    const response = await sendMessage({ type: "AUTH_REGISTER", email, password, baseUrl });
    if (response.ok) {
      setStatus("注册成功，开始同步...");
      await refreshAuthStatus();
      await refreshSyncStatus();
    } else {
      setStatus(`注册失败: ${response.error || "unknown"}`);
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "注册失败");
  }
}

async function handleAuthLogout() {
  try {
    await sendMessage({ type: "AUTH_LOGOUT" });
    setStatus("已退出登录");
    await refreshAuthStatus();
    await refreshSyncStatus();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "退出失败");
  }
}

async function handleSubmit(event) {
  event.preventDefault();

  const payload = {
    lookupKey: form.lookupKey.value,
    hoverDelay: clampNumber(form.hoverDelay.value, SETTINGS_LIMITS.HOVER_DELAY_MIN, SETTINGS_LIMITS.HOVER_DELAY_MAX, SETTINGS_LIMITS.HOVER_DELAY_DEFAULT),
    translator: form.translator.value,
    autoSpeak: form.autoSpeak.checked,
    maxCacheSize: clampNumber(form.maxCacheSize.value, SETTINGS_LIMITS.CACHE_SIZE_MIN, SETTINGS_LIMITS.CACHE_SIZE_MAX, SETTINGS_LIMITS.CACHE_SIZE_DEFAULT),
    syncEnabled: form.syncEnabled.checked,
    rememberDevice7Days: form.rememberDevice7Days.checked,
    syncBaseUrl: String(form.syncBaseUrl?.value || "").trim() || DEFAULT_SYNC_BASE_URL
  };

  try {
    await sendMessage({
      type: "SAVE_SETTINGS",
      settings: payload
    });
    setStatus("设置已保存");
    await refreshSyncStatus();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "保存失败");
  }
}

async function handleSyncNow() {
  try {
    setStatus("正在同步...");
    const response = await sendMessage({ type: "SYNC_NOW" });
    const sync = response.sync || {};
    if (sync.ok) {
      setStatus(`同步完成：处理 ${sync.processed || 0} 条，队列剩余 ${sync.queueSize ?? 0} 条`);
    } else if (sync.skipped) {
      setStatus(`已跳过同步：队列 ${sync.queueSize ?? 0} 条`);
    } else {
      setStatus(`同步失败：${sync.error || sync.status || "unknown"}`);
    }
    await refreshSyncStatus();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "同步失败");
  }
}

async function refreshSyncStatus() {
  try {
    const response = await sendMessage({ type: "GET_SYNC_STATUS" });
    const deviceId = response.deviceId || "-";
    const queueSize = Number.isFinite(response.queueSize) ? response.queueSize : 0;
    const isLoggedIn = Boolean(response.isLoggedIn);
    const userEmail = response.user?.email || "-";
    const lastSyncAt = response.lastSyncAt ? new Date(response.lastSyncAt).toLocaleString() : "从未同步";
    if (syncStatusNode) {
      if (isLoggedIn) {
        syncStatusNode.textContent = `已登录：${userEmail} ｜ 同步队列：${queueSize} 条 ｜ 最后同步：${lastSyncAt}`;
      } else {
        syncStatusNode.textContent = `请先登录账号以启用同步 ｜ 同步队列：${queueSize} 条 ｜ 设备：${deviceId}`;
      }
    }
  } catch (error) {
    console.warn("[WordCatcher] 获取同步状态失败：", error);
    if (syncStatusNode) {
      syncStatusNode.textContent = "";
    }
  }
}

function setStatus(message) {
  statusNode.textContent = message;
}
