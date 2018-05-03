/**
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// This file calls require('async_hooks') in the AsyncHooksCLS constructor,
// rather than upon module load.
import * as asyncHooksModule from 'async_hooks';
import {EventEmitter} from 'events';
import * as shimmer from 'shimmer';

import {CLS, Func} from './base';

type AsyncHooksModule = typeof asyncHooksModule;

// A list of well-known EventEmitter methods that add event listeners.
const EVENT_EMITTER_METHODS: Array<keyof EventEmitter> =
    ['addListener', 'on', 'once', 'prependListener', 'prependOnceListener'];
// A symbol used to check if a method has been wrapped for context.
const WRAPPED = Symbol('@google-cloud/trace-agent:AsyncHooksCLS:WRAPPED');

type ContextWrapped<T> = T&{[WRAPPED]?: boolean};
type Reference<T> = {
  value: T
};

/**
 * An implementation of continuation-local storage on top of the async_hooks
 * module.
 */
export class AsyncHooksCLS<Context extends {}> implements CLS<Context> {
  // instance-scope reference to avoid top-level require.
  private ah: AsyncHooksModule;

  /** A map of AsyncResource IDs to Context objects. */
  private contexts: {[id: number]: Reference<Context>} = {};
  /** The AsyncHook that proactively populates entries in this.contexts. */
  private hook: asyncHooksModule.AsyncHook;
  /** Whether this instance is enabled. */
  private enabled = false;

  constructor(private readonly defaultContext: Context) {
    // Store a reference to the async_hooks module, since we will need to query
    // the current AsyncResource ID often.
    this.ah = require('async_hooks') as AsyncHooksModule;

    // Create the hook.
    this.hook = this.ah.createHook({
      init: (id: number, type: string, triggerId: number, resource: {}) => {
        // init is called when a new AsyncResource is created. We want code
        // that runs within the scope of this new AsyncResource to see the same
        // context as its "parent" AsyncResource. The criteria for the parent
        // depends on the type of the AsyncResource.
        if (type === 'PROMISE') {
          // Opt not to use the trigger ID for Promises, as this causes context
          // confusion in applications using async/await.
          // Instead, use the ID of the AsyncResource in whose scope we are
          // currently running.
          this.contexts[id] = this.contexts[this.ah.executionAsyncId()];
        } else {
          // Use the trigger ID for any other type. In Node core, this is
          // usually equal the ID of the AsyncResource in whose scope we are
          // currently running (the "current" AsyncResource), or that of one
          // of its ancestors, so the behavior is not expected to be different
          // from using the ID of the current AsyncResource instead.
          // A divergence is expected only to arise through the user
          // AsyncResource API, because users of that API can specify their own
          // trigger ID. In this case, we choose to respect the user's
          // selection.
          this.contexts[id] = this.contexts[triggerId];
        }
        // Note that this function always assigns values in this.contexts to
        // values under other keys, which may or may not be undefined. Consumers
        // of the CLS API will get the sentinel (default) value if they query
        // the current context when it is stored as undefined.
      },
      destroy: (id: number) => {
        // destroy is called when the AsyncResource is no longer used, so also
        // delete its entry in the map.
        delete this.contexts[id];
      }
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  enable(): void {
    this.contexts = {};
    this.hook.enable();
    this.enabled = true;
  }

  disable(): void {
    this.contexts = {};
    this.hook.disable();
    this.enabled = false;
  }

  getContext(): Context {
    // We don't store this.defaultContext directly in this.contexts.
    // Getting undefined when looking up this.contexts means that it wasn't
    // set, so return the default context.
    const current = this.contexts[this.ah.executionAsyncId()];
    return current ? current.value : this.defaultContext;
  }

  setContext(value: Context): void {
    const id = this.ah.executionAsyncId();
    const current = this.contexts[id];
    if (current) {
      current.value = value;
    } else {
      this.contexts[id] = {value};
    }
  }

  runWithNewContext<T>(fn: Func<T>): T {
    // Run fn() so that any AsyncResource objects that are created in
    // fn will have the context set by this.setContext.
    const id = this.ah.executionAsyncId();
    const oldContext = this.contexts[id];
    // Reset the current context. This prevents this.getContext from returning
    // a stale value.
    this.contexts[id] = {value: this.defaultContext};
    try {
      return fn();
    } finally {
      // Revert the current context to what it was before any calls to
      // this.setContext from within fn.
      this.contexts[id] = oldContext;
    }
  }

  bindWithCurrentContext<T>(fn: Func<T>): Func<T> {
    // Return if we have already wrapped the function.
    if ((fn as ContextWrapped<Func<T>>)[WRAPPED]) {
      return fn;
    }
    // Capture the context of the current AsyncResource.
    const boundContext = this.contexts[this.ah.executionAsyncId()];
    // Return if there is no current context to bind.
    if (!boundContext) {
      return fn;
    }
    const that = this;
    // TODO(kjin): This code is somewhat duplicated with runWithNewContext.
    //             Can we merge this?
    // Wrap fn so that any AsyncResource objects that are created in fn will
    // share context with that of the AsyncResource with the given ID.
    const contextWrapper: ContextWrapped<Func<T>> = function(this: {}) {
      const id = that.ah.executionAsyncId();
      const oldContext = that.contexts[id];
      // Restore the captured context.
      that.contexts[id] = boundContext;
      try {
        return fn.apply(this, arguments) as T;
      } finally {
        // Revert the current context to what it was before it was set to the
        // captured context.
        that.contexts[id] = oldContext;
      }
    };
    // Prevent re-wrapping.
    contextWrapper[WRAPPED] = true;
    // Explicitly inherit the original function's length, because it is
    // otherwise zero-ed out.
    Object.defineProperty(contextWrapper, 'length', {
      enumerable: false,
      configurable: true,
      writable: false,
      value: fn.length
    });
    return contextWrapper;
  }

  patchEmitterToPropagateContext(ee: EventEmitter): void {
    const that = this;
    EVENT_EMITTER_METHODS.forEach((method) => {
      if (ee[method]) {
        shimmer.wrap(ee, method, (oldMethod) => {
          return function(this: {}, event: string, cb: Func<void>) {
            return oldMethod.call(this, event, that.bindWithCurrentContext(cb));
          };
        });
      }
    });
  }
}
