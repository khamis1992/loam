export function reserve(slots: readonly string[], slot: string): string[] {
  if (!slot || slot.length > 64) throw new Error('invalid_slot');
  if (slots.includes(slot)) throw new Error('slot_taken');
  return [...slots, slot];
}

export function cartTotal(prices: readonly number[]): number {
  if (prices.some((price) => !Number.isSafeInteger(price) || price < 0)) throw new Error('invalid_price');
  const sum = prices.reduce((total, price) => total + price, 0);
  if (!Number.isSafeInteger(sum)) throw new Error('invalid_total');
  return sum;
}

export function demoReply(text: string): string {
  if (!text.trim()) throw new Error('empty_message');
  return 'هذه محادثة تجريبية؛ لم يُرسل طلب أو يُنفذ حجز خارج هذا الجهاز.';
}
