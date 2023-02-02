import { once } from "./functional"
import { Iterable } from "./iterator"


/**
 * Enables logging of potentially leaked disposables.
 *
 * A disposable is considered leaked if it is not disposed or not registered as the child of
 * another disposable. This tracking is very simple an only works for classes that either
 * extend Disposable or use a DisposableStore. This means there are a lot of false positives.
 */
const TRACk_DISPOSABLES = false
let disposableTracker: IDisposableTracker | null = null

export interface IDisposableTracker {
  /** Is called on construction of a disposable. */
  trackDisposable(disposable: IDisposable): void

  /**
   * Is called when a disposable is registered as child of another disposable (e.g. {@link DisposableStore})
   * If parent is `null`, the disposable is removed from its former parent.
   */
  setParent(child: IDisposable, parent: IDisposable | null): void

  /** Is called when a disposable is disposed. */
  markAsDisposed(disposable: IDisposable): void

  /** Indicates that the given object is a singleton which does not need to be disposed. */
  markAsSingleton(disposable: IDisposable): void
}

/**
 * An object that performs a cleanup operation when .dispose() is called.
 * Some examples of how disposables are used:
 * - An event listener that removes itself when .dispose() is called.
 * - A resource such as a file system watcher that cleans up the resource when .dispose() is called.
 * - The return value from registering a provider. When .dispose() is called, the provider is unregistered.
 */
export interface IDisposable {
  dispose(): void
}

export function setDisposableTracker(tracker: IDisposableTracker | null): void {
  disposableTracker = tracker
}
if (TRACk_DISPOSABLES) {
  const __is_disposable_tracked__ = '__is_disposable_tracked__';
  setDisposableTracker(new class implements IDisposableTracker {
    trackDisposable(x: IDisposable) {
      const stack = new Error('Potentially leaked disposable').stack!
      setTimeout(() => {
        if (!(x as any)[__is_disposable_tracked__]) {
          console.log(stack)
        }
      }, 3000)
    }
    setParent(child: IDisposable, parent: IDisposable | null) {
      if (child && child !== Disposable.None) {
        try {
          (child as any)[__is_disposable_tracked__] = true
        } catch {
          // noop
        }
      }
    }
    markAsDisposed(disposable: IDisposable) {
      if (disposable && disposable !== Disposable.None) {
        try {
          (disposable as any)[__is_disposable_tracked__] = true
        } catch {
          // noop
        }
      }
    }
    markAsSingleton(disposable: IDisposable) {

    }
  })
}

function trackDisposable<T extends IDisposable>(x: T): T {
  disposableTracker?.trackDisposable(x)
  return x
}

function markAsDisposed(disposable: IDisposable) {
  disposableTracker?.markAsDisposed(disposable)
}

function setParentOfDisposable(child: IDisposable, parent: IDisposable | null) {
  disposableTracker?.setParent(child, parent)
}

function setParentOfDisposables(children: IDisposable[], parent: IDisposable | null) {
  if (!disposableTracker) {
    return
  }
  for (const child of children) {
    disposableTracker.setParent(child, parent)
  }
}

export function markAsSingleton<T extends IDisposable>(singleton: T) {
  disposableTracker?.markAsSingleton(singleton)
  return singleton
}

export function isDisposable<E extends object>(thing: E): thing is E & IDisposable {
  return typeof (<IDisposable>thing).dispose === 'function' && (<IDisposable>thing).dispose.length === 0
}

/** Disposes of the value(s) passed in. */
export function dispose<T extends IDisposable>(disposable: T): T;
export function dispose<T extends IDisposable>(disposable: T | undefined): T | undefined;
export function dispose<T extends IDisposable, A extends Iterable<T> = Iterable<T>>(disposables: A): A;
export function dispose<T extends IDisposable>(disposables: Array<T>): Array<T>;
export function dispose<T extends IDisposable>(disposables: ReadonlyArray<T>): ReadonlyArray<T>;
export function dispose<T extends IDisposable>(arg: T | Iterable<T> | undefined): any {
  if (Iterable.is(arg)) {
    const errors: any[] = []
    for (const d of arg) {
      if (d) {
        try {
          d.dispose()
        } catch (e) {
          errors.push(e)
        }
      }
    }

    if (errors.length === 1) {
      throw errors[0]
    } else if (errors.length > 1) {
      throw new AggregateError(errors, 'Encountered errors while disposing of store')
    }

    return Array.isArray(arg) ? [] : arg
  } else if (arg) {
    arg.dispose()
    return arg
  }
}


export function disposeIfDisposable<T extends IDisposable | object>(disposables: Array<T>): Array<T> {
  for (const d of disposables) {
    if (isDisposable(d)) {
      d.dispose()
    }
  }
  return []
}

export function combinedDisposable(...disposables: IDisposable[]): IDisposable {
  const parent = toDisposable(() => dispose(disposables))
  setParentOfDisposables(disposables, parent)
  return parent
}

export function toDisposable(fn: () => void): IDisposable {
  const self = trackDisposable({
    dispose: once(() => {
      markAsSingleton(self)
      fn()
    })
  })
  return self
}

/**
 * Manage a collection of disposable values.
 *
 * This is the preffered way to manage multiple disposables. A `DisposableStore` is safer to work with than an
 * `IDisposable[]` as it considers edge class, such as registering the same value multiple times or adding an item to a
 * store that has already been disposed of.
 */
export class DisposableStore implements IDisposable {
  static DISABLE_DISPOSED_WARNING = false

  _toDispose = new Set<IDisposable>()
  _isDisposed = false
  constructor() {
    trackDisposable(this)
  }
  dispose(): void {
    if (this._isDisposed) {
      return
    }

    markAsDisposed(this)
    this._isDisposed = true
    this.clear()
  }

  clear() {
    if (this._toDispose.size === 0) {
      return
    }
    try {
      dispose(this._toDispose)
    } finally {
      this._toDispose.clear()
    }
  }
  add<T extends IDisposable>(o: T): T {
    if (!o) {
      return o
    }
    if ((o as unknown as DisposableStore) === this) {
      throw new Error('cannot register a disposable on itself')
    }
    setParentOfDisposable(o, this)
    if (this._isDisposed) {
      if (!DisposableStore.DISABLE_DISPOSED_WARNING) {
        console.warn(new Error('Trying to add a disposable to a DisposableStore that has already been disposed of. The added object will be leaked!').stack);
      }
    } else {
      this._toDispose.add(o)
    }
    return o
  }
}

/**
 * Abstract base class for a {@link IDisposable disposable} object.
 *
 * Subclasses can {@linkcode _register} disposables that will be automatically cleaned up when the object is disposed.
 */
export abstract class Disposable implements IDisposable {
  static readonly None = Object.freeze<IDisposable>({ dispose() { } })
  protected readonly _store = new DisposableStore()
  protected constructor() {
    trackDisposable(this)
    setParentOfDisposable(this._store, this)
  }
  public dispose(): void {
    markAsDisposed(this)
    this._store.dispose()
  }
  /**
   * Adds o to the collection of disposables managed by this object.
   */
  protected _register<T extends IDisposable>(o: T) {
    if ((o as unknown as Disposable) === this) {
      throw new Error('Cannot register a disposable on itself!')
    }
    return this._store.add(o)
  }
}

/**
 * Manages the lifecycle of a disposable value that may be changed.
 *
 * This ensures that when the disposable value is changed, the previously held disposable is disposed of. You can
 * also register a `MutableDisposable` on a `Disposable` to ensure it is automatically cleaned up.
 */
export class MutableDisposable<T extends IDisposable> implements IDisposable {
  _value?: T
  _isDisposed = false
  constructor() {
    trackDisposable(this)
  }
  get value(): T | undefined {
    return this._isDisposed ? undefined : this._value
  }

  set value(value: T | undefined) {
    if (this._isDisposed || value === this._value) {
      return
    }
    this._value?.dispose()
    if (value) {
      setParentOfDisposable(value, this)
    }
    this._value = value
  }
  clear() {
    this.value = undefined
  }

  dispose() {
    this._isDisposed = true
    markAsDisposed(this)
    this._value?.dispose()
    this._value = undefined
  }
  clearAndLeak(): T | undefined {
    const oldValue = this._value
    this._value = undefined
    if (oldValue) {
      setParentOfDisposable(oldValue, null)
    }
    return oldValue
  }
}

export class RefCountDisposable {
  _counter: number = 1
  constructor(readonly _disposable: IDisposable) { }

  acquire() {
    this._counter++
    return this
  }
  release() {
    if (--this._counter === 0) {
      this._disposable.dispose()
    }
    return this
  }
}

/**
 * A safe disposable can be `unset` so that a leaked reference (listener)
 * can be cut-off
 */
export class SafeDisposable implements IDisposable {
  dispose: () => void = () => { }
  unset: () => void = () => { }
  isset: () => boolean = () => false
  constructor() {
    trackDisposable(this)
  }
  set(fn: Function) {
    let callback: Function | undefined = fn
    this.unset = () => callback = undefined
    this.isset = () => callback !== undefined
    this.dispose = () => {
      if (callback) {
        callback()
        callback = undefined
        markAsDisposed(this)
      }
    }
    return this
  }
}

export interface IReference<T> extends IDisposable {
  readonly object: T
}

export abstract class ReferenceCollection<T> {
  private readonly references: Map<string, { readonly object: T, counter: number }> = new Map()
  acquire(key: string, ...args: any[]): IReference<T> {
    let reference = this.references.get(key)
    if (!reference) {
      reference = { object: this.createReferencedObject(key, ...args), counter: 0 }
      this.references.set(key, reference)
    }
    const { object } = reference
    const dispose = once(() => {
      if (--reference!.counter === 0) {
        this.references.delete(key)
        this.destroyReferencedObject(object)
      }
    })
    return { object, dispose }
  }
  abstract createReferencedObject(key: string, ...args: any[]): T
  abstract destroyReferencedObject(object: T): void
}

/**
 * Unwraps a reference collection of promised values. Makes sure
 * references are disposed whenever promises get rejected.
 */
export class AsyncReferenceCollection<T> {
  constructor(private referenceCollection: ReferenceCollection<T>) { }
  async acquire(key: string, ...args: any[]): Promise<IReference<T>> {
    const ref = this.referenceCollection.acquire(key, ...args)
    try {
      const object = await ref.object
      return {
        object,
        dispose: () => ref.dispose
      }
    } catch (error) {
      ref.dispose()
      throw error
    }
  }
}

export class ImmortalReference<T> implements IReference<T> {
  constructor(readonly object: T) { }
  dispose() { }
}

export function disposeOnReturn(fn: (store: DisposableStore) => IDisposable): void {
  const store = new DisposableStore()
  try {
    fn(store)
  } finally {
    store.dispose()
  }
}

/**
 * A map the manages the lifecycle of the values that it stores.
 */
export class DisposableMap<K, V extends IDisposable = IDisposable> implements IDisposable {
  private readonly _store = new Map<K, V>()
  private _isDisposed = false
  constructor() {
    trackDisposable(this)
  }
  /**
   * Disposes of all stored values and mark this object as disposed.
   *
   * Trying to use this object after it has been disposed of is an error.
   */
  dispose() {
    markAsDisposed(this)
    this._isDisposed = true
    this.clearAndDisposeAll()
  }

  clearAndDisposeAll() {
    if (!this._store.size) {
      return
    }
    try {
      dispose(this._store.values())
    } finally {
      this._store.clear()
    }
  }

  has(key: K) {
    return this._store.has(key)
  }

  get(key: K): V | undefined {
    return this._store.get(key)
  }

  set(key: K, value: V, skipDisposeOnOverwrite = false) {
    if (this._isDisposed) {
      console.warn(new Error('Trying to add a disposable to a DisposableStore that has already been disposed of. The added object will be leaked!'))
    }

    if (!skipDisposeOnOverwrite) {
      this._store.get(key)?.dispose()
    }

    this._store.set(key, value)
  }

  deleteAndDispose(key: K) {
    this._store.get(key)?.dispose()
    this._store.delete(key)
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this._store[Symbol.iterator]()
  }
}
