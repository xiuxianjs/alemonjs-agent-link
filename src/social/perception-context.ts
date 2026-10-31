export type ChatLine = {
  at: number;
  text: string;
  speaker: string;
  mentions?: { speaker: string; isSelf: boolean | null }[];
  messageId?: string;
  replyToId?: string | null;
};
export type PerceptionOptions = { maxMessages: number; windowSeconds: number; maxChars: number };
export const selectPerceptionContext = (
  recent: ChatLine[],
  lastBotReply: ChatLine | undefined,
  currentTexts: Set<string>,
  now: number,
  options: PerceptionOptions = { maxMessages: 40, windowSeconds: 1800, maxChars: 6000 }
): ChatLine[] => {
  const fresh = (item: ChatLine) => now - item.at < options.windowSeconds * 1000 && item.at <= now;
  const selected: ChatLine[] = [];
  let remaining = options.maxChars;
  const add = (item: ChatLine) => {
    if (!fresh(item) || remaining <= 0 || selected.length >= options.maxMessages || selected.includes(item)) return;
    const text = item.text.slice(0, Math.min(400, remaining));

    remaining -= text.length;
    selected.push({ ...item, text });
  };

  if (lastBotReply) add(lastBotReply);
  for (const item of [...recent].reverse()) {
    if (currentTexts.has(item.text) || selected.some(line => line.at === item.at && line.speaker === item.speaker)) continue;
    add(item);
  }

  return selected.sort((a, b) => a.at - b.at);
};
