import '@testing-library/jest-dom';

// jsdom on some Node builds exposes a broken localStorage (methods are not functions).
// Provide a tiny in-memory Storage so components that read settings do not throw in tests.
if (typeof window !== 'undefined' && typeof window.localStorage?.getItem !== 'function') {
  const store = new Map<string, string>();
  const memory: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => { store.delete(key); },
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: memory });
}
