// Browser APIs Radix uses that jsdom lacks. Stubs only: layout, pointer capture and scrolling
// don't exist in jsdom, and the keyboard and state logic under test doesn't depend on them.
class ResizeObserverStub {
  observe(): void {
    // jsdom has no layout, so nothing ever resizes.
  }
  unobserve(): void {
    // Nothing observed.
  }
  disconnect(): void {
    // Nothing observed.
  }
}

const scope = globalThis as unknown as Record<string, unknown>;
scope.ResizeObserver ??= ResizeObserverStub;

const element = Element.prototype as unknown as Record<string, unknown>;
element.hasPointerCapture ??= () => false;
element.setPointerCapture ??= () => undefined;
element.releasePointerCapture ??= () => undefined;
element.scrollIntoView ??= () => undefined;
