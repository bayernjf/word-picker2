const form = document.getElementById("settings-form");
const statusNode = document.getElementById("status");

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  form.addEventListener("submit", handleSubmit);
});

async function loadSettings() {
  try {
    const response = await sendMessage({ type: "GET_SETTINGS" });
    const settings = response.settings || {};
    form.lookupKey.value = settings.lookupKey || "Control";
    form.hoverDelay.value = settings.hoverDelay || 300;
    form.translator.value = settings.translator || "free";
    form.autoSpeak.checked = Boolean(settings.autoSpeak);
    form.maxCacheSize.value = settings.maxCacheSize || 200;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "加载设置失败");
  }
}

async function handleSubmit(event) {
  event.preventDefault();

  const payload = {
    lookupKey: form.lookupKey.value,
    hoverDelay: clampNumber(form.hoverDelay.value, 100, 1500, 300),
    translator: form.translator.value,
    autoSpeak: form.autoSpeak.checked,
    maxCacheSize: clampNumber(form.maxCacheSize.value, 50, 500, 200)
  };

  try {
    await sendMessage({
      type: "SAVE_SETTINGS",
      settings: payload
    });
    setStatus("设置已保存");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "保存失败");
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
