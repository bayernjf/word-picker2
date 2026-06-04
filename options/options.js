const form = document.getElementById("settings-form");
const statusNode = document.getElementById("status");
const syncStatusNode = document.getElementById("sync-status");
const syncNowButton = document.getElementById("sync-now");

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  form.addEventListener("submit", handleSubmit);
  syncNowButton?.addEventListener("click", handleSyncNow);
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
    form.syncBaseUrl.value = settings.syncBaseUrl || "http://localhost:3001";
    form.pairingCode.value = settings.pairingCode || "";
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "加载设置失败");
  }
}

async function handleSubmit(event) {
  event.preventDefault();

  const payload = {
    lookupKey: form.lookupKey.value,
    hoverDelay: clampNumber(form.hoverDelay.value, 100, 1500, 100),
    translator: form.translator.value,
    autoSpeak: form.autoSpeak.checked,
    maxCacheSize: clampNumber(form.maxCacheSize.value, 50, 500, 200),
    syncEnabled: form.syncEnabled.checked,
    syncBaseUrl: String(form.syncBaseUrl.value || "").trim() || "http://localhost:3001",
    pairingCode: String(form.pairingCode.value || "").trim().toUpperCase()
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
    const hasToken = Boolean(response.hasToken);
    const hasPairingCode = Boolean(response.hasPairingCode);
    if (syncStatusNode) {
      syncStatusNode.textContent = `设备：${deviceId} ｜ 同步队列：${queueSize} 条 ｜ 已绑定：${hasToken ? "是" : "否"} ｜ 已填写配对码：${hasPairingCode ? "是" : "否"}`;
    }
  } catch {
    if (syncStatusNode) {
      syncStatusNode.textContent = "";
    }
  }
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function setStatus(message) {
  statusNode.textContent = message;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.success) {
        reject(new Error(response?.error || "扩展消息请求失败"));
        return;
      }
      resolve(response);
    });
  });
}
