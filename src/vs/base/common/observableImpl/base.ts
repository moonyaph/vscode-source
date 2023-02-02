


export interface IObservable<T, TChange = void> {
  readonly TChange: TChange;

  /**
   * Reads the current value.
   *
   * Must not be called from {@link IObserver.handleChange}.
   */
  get(): T;

  /**
   * Adds an observer.
   */
  addObserver(observer: IObserver): void;
  removeObserver(observer: IObserver): void;

  /**
   * Subscribes the reader to this observable and returns the current value of this observable.
   */
  read(reader: IReader): T;

  map<TNew>(fn: (value: T) => TNew): IObservable<TNew>;

  readonly debugName: string;
}

export interface IReader {
  /**
   * Reports an observable that was read.
   *
   * Is called by {@link IObservable.read}.
   */
  subscribeTo<T>(observable: IObservable<T, any>): void;
}


export interface IObserver {
  /**
   * Indicates that an update operation is about to begin.
   *
   * During an update, invariants might not hold for subscribed observables and
   * change events might be delayed.
   * However, all changes must be reported before all update operations are over.
   */
  beginUpdate<T>(observable: IObservable<T>): void;

  /**
   * Is called by a subscribed observable immediately after it notices a change.
   *
   * When {@link IObservable.get} returns and no change has been reported,
   * there has been no change for that observable.
   *
   * Implementations must not call into other observables!
   * The change should be processed when {@link IObserver.endUpdate} is called.
   */
  handleChange<T, TChange>(observable: IObservable<T, TChange>, change: TChange): void;

  /**
   * Indicates that an update operation has completed.
   */
  endUpdate<T>(observable: IObservable<T>): void;
}
