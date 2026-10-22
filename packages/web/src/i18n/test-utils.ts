import { createElement, type ReactElement, type FunctionComponent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

export function renderHook<Result>(useHook: () => Result) {
  const result = { current: undefined as unknown as Result };

  const TestComponent: FunctionComponent = () => {
    result.current = useHook();
    return null as unknown as ReactElement;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(createElement(TestComponent));
  });

  return {
    result: result as { current: Result },
    rerender: () => {
      act(() => {
        root.render(createElement(TestComponent));
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}
