import { sendMessage, clampNumber } from "../lib/utils.js";
import { DEFAULT_SYNC_BASE_URL, SETTINGS_LIMITS, WORD_BASE_APP_URL } from "../lib/constants.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("options");

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
const rememberDeviceCheckbox = document.getElementById("rememberDevice7Days");

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  form.addEventListener("submit", handleSubmit);
  syncNowButton?.addEventListener("click", handleSyncNow);
  authLoginButton?.addEventListener("click", handleAuthLogin);
  authRegisterButton?.addEventListener("click", handleAuthRegister);
  authLogoutButton?.addEventListener("click", handleAuthLogout);
  rememberDeviceCheckbox?.addEventListener("change", handleRememberDeviceChange);
  await refreshAuthStatus();
  await refreshSyncStatus();

  // 监听后台登录态变化（如 token 失效被清空），实时刷新页面显示
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes.authData) {
        void refreshAuthStatus();
        void refreshSyncStatus();
      }
    });
  }
});

async function loadSettings() {
  try {
    const response = await sendMessage({ type: "GET_SETTINGS" });
    const settings = response.settings || {};
    form.lookupKey.value = settings.lookupKey || "Control";
    form.hoverDelay.value = settings.hoverDelay || 100;
    form.translator.value = settings.translator || "free";
    form.useYoudaoDict.checked = settings.useYoudaoDict !== false;
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
      await fillRememberedCredentials();
    }
  } catch (error) {
    logger.warn("获取登录状态失败：", error);
    authLoggedOut.style.display = "block";
    authLoggedIn.style.display = "none";
    await fillRememberedCredentials();
  }
}

// 回填已记住的登录凭证：7天内回填邮箱+密码，超过7天只回填邮箱
async function fillRememberedCredentials() {
  try {
    const response = await sendMessage({ type: "AUTH_GET_CREDENTIALS" });
    if (response?.email && !form.authEmail.value) {
      form.authEmail.value = response.email;
    }
    if (response?.password && !form.authPassword.value) {
      form.authPassword.value = response.password;
    }
  } catch (error) {
    logger.warn("回填登录凭证失败：", error);
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
  logger.debug('handleAuthLogin', { email });
  try {
    setStatus("正在登录...");
    const response = await sendMessage({ type: "AUTH_LOGIN", email, password, baseUrl });
    if (response.ok) {
      logger.info('handleAuthLogin success');
      setStatus("登录成功，开始同步...");
      await refreshAuthStatus();
      await refreshSyncStatus();
    } else {
      logger.warn('handleAuthLogin failed', { error: response.error });
      setStatus(`登录失败: ${response.error || "unknown"}`);
    }
  } catch (error) {
    logger.error('handleAuthLogin error', error);
    setStatus(error instanceof Error ? error.message : "登录失败");
  }
}

async function handleAuthRegister() {
  // 在新标签页打开 word-base 的注册页面（带参数强制显示注册表单）
  const registerUrl = `${WORD_BASE_APP_URL.replace(/\/+$/, "")}/?auth=register`;
  try {
    if (chrome?.tabs?.create) {
      await chrome.tabs.create({ url: registerUrl });
    } else {
      window.open(registerUrl, "_blank");
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "打开注册页面失败");
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

async function handleRememberDeviceChange() {
  const remember = rememberDeviceCheckbox.checked;
  try {
    // 即时保存勾选状态（合并到现有设置，避免覆盖其他字段）
    const response = await sendMessage({ type: "GET_SETTINGS" });
    const current = response.settings || {};
    await sendMessage({
      type: "SAVE_SETTINGS",
      settings: { ...current, rememberDevice7Days: remember }
    });
    // 同步更新已登录态的过期时间
    await sendMessage({ type: "AUTH_SET_REMEMBER", remember });
    setStatus(remember ? "已开启在此设备记住7天" : "已关闭在此设备记住7天");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "保存失败");
  }
}

async function handleSubmit(event) {
  event.preventDefault();

  const payload = {
    lookupKey: form.lookupKey.value,
    hoverDelay: clampNumber(form.hoverDelay.value, SETTINGS_LIMITS.HOVER_DELAY_MIN, SETTINGS_LIMITS.HOVER_DELAY_MAX, SETTINGS_LIMITS.HOVER_DELAY_DEFAULT),
    translator: form.translator.value,
    useYoudaoDict: form.useYoudaoDict.checked,
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
    logger.debug('handleSyncNow');
    const response = await sendMessage({ type: "SYNC_NOW" });
    const sync = response.sync || {};
    if (sync.ok) {
      logger.info('handleSyncNow success', { processed: sync.processed, queueSize: sync.queueSize });
      setStatus(`同步完成：处理 ${sync.processed || 0} 条，队列剩余 ${sync.queueSize ?? 0} 条`);
    } else if (sync.skipped) {
      logger.debug('handleSyncNow skipped', { reason: sync.error, queueSize: sync.queueSize });
      setStatus(`已跳过同步：队列 ${sync.queueSize ?? 0} 条`);
    } else {
      logger.warn('handleSyncNow failed', { error: sync.error });
      setStatus(`同步失败：${sync.error || sync.status || "unknown"}`);
    }
    await refreshSyncStatus();
  } catch (error) {
    logger.error('handleSyncNow error', error);
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
    logger.warn("获取同步状态失败：", error);
    if (syncStatusNode) {
      syncStatusNode.textContent = "";
    }
  }
}

function setStatus(message) {
  statusNode.textContent = message;
}
