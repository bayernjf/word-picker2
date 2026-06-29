import { sendMessage, clampNumber } from "../lib/utils.js";
import { DEFAULT_SYNC_BASE_URL, SETTINGS_LIMITS, WORD_BASE_APP_URL } from "../lib/constants.js";
import { createLogger } from "../lib/logger.js";
import type { Settings } from "../lib/storage.js";

const logger = createLogger("options");

const form = document.getElementById("settings-form") as HTMLFormElement;
const statusNode = document.getElementById("status") as HTMLDivElement;
const syncStatusNode = document.getElementById("sync-status") as HTMLDivElement | null;
const syncNowButton = document.getElementById("sync-now") as HTMLButtonElement | null;
const authLoginButton = document.getElementById("auth-login") as HTMLButtonElement | null;
const authRegisterButton = document.getElementById("auth-register") as HTMLButtonElement | null;
const authLogoutButton = document.getElementById("auth-logout") as HTMLButtonElement | null;
const authLoggedOut = document.getElementById("auth-logged-out") as HTMLDivElement;
const authLoggedIn = document.getElementById("auth-logged-in") as HTMLDivElement;
const authUserInfo = document.getElementById("auth-user-info") as HTMLDivElement;
const rememberDeviceCheckbox = document.getElementById("rememberDevice7Days") as HTMLInputElement | null;

interface SettingsFormElements extends HTMLFormElement {
  lookupKey: HTMLSelectElement;
  hoverDelay: HTMLInputElement;
  translator: HTMLSelectElement;
  useYoudaoDict: HTMLInputElement;
  autoSpeak: HTMLInputElement;
  fireworksEffect: HTMLSelectElement;
  maxCacheSize: HTMLInputElement;
  syncEnabled: HTMLInputElement;
  rememberDevice7Days: HTMLInputElement;
  syncBaseUrl?: HTMLInputElement;
  authEmail: HTMLInputElement;
  authPassword: HTMLInputElement;
}

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

async function loadSettings(): Promise<void> {
  try {
    const response = await sendMessage({ type: "GET_SETTINGS" });
    const settings: Partial<Settings> = response.settings || {};
    (form as SettingsFormElements).lookupKey.value = settings.lookupKey || "Control";
    (form as SettingsFormElements).hoverDelay.value = String(settings.hoverDelay || 100);
    (form as SettingsFormElements).translator.value = settings.translator || "free";
    (form as SettingsFormElements).useYoudaoDict.checked = settings.useYoudaoDict !== false;
    (form as SettingsFormElements).autoSpeak.checked = Boolean(settings.autoSpeak);
    (form as SettingsFormElements).fireworksEffect.value = settings.fireworksEffect || "css";
    (form as SettingsFormElements).maxCacheSize.value = String(settings.maxCacheSize || 200);
    (form as SettingsFormElements).syncEnabled.checked = settings.syncEnabled !== false;
    (form as SettingsFormElements).rememberDevice7Days.checked = Boolean(settings.rememberDevice7Days);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "加载设置失败");
  }
}

async function refreshAuthStatus(): Promise<void> {
  try {
    const response = await sendMessage({ type: "AUTH_STATUS" }) as unknown as { isLoggedIn: boolean; user?: { email?: string } };
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
async function fillRememberedCredentials(): Promise<void> {
  try {
    const response = await sendMessage({ type: "AUTH_GET_CREDENTIALS" }) as unknown as { ok: boolean; email: string; password: string };
    if (response?.email && !(form as SettingsFormElements).authEmail.value) {
      (form as SettingsFormElements).authEmail.value = response.email;
    }
    if (response?.password && !(form as SettingsFormElements).authPassword.value) {
      (form as SettingsFormElements).authPassword.value = response.password;
    }
  } catch (error) {
    logger.warn("回填登录凭证失败：", error);
  }
}

async function handleAuthLogin(): Promise<void> {
  const email = String((form as SettingsFormElements).authEmail.value || "").trim().toLowerCase();
  const password = String((form as SettingsFormElements).authPassword.value || "");
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

async function handleAuthRegister(): Promise<void> {
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

async function handleAuthLogout(): Promise<void> {
  try {
    await sendMessage({ type: "AUTH_LOGOUT" });
    setStatus("已退出登录");
    await refreshAuthStatus();
    await refreshSyncStatus();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "退出失败");
  }
}

async function handleRememberDeviceChange(): Promise<void> {
  const remember = rememberDeviceCheckbox!.checked;
  try {
    // 即时保存勾选状态（合并到现有设置，避免覆盖其他字段）
    const response = await sendMessage({ type: "GET_SETTINGS" });
    const current = response.settings || {};
    await sendMessage({
      type: "SAVE_SETTINGS",
      settings: { ...current, rememberDevice7Days: remember },
    });
    // 同步更新已登录态的过期时间
    await sendMessage({ type: "AUTH_SET_REMEMBER", remember });
    setStatus(remember ? "已开启在此设备记住7天" : "已关闭在此设备记住7天");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "保存失败");
  }
}

async function handleSubmit(event: Event): Promise<void> {
  event.preventDefault();

  const payload = {
    lookupKey: (form as SettingsFormElements).lookupKey.value,
    hoverDelay: clampNumber((form as SettingsFormElements).hoverDelay.value, SETTINGS_LIMITS.HOVER_DELAY_MIN, SETTINGS_LIMITS.HOVER_DELAY_MAX, SETTINGS_LIMITS.HOVER_DELAY_DEFAULT),
    translator: (form as SettingsFormElements).translator.value,
    useYoudaoDict: (form as SettingsFormElements).useYoudaoDict.checked,
    autoSpeak: (form as SettingsFormElements).autoSpeak.checked,
    fireworksEffect: (form as SettingsFormElements).fireworksEffect.value as "canvas" | "css" | "none",
    maxCacheSize: clampNumber((form as SettingsFormElements).maxCacheSize.value, SETTINGS_LIMITS.CACHE_SIZE_MIN, SETTINGS_LIMITS.CACHE_SIZE_MAX, SETTINGS_LIMITS.CACHE_SIZE_DEFAULT),
    syncEnabled: (form as SettingsFormElements).syncEnabled.checked,
    rememberDevice7Days: (form as SettingsFormElements).rememberDevice7Days.checked,
    syncBaseUrl: String((form as SettingsFormElements).syncBaseUrl?.value || "").trim() || DEFAULT_SYNC_BASE_URL,
  };

  try {
    await sendMessage({
      type: "SAVE_SETTINGS",
      settings: payload,
    });
    setStatus("设置已保存");
    await refreshSyncStatus();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "保存失败");
  }
}

async function handleSyncNow(): Promise<void> {
  try {
    setStatus("正在同步...");
    logger.debug('handleSyncNow');
    const response = (await sendMessage({ type: "SYNC_NOW" })) as unknown as {
      sync: {
        ok: boolean;
        processed?: number;
        queueSize?: number;
        skipped?: boolean;
        error?: string;
        status?: string;
      };
    };
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

async function refreshSyncStatus(): Promise<void> {
  try {
    const response = await sendMessage<{
      success: boolean;
      deviceId?: string;
      queueSize?: number;
      isLoggedIn: boolean;
      user?: { email?: string };
      lastSyncAt?: number;
    }>({ type: "GET_SYNC_STATUS" });
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

function setStatus(message: string): void {
  statusNode.textContent = message;
}
