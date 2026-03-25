/*!
 * Vite entry point — wraps js/main.js with jQuery global setup.
 * jQuery must be on window.$ / window.jQuery BEFORE bootstrap and
 * solstice-assets initialise, so we use top-level await + dynamic import
 * to guarantee execution order (static imports are hoisted).
 *
 */

// Patch addEventListener BEFORE loading any library code so that
// DOMContentLoaded listeners registered by eclipsefdn-solstice-assets
// fire immediately when the DOM is already ready (which it is, because
// <script type="module"> defers execution past DOMContentLoaded).
const _origAdd = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function (
  this: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
) {
  if (
    type === 'DOMContentLoaded' &&
    this === document &&
    document.readyState !== 'loading'
  ) {
    // DOM already ready — call the listener on the next microtask so the
    // calling module finishes evaluating first.
    const fn =
      typeof listener === 'function' ? listener : listener.handleEvent.bind(listener);
    queueMicrotask(() => fn(new Event('DOMContentLoaded')));
    return;
  }
  return _origAdd.call(this, type, listener, options);
};

import jQuery from 'jquery';
(globalThis as unknown as Record<string, unknown>).$ = jQuery;
(globalThis as unknown as Record<string, unknown>).jQuery = jQuery;

await import('eclipsefdn-solstice-assets/js/astro');

// Restore original addEventListener
EventTarget.prototype.addEventListener = _origAdd;

// Signal that jQuery + all plugins are ready for inline scripts
document.dispatchEvent(new Event('vite:ready'));
