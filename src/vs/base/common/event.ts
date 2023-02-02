import { CancellationToken } from "./cancellation";
import {
  combinedDisposable,
  Disposable,
  DisposableStore,
  dispose,
  IDisposable,
  SafeDisposable,
  toDisposable
} from "./lifecycle";
import { LinkedList } from "./linkedList";
import {IObservable, IObserver} from "./observableImpl/base";
import { StopWatch } from "./stopwatch";
import { MicrotaskDelay } from "./symbols";
import IChainableEvent = Event.IChainableEvent;


const _enableDisposeWithListenerWarning = false

const _enableSnapshotPotentialLeakingWarning = false


export interface Event<T> {
  (listener: (e: T) => any, thisArgs?: any, disposables?: IDisposable[] | DisposableStore): IDisposable
}

let _globalLeakWarningThreshold = -1
export function setGlobalLeakWarningThreshold(n: number) {
  const oldValue = _globalLeakWarningThreshold
  _globalLeakWarningThreshold = n
  return {
    dispose() {
      _globalLeakWarningThreshold = oldValue
    }
  }
}
export namespace Event {
  export const None: Event<any> = () => Disposable.None
  function _addLeakageTraceLogic(options: EmitterOptions) {
    if (_enableSnapshotPotentialLeakingWarning) {
      const { onDidAddListener: originListenerDidAdd } = options
      const stack = Stacktrace.create()
      let count = 0
      options.onDidAddListener = function () {
        if (++count === 2) {
          console.warn('snapshotted emitter LIKELY used public and SHOULD HAVE BEEN created with DisposableStore. snapshotted here');
          stack.print();
        }
        originListenerDidAdd?.()
      }
    }
  }

  /**
   * Given an event, returns another event which debounce calls and defers the listeners to a later task via a shared
   * `setTimeout`. The event is converted into a signal (`Event<void>`) to avoid additional object creation as a
   * result of merging events and to try to prevent race conditions that could arise when using related deferred and
   * non-deferred events.
   *
   * This is useful for deferring non-critical work (eg. general UI updates) to ensure it does not block critical work
   * (e.g. latency of keypress to text rendered).
   *
   * *NOTE* that this function returns an `Event` and it MUST be called with a `DisposableStore` whenever the returned
   * event is accessible to "third parties", e.g. the event is a public property. Otherwise, a leaked listener on the
   * returned event causes this utility to leak a listener on the original event.
   *
   * @param event The event source for the new event.
   * @param disposable A disposable store to add the new EventEmitter to.
   */
  export function defer(event: Event<unknown>, disposable?: DisposableStore) {
    return debounce<unknown, void>(event, () => void 0, 0, undefined, undefined, disposable)
  }


  /**
   * Given an event, returns another event which is only fired once.
   * @param event The event source for the new event.
   */
  export function once<T>(event: Event<T>): Event<T> {
    return (listener, thisArgs = null, disposables?) => {
      // we need this, in case the event fires during the listener call
      let didFire = false
      let result: IDisposable
      result = event(e => {
        if (didFire) {
          return
        } else if (result) {
          result.dispose()
        } else {
          didFire = true
        }
        return listener.call(thisArgs, e)
      }, null, disposables)

      if (didFire) {
        result.dispose()
      }
      return result
    }
  }

  /**
   * Maps an event of one type into an event of another type using a mapping function, similar to how
   * `Array.prototype.map` works.
   *
   * *NOTE* that this function returns an `Event` and it MUST be called with a `DisposableStore` whenever the returned
   * event is accessible to "third parties", e.g the event is a public property. Otherwise a leaked listener on the
   * returned event causes this utility to leak a listener on the original event.
   *
   * @param event The event source for the new event.
   * @param map The mapping function.
   * @param disposable A disposable store to add the new EventEmitter to.
   */
  export function map<I, O>(event: Event<I>, map: (i: I) => O, disposable?: DisposableStore): Event<O> {
    return snapshot(
      (listener, thisArgs = null, disposables) =>
        event(i => listener.call(thisArgs, map(i)), null, disposables),
      disposable
    )
  }

  export function forEach<I>(event: Event<I>, callback: (e: I) => void, disposable?: DisposableStore): Event<I> {
    return snapshot(
      (listener, thisArgs = null, disposables) =>
        event(e => { callback(e); listener.call(thisArgs, e) }, null, disposables),
      disposable)
  }

  export function filter<T, U>(event: Event<T | U>, filter: (e: T | U) => e is T, disposable?: DisposableStore): Event<T>;

  export function filter<T>(event: Event<T>, filter: (e: T) => boolean, disposable?: DisposableStore): Event<T>;
  export function filter<T, U>(event: Event<T | U>, filter: (e: T | U) => e is U, disposable?: DisposableStore): Event<U>;
  export function filter<T>(event: Event<T>, filter: (e: T) => boolean, disposable?: DisposableStore): Event<T> {
    return snapshot(
      (listener, thisArgs = null, disposables) =>
        event(e => filter(e) && listener.call(thisArgs, e), null, disposables),
      disposable
    )
  }

  /**
   * Given an event, returns the same event but typed as `Event<void>`.
   */
  export function signal<T>(event: Event<T>) {
    return event as Event<any> as Event<void>
  }


  export function any<T>(...events: Event<T>[]): Event<T>
  export function any(...events: Event<any>[]): Event<void>
  export function any<T>(...events: Event<T>[]): Event<T> {
    return (listener, thisArgs = null, disposables?) =>
      combinedDisposable(...events.map(event => event(e => listener.call(thisArgs, e), null, disposables)))
  }

  export function reduce<I, U>(event: Event<I>, merge: (last: U | undefined, event: I) => U, initial?: U, disposable?: DisposableStore): Event<U> {
    let output: U | undefined = initial
    return map<I, U>(event, e => {
      output = merge(output, e)
      return output
    }, disposable)
  }



  function snapshot<T>(event: Event<T>, disposable?: DisposableStore) {
    let listener: IDisposable | undefined
    const options: EmitterOptions | undefined = {
      onWillAddFirstListener() {
        listener = event(e => emitter.fire(e))
      },
      onDidRemoveLastListener() {
        listener?.dispose()
      }
    }
    if (!disposable) {
      _addLeakageTraceLogic(options)
    }
    const emitter = new Emitter<T>(options)
    disposable?.add(emitter)
    return emitter.event
  }

  /**
   * *NOTE* that this function returns an `Event` and it MUST be called with a `DisposableStore` whenever the returned
   * event is accessible to "third parties", e.g. the event is a public property. Otherwise, a leaked listener on the
   * returned event causes this utility to leak a listener on the original event.
   */
  export function debounce<T>(event: Event<T>, merge: (last: T | undefined, event: T) => T, delay?: number | typeof MicrotaskDelay, leading?: boolean, leakWarningThreshold?: number, disposable?: DisposableStore): Event<T>;
  /**
   * *NOTE* that this function returns an `Event` and it MUST be called with a `DisposableStore` whenever the returned
   * event is accessible to "third parties", e.g. the event is a public property. Otherwise, a leaked listener on the
   * returned event causes this utility to leak a listener on the original event.
   */
  export function debounce<I, O>(event: Event<I>, merge: (last: O | undefined, event: I) => O, delay?: number | typeof MicrotaskDelay, leading?: boolean, leakWarningThreshold?: number, disposable?: DisposableStore): Event<O>;

  export function debounce<I, O>(event: Event<I>, merge: (last: O | undefined, event: I) => O, delay?: number | typeof MicrotaskDelay, leading = false, leakWarningThreshold?: number, disposable?: DisposableStore): Event<O> {
    let subscription: IDisposable
    let output: O | undefined = undefined
    let handle: any = undefined
    let numDebouncedCalls = 0
    const options: EmitterOptions | undefined = {
      leakWarningThreshold,
      onWillAddFirstListener() {
        subscription = event(cur => {
          numDebouncedCalls++
          output = merge(output, cur)
          if (leading && !handle) {
            emitter.fire(output)
            output = undefined
          }
          const doFire = () => {
            const _output = output
            output = undefined
            handle = undefined
            if (!leading || numDebouncedCalls > 1) {
              emitter.fire(_output!)
            }
            numDebouncedCalls = 0
          }
          if (typeof delay === 'number') {
            clearTimeout(handle)
            handle = setTimeout(doFire, delay)
          } else {
            if (handle === undefined) {
              handle = 0
              queueMicrotask(doFire)
            }
          }
        }, undefined, disposable)
      },
      onDidRemoveLastListener() {
        subscription.dispose()
      }
    }
    const emitter = new Emitter<O>(options)

    if (!disposable) {
      _addLeakageTraceLogic(options)
    }

    disposable?.add(emitter)

    return emitter.event
  }

  /**
   * Debounce an event, firing after some delay (default=0) with an array of all event original objects.
   *
   * *NOTE* that this function returns an `Event` and it MUST be called with a `DisposableStore` whenever the returned
   * event is accessible to "third parties", e.g. the event is a public property. Otherwise, a leaked listener on the
   * returned event causes this utility to leak a listener on the original event.
   */
  export function accumulate<T>(event: Event<T>, delay: number = 0, disposable?: DisposableStore) {
    return Event.debounce<T, T[]>(event, (last, e) => {
      if (!last) {
        return [e]
      }
      last.push(e)
      return last
    }, delay, undefined, undefined, disposable)
  }

  export function latch<T>(event: Event<T>, equals: (a: T, b: T) => boolean = (a, b) => a === b, disposable?: DisposableStore): Event<T> {
    let firstCall = true
    let cache: T
    return filter(event, e => {
      const shouldEmit = firstCall
      firstCall = false
      cache = e
      return shouldEmit
    }, disposable)
  }

  /**
   * Splits an event whose parameter is a union type into 2 separate events for each type in the union.
   *
   * *NOTE* that this function returns an `Event` and it MUST be called with a `DisposableStore` whenever the returned
   * event is accessible to "third parties", e.g. the event is a public property. Otherwise, a leaked listener on the
   * returned event causes this utility to leak a listener on the original event.
   *
   * @example
   * ```
   * const event = new EventEmitter<number | undefined>().event;
   * const [numberEvent, undefinedEvent] = Event.split(event, isUndefined);
   * ```
   *
   * @param event The event source for the new event.
   * @param isT A function that determines what event is of the first type.
   * @param disposable A disposable store to add the new EventEmitter to.
   */
  export function split<T, U>(event: Event<T | U>, isT: (e: T | U) => e is T, disposable?: DisposableStore): [Event<T>, Event<U>] {
    return [
      Event.filter(event, isT, disposable),
      Event.filter(event, e => !isT(e), disposable) as Event<U>
    ]
  }

  /**
   * *NOTE* that this function returns an `Event` and it MUST be called with a `DisposableStore` whenever the returned
   * event is accessible to "third parties", e.g. the event is a public property. Otherwise, a leaked listener on the
   * returned event causes this utility to leak a listener on the original event.
   */
  export function buffer<T>(event: Event<T>, flushAfterTimeout = false, _buffer: T[] = []) {
    let buffer: T[] | null = _buffer.slice()

    let listener: IDisposable | null = event(e => {
      if (buffer) {
        buffer.push(e)
      } else {
        emitter.fire(e)
      }
    })


    const flush = () => {
      buffer?.forEach(e => emitter.fire(e))
      buffer = null
    }

    const emitter = new Emitter<T>({
      onWillAddFirstListener() {
        if (!listener) {
          listener = event(e => emitter.fire(e))
        }
      },
      onDidAddFirstListener() {
        if (buffer) {
          if (flushAfterTimeout) {
            setTimeout(flush)
          } else {
            flush()
          }
        }
      },
      onDidRemoveLastListener() {
        if (listener) {
          listener.dispose()
        }
        listener = null
      }
    })
    return emitter.event
  }

  export interface IChainableEvent<T> extends IDisposable {
    event: Event<T>
    map<O>(fn: (i: T) => O): IChainableEvent<O>
    forEach(fn: (i: T) => void): IChainableEvent<T>
    filter(fn: (i: T) => boolean): IChainableEvent<T>
    filter<R>(fn: (e: T | R) => e is R): IChainableEvent<R>
    reduce<R>(merge: (last: R | undefined, event: T) => R, initial?: R): IChainableEvent<R>
    debounce(merge: (last: T | undefined, event: T) => T, delay?: number, leading?: boolean, leakWarningThreshold?: number): IChainableEvent<T>
    debounce<R>(merge: (last: R | undefined, event: T) => R, delay?: number, leading?: boolean, leakWarningThreshold?: number): IChainableEvent<R>
    latch(): IChainableEvent<T>
    on(listener: (e: T) => any, thisArgs?: any, disposables?: IDisposable[] | DisposableStore): IDisposable
    once(listener: (e: T) => any, thisArgs?: any, disposables?: IDisposable[]): IDisposable
  }

  class ChainableEvent<T> implements IChainableEvent<T> {
    private readonly disposables = new DisposableStore()
    constructor(readonly event: Event<T>) { }

    map<O>(fn: (i: T) => O): IChainableEvent<O> {
      return new ChainableEvent(map(this.event, fn, this.disposables))
    }
    forEach(fn: (i: T) => void): IChainableEvent<T> {
      return new ChainableEvent(forEach(this.event, fn, this.disposables))
    }
    filter<R>(fn: (i: T | R) => i is R): IChainableEvent<R>
    filter(fn: (i: T) => boolean): IChainableEvent<T>
    filter(fn: (i: T) => boolean): Event.IChainableEvent<T> {
      return new ChainableEvent(filter(this.event, fn, this.disposables))
    }

    reduce<R>(merge: (last: (R | undefined), event: T) => R, initial?: R): Event.IChainableEvent<R> {
      return new ChainableEvent(reduce(this.event, merge, initial, this.disposables))
    }

    latch(): Event.IChainableEvent<T> {
      return new ChainableEvent(latch(this.event, undefined, this.disposables))
    }


    debounce(merge: (last: T | undefined, event: T) => T, delay?: number, leading?: boolean, leakWarningThreshold?: number): IChainableEvent<T>;
    debounce<R>(merge: (last: R | undefined, event: T) => R, delay?: number, leading?: boolean, leakWarningThreshold?: number): IChainableEvent<R>;
    debounce<R>(merge: (last: (R | undefined), event: T) => R, delay?: number, leading?: boolean, leakWarningThreshold?: number): Event.IChainableEvent<R> {
      return new ChainableEvent(debounce(this.event, merge, delay, leading, leakWarningThreshold, this.disposables))
    }

    on(listener: (e: T) => any, thisArgs?: any, disposables?: IDisposable[] | DisposableStore): IDisposable {
      return this.event(listener, thisArgs, disposables)
    }
    once(listener: (e: T) => any, thisArgs?: any, disposables?: IDisposable[]): IDisposable {
      return once(this.event)(listener, thisArgs, disposables)
    }
    dispose() {
      this.disposables.dispose()
    }
  }

  export function chain<T>(event: Event<T>): IChainableEvent<T> {
    return new ChainableEvent(event)
  }

  export interface NodeEventEmitter {
    on(event: string | symbol, listener: Function): unknown
    removeListener(event: string | symbol, listener: Function): unknown
  }

  export function fromNodeEventEmitter<T>(emitter: NodeEventEmitter, eventName: string, map?: (...args: any[]) => T): Event<T> {
    const fn = (...args: any[]) => result.fire(map ? map(...args) : args[0])
    const onFirstListenerAdd = () => emitter.on(eventName, fn)
    const onLastListenerRemove = () => emitter.removeListener(eventName, fn)
    const result = new Emitter<T>({ onWillAddFirstListener: onFirstListenerAdd, onDidRemoveLastListener: onLastListenerRemove })
    return result.event
  }

  export interface DOMEventEmitter {
    addEventListener(event: string | symbol, listener: Function): void
    removeEventListener(event: string | symbol, listener: Function): void
  }

  export function fromDOMEventListener<T>(emitter: DOMEventEmitter, eventName: string, map?: (...args: any[]) => T): Event<T> {
    const fn = (...args: any[]) => result.fire(map ? map(...args) : args[0])
    const onFirstListenerAdd = () => emitter.addEventListener(eventName, fn)
    const onLastListenerRemove = () => emitter.removeEventListener(eventName, fn)
    const result = new Emitter<T>({ onWillAddFirstListener: onFirstListenerAdd, onDidRemoveLastListener: onLastListenerRemove })
    return result.event
  }

  export function toPromise<T>(event: Event<T>): Promise<T> {
    return new Promise(resolve => once(event)(resolve))
  }

  export function runAndSubscribe<T>(event: Event<T>, handler: (e: T | undefined) => any): IDisposable {
    handler(undefined)
    return event(e => handler(e))
  }

  export function runAndSubscribeWithStore<T>(event: Event<T>, handler: (e: T | undefined, store: DisposableStore) => any): IDisposable {
    let store: DisposableStore | null = null

    function run(e: T | undefined) {
      store?.dispose()
      store = new DisposableStore()
      handler(e, store)
    }

    run(undefined)
    const disposable = event(e => run(e))
    return toDisposable(() => {
      disposable.dispose()
      store?.dispose()
    })
  }

  class EmitterObserver<T> implements IObserver {
    readonly emitter: Emitter<T>;
    private _counter = 0;
    private _hasChanged = false;
    constructor(
      readonly obs: IObservable<T, any>,
      store: DisposableStore | undefined,
    ) {
      const options: EmitterOptions = {
        onWillAddFirstListener: () => obs.addObserver(this),
        onDidRemoveLastListener: () => obs.removeObserver(this),
      }

      if (!store) {
        _addLeakageTraceLogic(options)
      }
      this.emitter = new Emitter<T>(options)
      if (store) {
        store.add(this.emitter)
      }
    }

    beginUpdate<T>(observable: IObservable<T>) {
      this._counter++
    }

    handleChange<T, TChange>(observable: IObservable<T, TChange>, change: TChange) {
      this._hasChanged = true
    }

    endUpdate<T>(observable: IObservable<T>) {
      if (--this._counter === 0 && this._hasChanged) {
        this._hasChanged = false
        this.emitter.fire(this.obs.get())
      }
    }
  }

  export function fromObservable<T>(obs: IObservable<T, any>, store?: DisposableStore): Event<T> {
    return new EmitterObserver(obs, store).emitter.event
  }
}





export interface EmitterOptions {
  /**
   * Optional function that's called *before* the very first listener is added.
   */
  onWillAddFirstListener?: Function

  /**
   * Optional function that's called *after* the very first listener is added.
   */
  onDidAddFirstListener?: Function

  /**
   * Optional function that's called after a listener is added.
   */
  onDidAddListener?: Function
  /**
   * Optional function that's called *after* remove the very last listener.
   */
  onDidRemoveLastListener?: Function
  /**
   * Number of listeners that are allowed before assuming a leak. Default to a
   * global configured value.
   */
  leakWarningThreshold?: number

  deliveryQueue?: EventDeliveryQueue

  _profName?: string
}


export class EventDeliveryQueue {
  protected _queue = new LinkedList<EventDeliveryQueueElement>()

  get size() {
    return this._queue.size
  }

  push<T>(emitter: Emitter<T>, listener: Listener<T>, event: T) {
    this._queue.push(new EventDeliveryQueueElement(emitter, listener, event))
  }
  clear<T>(emitter: Emitter<T>) {
    const newQueue = new LinkedList<EventDeliveryQueueElement>()
    for (const element of this._queue) {
      if (element.emitter !== emitter) {
        newQueue.push(element)
      }
    }
    this._queue = newQueue
  }

  deliver() {
    while (this._queue.size > 0) {
      const element = this._queue.shift()!
      try {
        element.listener.invoke(element.event)
      } catch (e) {
        //
      }
    }
  }
}

class PrivateEventDeliveryQueue extends EventDeliveryQueue {
  override clear<T>(emitter: Emitter<T>) {
    this._queue.clear()
  }
}

class EventDeliveryQueueElement<T = any> {
  constructor(
    readonly emitter: Emitter<T>,
    readonly listener: Listener<T>,
    readonly event: T,
  ) { }
}

export class Emitter<T> {
  private readonly _options?: EmitterOptions;
  _leakageMon?: any
  _perfMon?: any
  _disposed = false
  _event?: Event<T>
  _deliveryQueue?: EventDeliveryQueue
  _listeners?: LinkedList<Listener<T>>
  constructor(
    options?: EmitterOptions
  ) {
    this._options = options
    this._leakageMon = _globalLeakWarningThreshold > 0 || this._options?.leakWarningThreshold ? new LeakageMonitor(_globalLeakWarningThreshold) : undefined
    this._perfMon = this._options?._profName ? new EventProfiling(this._options._profName) : undefined
    this._deliveryQueue = this._options?.deliveryQueue
  }

  dispose() {
    if (!this._disposed) {
      this._disposed = true

      if (this._listeners) {
        if (_enableDisposeWithListenerWarning) {
          const listeners = Array.from(this._listeners)
          queueMicrotask(() => {
            for (const listener of listeners) {
              listener.subscription.unset()
              listener.stack?.print()
            }
          })
        }

        this._listeners.clear()
      }

      this._deliveryQueue?.clear(this)
      this._options?.onDidRemoveLastListener?.()
      this._leakageMon?.dispose()
    }

  }

  get event() {
    if (!this._event) {
      this._event = (callback: (e: T) => any, thisArgs?: any, disposables?: IDisposable[] | DisposableStore) => {
        if (!this._listeners) {
          this._listeners = new LinkedList()
        }

        if (this._leakageMon && this._listeners.size > this._leakageMon.threshold * 3) {
          console.warn(`[${this._leakageMon.name}] REFUSES to accept new listeners because it exceeded its threshold by far`);
          return Disposable.None;
        }

        const firstListener = this._listeners.isEmpty()
        if (firstListener && this._options?.onWillAddFirstListener) {
          this._options?.onWillAddFirstListener?.()
        }

        let removeMonitor: Function | undefined
        let stack: Stacktrace | undefined
        if (this._leakageMon && this._listeners.size >= Math.ceil(this._leakageMon.threshold * .2)) {
          stack = Stacktrace.create()
          removeMonitor = this._leakageMon.check(stack, this._listeners.size + 1)
        }

        if (_enableDisposeWithListenerWarning) {
          stack = stack ?? Stacktrace.create()
        }

        const listener = new Listener(callback, thisArgs, stack)
        const removeListener = this._listeners.push(listener)

        if (firstListener && this._options?.onDidAddFirstListener) {
          this._options?.onDidAddFirstListener?.()
        }

        if (this._options?.onDidAddListener) {
          this._options?.onDidAddListener?.(this, callback, thisArgs)
        }

        const result = listener.subscription.set(() => {
          removeMonitor?.()
          if (!this._disposed) {
            removeListener()
            if (this._options && this._options.onDidRemoveLastListener) {
              const hasListeners = this._listeners && this._listeners.isEmpty()
              if (!hasListeners) {
                this._options.onDidRemoveLastListener()
              }
            }
          }
        })

        if (disposables instanceof DisposableStore) {
          disposables.add(result)
        } else if (Array.isArray(disposables)) {
          disposables.push(result)
        }

        return result
      }

    }
    return this._event
  }


  fire(event: T): void {
    if (this._listeners) {
      if (!this._deliveryQueue) {
        this._deliveryQueue = new PrivateEventDeliveryQueue()
      }

      for (const listener of this._listeners) {
        this._deliveryQueue.push(this, listener, event)
      }

      this._perfMon?.start(this._deliveryQueue.size)

      this._deliveryQueue.deliver()

      this._perfMon?.stop()
    }
  }

  hasListeners() {
    if (!this._listeners) {
      return false
    }

    return !this._listeners.isEmpty()
  }
}



export class Listener<T> {
  readonly subscription = new SafeDisposable()
  constructor(
    readonly callback: (e: T) => void,
    readonly callbackThis: any | undefined,
    readonly stack: Stacktrace | undefined,
  ) {
  }

  invoke(e: T) {
    this.callback.call(this.callbackThis, e)
  }
}
class Stacktrace {
  static create() {
    return new Stacktrace(new Error().stack ?? '')
  }
  constructor(readonly value: string) { }
  print() {
    console.warn(this.value.split('\n').slice(2).join('\n'))
  }
}


class LeakageMonitor {
  _stacks: undefined | Map<string, number>
  _warnCountdown: number = 0
  constructor(
    readonly threshold: number,
    readonly name: string = Math.random().toString(18).slice(2, 5)
  ) { }

  dispose() {
    this._stacks?.clear()
  }
  check(stack: Stacktrace, listenerCount: number) {
    const threshold = this.threshold
    if (threshold <= 0 || listenerCount < threshold) {
      return undefined
    }

    if (!this._stacks) {
      this._stacks = new Map()
    }

    const count = this._stacks.get(stack.value) || 0
    this._stacks.set(stack.value, count + 1)
    this._warnCountdown -= 1
    if (this._warnCountdown <= 0) {
      this._warnCountdown = threshold * 0.5

      let topStack: string | undefined
      let topCount = 0

      for (const [stack, count] of this._stacks) {
        if (!topStack || topCount < count) {
          topStack = stack
          topCount = count
        }
      }
      console.warn(`[${this.name}] potential listener LEAK detected, having ${listenerCount} listeners already. MOST frequent listener (${topCount}):`);
      console.warn(topStack!);
    }

    return () => {
      const count = this._stacks!.get(stack.value) || 0
      this._stacks!.set(stack.value, count - 1)
    }

  }
}

export class EventProfiling {
  static readonly all = new Set<EventProfiling>()
  static _idPool = 0
  readonly name: string
  public listenerCount = 0
  public invocationCount = 0
  public elapsedOverall = 0
  public durations: number[] = []

  public _stopWatch?: any
  constructor(name: string) {
    this.name = `${name}_${EventProfiling._idPool++}`
    EventProfiling.all.add(this)
  }

  start(listenerCount: number) {
    this.listenerCount = listenerCount
    this._stopWatch = new StopWatch(true)
  }
  stop() {
    if (this._stopWatch) {
      const elapsed = this._stopWatch.elapsed()
      this.durations.push(elapsed)
      this.elapsedOverall += elapsed
      this.invocationCount += 1
      this._stopWatch = undefined
    }

  }
}


export interface IWaitUntil {
  token: CancellationToken
  waitUntil(promise: Promise<any>): void
}

export type IWaitUntilData<T> = Omit<Omit<T, 'waitUtil'>, 'token'>

export class AsyncEmitter<T extends IWaitUntil> extends Emitter<T> {
  private _asyncDeliveryQueue?: LinkedList<[Listener<T>, IWaitUntilData<T>]>
  async fireAsync(data: IWaitUntilData<T>, token: CancellationToken, promiseJoin?: (p: Promise<unknown>, listener: Function) => Promise<unknown>) {
    if (!this._listeners) {
      return
    }
    if (!this._asyncDeliveryQueue) {
      this._asyncDeliveryQueue = new LinkedList()
    }
    for (const listener of this._listeners) {
      this._asyncDeliveryQueue.push([listener, data])
    }

    while (this._asyncDeliveryQueue.size > 0 && !token.isCancellationRequested) {
      const [listener, data] = this._asyncDeliveryQueue.shift()!
      const thenables: Promise<unknown>[] = []
      const event = <T>{
        ...data,
        token,
        waitUntil: (p: Promise<unknown>) => {
          if (Object.isFrozen(thenables)) {
            throw new Error('waitUntil can NOT be called asynchronous')
          }
          if (promiseJoin) {
            p = promiseJoin(p, listener.callback)
          }

          thenables.push(p)
        }
      }

      try {
        listener.invoke(event)
      } catch (e) {
        continue
      }

      Object.freeze(thenables)

      await Promise.allSettled(thenables).then(values => {
        for (const value of values) {
          if (value.status === 'rejected') {
            console.error(value.reason)
          }
        }
      })
    }
  }
}

export class PauseableEmitter<T> extends Emitter<T> {
  private _isPaused = 0
  protected _eventQueue = new LinkedList<T>()
  private readonly _mergeFn?: (input: T[]) => T

  constructor(options?: EmitterOptions & { merge?: (input: T[]) => T }) {
    super(options);
    this._mergeFn = options?.merge
  }
  pause() {
    this._isPaused++
  }

  resume() {
    if (this._isPaused !== 0 && --this._isPaused === 0) {
      if (this._mergeFn) {
        if (this._eventQueue.size > 0) {
          const events = Array.from(this._eventQueue)
          this._eventQueue.clear()
          super.fire(this._mergeFn(events))
        }
      } else {
        while (!this._isPaused && this._eventQueue.size !== 0) {
          super.fire(this._eventQueue.shift()!)
        }
      }
    }
  }

  override fire(event: T) {
    if (this._listeners) {
      if (this._isPaused !== 0) {
        this._eventQueue.push(event)
      } else {
        super.fire(event)
      }
    }
  }
}

export class DebounceEmitter<T> extends PauseableEmitter<T> {
  private readonly _delay: number
  _handle: any | undefined
  constructor(options: EmitterOptions & { merge: (input: T[]) => T; delay?: number }) {
    super(options);
    this._delay = options.delay ?? 100
  }
  override fire(event: T) {
    if (!this._handle) {
      this.pause()
      this._handle = setTimeout(() => {
        this._handle = undefined
        this.resume()
      }, this._delay)
    }
    super.fire(event)
  }
}

/**
 * An emitter which queue all events and then process them at the
 * end of the event loop.
 */
export class MicrotaskEmitter<T> extends Emitter<T> {
  private _queueEvents: T[] = []
  _mergeFn?: (input: T[]) => T
  override fire(event: T) {
    if (!this.hasListeners()) {
      return
    }

    this._queueEvents.push(event)
    if (this._queueEvents.length === 1) {
      queueMicrotask(() => {
        if (this._mergeFn) {
          super.fire(this._mergeFn(this._queueEvents))
        } else {
          this._queueEvents.forEach(e => super.fire(e))
        }
      })
      this._queueEvents = []
    }
  }
}

export class EventMultiplexer<T> implements IDisposable {
  private readonly emitter: Emitter<T>
  hasListeners = false
  events: { event: Event<T>; listener: IDisposable | null }[] = []

  constructor() {
    this.emitter = new Emitter<T>({
      onWillAddFirstListener: () => this.onFirstListenerAdd(),
      onDidRemoveLastListener: () => this.onLastListenerRemove()
    })

  }
  get event() {
    return this.emitter.event
  }

  add(event: Event<T>) {
    const e = { event, listener: null }
    this.events.push(e)

    if (this.hasListeners) {
      this.hook(e)
    }
    const dispose = () => {
      if (this.hasListeners) {
        this.unhook(e)
      }
      const idx = this.events.indexOf(e)
      this.events.splice(idx, 1)
    }
  }
  onFirstListenerAdd() {
    this.hasListeners = true
    this.events.forEach(e => this.hook(e))
  }

  onLastListenerRemove() {
    this.hasListeners = false
    this.events.forEach(e => this.unhook(e))
  }

  hook(e: { event: Event<T>; listener: IDisposable | null }) {
    e.listener = e.event(r => this.emitter.fire(r))
  }

  unhook(e: { event: Event<T>; listener: IDisposable | null }) {
    if (e.listener) {
      e.listener.dispose()
    }
    e.listener = null
  }

  dispose() {
    this.emitter.dispose()
  }
}
/**
 * The EventBufferer is useful in situations in which you want
 * to delay firing your events during some code.
 * You can wrap that code and be sure that the event will not
 * be fired during that wrap.
 *
 * ```
 * const emitter: Emitter;
 * const delayer = new EventDelayer();
 * const delayedEvent = delayer.wrapEvent(emitter.event);
 *
 * delayedEvent(console.log);
 *
 * delayer.bufferEvents(() => {
 *   emitter.fire(); // event will not be fired yet
 * });
 *
 * // event will only be fired at this point
 * ```
 */
export class EventBufferer {
  buffers: Function[][] = []

  wrapEvent<T>(event: Event<T>): Event<T> {
    return (listener, thisArgs?, disposables?) => {
      return event(i => {
        const buffer = this.buffers[this.buffers.length - 1]
        if (buffer) {
          buffer.push(() => listener.call(thisArgs, i))
        } else {
          listener.call(thisArgs, i)
        }
      }, undefined, disposables)
    }
  }

  bufferEvents<R = void>(fn: () => R): R {
    const buffer: Array<() => R> = []
    this.buffers.push(buffer)
    const r = fn()
    this.buffers.pop()
    buffer.forEach(flush => flush())
    return r
  }
}

/**
 * A Relay is an event forwarder which functions as a repluggable event pipe.
 * Once created, you can connect an input event to it, and it will simply forward
 * events from that input event through its own `event` property. The `input`
 * can be changed at any point in time.
 */
export class Relay<T> implements IDisposable {
  private listening = false
  private inputEvent: Event<T> = Event.None
  private inputEventListener: IDisposable = Disposable.None
  private readonly emitter = new Emitter<T>({
    onDidAddFirstListener: () => {
      this.listening = true
      this.inputEventListener = this.inputEvent(this.emitter.fire, this.emitter)
    },
    onDidRemoveLastListener: () => {
      this.listening = false
      this.inputEventListener.dispose()
    }
  })

  readonly event: Event<T> = this.emitter.event

  set input(event: Event<T>) {
    this.inputEvent = event
    if (this.listening) {
      this.inputEventListener.dispose()
      this.inputEventListener = event(this.emitter.fire, this.emitter)
    }
  }

  dispose() {
    this.inputEventListener.dispose()
    this.emitter.dispose()
  }
}
