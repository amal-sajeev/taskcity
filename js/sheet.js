export function mountSheet() {
  function isDesktop() {
    return window.matchMedia('(min-width: 900px)').matches;
  }
  const noopOff = () => {};
  return {
    snapTo() {},
    on() { return noopOff; },
    isDesktop,
    get snap() {
      return isDesktop() ? 'desktop' : 'fixed';
    }
  };
}
