export function getAmbientDisplayLines(rawText: string): string[] {
  const messageBlock = extractAmbientMessageBlock(rawText);
  if (!messageBlock) return [];

  return messageBlock
    .split("\n")
    .map((line) => cleanAmbientLineForDisplay(line))
    .filter((line) => line.length > 0);
}

export function cleanAmbientLineForDisplay(line: string): string {
  return line
    .replace(/\s+\[Reply target:[^\]]+\]/g, "")
    .replace(/^([^:\n]+?)\s+\([A-Z0-9._-]+\)(?=:)/, "$1")
    .trim();
}

function extractAmbientMessageBlock(rawText: string): string {
  const tagged = rawText.match(/<ambient_messages>\s*([\s\S]*?)\s*<\/ambient_messages>/);
  if (tagged?.[1]) return tagged[1].trim();

  const ambientText = rawText.replace(/^\[AMBIENT\]\s*/, "").trim();
  const patterns = [
    /New unseen(?:, complete)? messages since your last ambient wake:\s*\n\n([\s\S]*?)(?:\n\nChannel pulse:|\n\nYou're observing|$)/,
    /Recent messages:\s*\n\n([\s\S]*?)(?:\n\nChannel pulse:|\n\nYou're observing|$)/,
  ];

  for (const pattern of patterns) {
    const match = ambientText.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  return "";
}
