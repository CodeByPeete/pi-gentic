import { cardRuntime, liveCardKey } from "../../dist/ui/cards.js";

export function clearLiveCardDetails(details) {
  const keys = details ? [liveCardKey(details)] : [...cardRuntime.liveCards.keys()];

  for (const key of keys) {
    const entry = key ? cardRuntime.liveCards.get(key) : undefined;
    entry?.interruptExpiry?.();
    if (key) cardRuntime.liveCards.delete(key);
  }
}
