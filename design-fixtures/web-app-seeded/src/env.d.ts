/**
 * Minimal ambient declarations so the seeded fixture type-checks offline,
 * without installing React or lucide-react. The real design_autofix pipeline
 * runs against a project whose dependencies are actually installed; this file
 * exists only to make the deterministic "build after the fix" acceptance test
 * hermetic.
 */
/** Minimal intrinsic-element map so JSX type-checks without @types/react. */
namespace JSX {
  interface Element {
    type: unknown;
    props: unknown;
    key: unknown;
  }
  interface IntrinsicElements {
    [elementName: string]: Record<string, unknown>;
  }
  interface ElementChildrenAttribute {
    children: Record<string, unknown>;
  }
}

declare module "react" {
  export type ReactNode = unknown;
  export type JSXElementConstructor<P> = (props: P) => unknown;
  export function useState<S>(initial: S | (() => S)): [S, (value: S | ((prev: S) => S)) => void];
  export function useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown;
  export const Fragment: unique symbol;
}

declare module "react/jsx-runtime" {
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown;
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown;
  export const Fragment: unique symbol;
}

declare module "react-dom/client" {
  export function createRoot(container: unknown, options?: unknown): { render(node: unknown): void };
}

declare module "lucide-react" {
  export const Search: (props: Record<string, unknown>) => JSX.Element;
  export const Menu: (props: Record<string, unknown>) => JSX.Element;
  export const ArrowRight: (props: Record<string, unknown>) => JSX.Element;
}
