/**
 * Mood Skin Store - 监听 AI 消息流，解析 %%skin:xxx%% 标记，切换 CSS 情绪皮肤。
 */
const SKIN_PATTERN = /%%skin:(\w+)%%/;
const VALID_SKINS = new Set(['rage', 'desire', 'vuoto', 'moonlight', 'serenity']);

export function extractSkinTag(text: string): { text: string; skin: string | null } {
  const match = text.match(SKIN_PATTERN);
  if (!match) return { text, skin: null };
  const skin = match[1].toLowerCase();
  if (!VALID_SKINS.has(skin)) return { text, skin: null };
  return {
    text: text.replace(SKIN_PATTERN, '').trim(),
    skin,
  };
}

export function applyMoodSkin(skin: string): void {
  if (!VALID_SKINS.has(skin)) return;
  document.body.dataset.moodSkin = skin;
}

export function clearMoodSkin(): void {
  delete document.body.dataset.moodSkin;
}

export function getCurrentMoodSkin(): string | null {
  return document.body.dataset.moodSkin ?? null;
}

export function initMoodSkinObserver(): void {
  const observer = new MutationObserver(() => {
    const bubbles = document.querySelectorAll(
      '[data-role="assistant"], .chat-bubble-assistant, [class*="assistant"]'
    );
    bubbles.forEach((bubble) => {
      if (bubble instanceof HTMLElement && !bubble.dataset.moodParsed) {
        bubble.dataset.moodParsed = '1';
        const { skin } = extractSkinTag(bubble.textContent || '');
        if (skin) {
          applyMoodSkin(skin);
          bubble.textContent = extractSkinTag(bubble.textContent || '').text;
        }
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
